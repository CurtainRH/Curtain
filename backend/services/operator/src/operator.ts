/**
 * The Curtain operator (docs/CURTAIN_V2_SPEC.md):
 *
 * - `syncChain()`   reads vault events and moves intents along: deposit seen (matched on
 *                   depositor + hash), settlement landed, refund requested/challenged/finalized.
 *                   It challenges refunds for deposits that were already paid.
 * - `processDue()`  expires settlements that can no longer land, then groups due deposits by
 *                   (tokenIn, tokenOut), drops recipients the output token refuses, quotes the
 *                   swap, and signs one *settlement* per group (split if needed):
 *                   the swap plus every payout it funds. Nothing is swapped until a keeper
 *                   lands the whole settlement, so an unpaid deposit is always refundable in
 *                   its own token (audit H-01).
 * - `submitSettlements()` the operator's own keeper; anyone else can submit the same ones.
 *
 * Every intent state change is one database transaction together with the rows it touches.
 *
 * Safety rule: a settlement's deadline is never later than any of its intents' deadlines.
 * Refunds open 3 minutes after an intent's deadline, so a signed settlement can never land
 * after (or alongside) a refund of one of its deposits.
 */
import { randomBytes } from "node:crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Db } from "@curtain/db";
import { hashPayouts, hashSwap, SETTLEMENT_TYPES, VAULT_ABI, type PayoutStruct, type SwapStruct } from "@curtain/sdk/abi";
import type { Quote, Quoter, RouteBuilder } from "./routes";

export interface OperatorConfig {
  db: Db;
  publicClient: PublicClient;
  walletClient: WalletClient; // the operator key
  chainId: number;
  vault: Address;
  /** Default router (mock / v3); a quote can pick another, e.g. the v4 adapter. */
  router: Address;
  route: RouteBuilder;
  quote: Quoter;
  /** Keeper fee as bps of each payout's output (vault caps it at 100). */
  keeperFeeBps: number;
  /** Price tolerance between quote and settlement, in bps (default 50 = 0.5%). */
  slippageBps?: number;
  /** How long a signed settlement stays valid, in seconds (default 300). Short, so stale
   * quotes expire and get re-quoted. */
  settlementTtl?: number;
  /** Don't settle an intent closer than this to its deadline, in seconds (default 60). */
  deadlineMargin?: number;
  /** First block to index if there is no cursor yet. */
  startBlock?: bigint;
  /** Blocks re-read on every sync, in case the RPC's log index lagged its block number or a
   * short reorg happened (default 200: Robinhood Chain makes several blocks a second, so a
   * small window would be only a few seconds). Every handler is idempotent. */
  rescanBlocks?: bigint;
}

interface DueIntent {
  id: string;
  token_in: Address;
  token_out: Address;
  deposited_amount: string;
  amount_in: string;
  min_out: string;
  recipient: Address;
  deadline: string;
  deposit_id: string;
  secret: Hex;
}

export interface PendingSettlement {
  swap: { router: Address; tokenIn: Address; amountIn: string; tokenOut: Address; minOut: string; data: Hex };
  payouts: { recipient: Address; amount: string; protocolFee: string; keeperFee: string; tag: Hex }[];
  deadline: string;
  nonce: string;
  signature: Hex;
}

interface Fees {
  feeBps: bigint;
  keeperBps: bigint;
}

interface Built {
  swap: SwapStruct;
  payouts: PayoutStruct[];
  rows: { intent: DueIntent; p: PayoutStruct }[];
  deadline: bigint;
  nonce: bigint;
  signature: Hex;
}

/** Reverts that mean "the price moved", not "this batch is broken": retry with a new quote. */
const PRICE_ERRORS = new Set(["InsufficientOutput", "SwapCallFailed", "PaysMoreThanSwapped"]);
const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

const BPS = 10_000n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export class Operator {
  private readonly margin: number;
  private readonly slippage: bigint;
  private readonly ttl: number;

  constructor(private cfg: OperatorConfig) {
    this.margin = cfg.deadlineMargin ?? 60;
    this.slippage = BigInt(cfg.slippageBps ?? 50);
    this.ttl = cfg.settlementTtl ?? 300;
  }

  private get account() {
    return this.cfg.walletClient.account!;
  }

  // ---------------------------------------------------------------- chain sync

  async syncChain(): Promise<{ challenged: bigint[] }> {
    const { db, publicClient, vault } = this.cfg;
    const cur = await db.query<{ block: string }>("SELECT block FROM chain_cursor WHERE id = 1");
    const start = this.cfg.startBlock ?? 0n;
    const rescan = this.cfg.rescanBlocks ?? 200n;
    const next = cur[0] ? BigInt(cur[0].block) + 1n : start;
    const from = next - rescan > start ? next - rescan : start;
    const head = await publicClient.getBlockNumber();
    if (from > head) return { challenged: [] };

    const raw = await publicClient.getLogs({ address: vault, fromBlock: from, toBlock: head });
    const toChallenge: bigint[] = [];

    await db.transaction(async (tx) => {
      for (const l of raw) {
        let ev;
        try {
          ev = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
        } catch {
          continue; // not a vault event we track
        }
        switch (ev.eventName) {
          case "Deposited": {
            const a = ev.args;
            const rows = await tx.query<{ id: string; token_in: string }>(
              "SELECT id, token_in FROM intents WHERE deadline_hash = $1 AND depositor = $2 AND status = 'awaiting_deposit' FOR UPDATE",
              [a.deadlineHash, getAddress(a.depositor)],
            );
            const intent = rows[0];
            if (!intent) break; // no matching intent: only its depositor can refund it
            const tokenOk = getAddress(a.token) === getAddress(intent.token_in);
            await tx.query(
              "UPDATE intents SET status = $2, deposit_id = $3, deposited_amount = $4, updated_at = now() WHERE id = $1",
              [intent.id, tokenOk ? "deposited" : "expired", a.depositId.toString(), a.amount.toString()],
            );
            break;
          }
          case "Settled": {
            const s = await tx.query<{ id: string }>(
              "UPDATE settlements SET status = 'confirmed', tx_hash = $2, keeper = $3 WHERE nonce = $1 RETURNING id",
              [ev.args.nonce.toString(), l.transactionHash, ev.args.keeper],
            );
            if (s[0]) {
              await tx.query(
                `UPDATE intents SET status = 'paid', updated_at = now()
                 WHERE id IN (SELECT intent_id FROM payouts WHERE settlement_id = $1) AND status IN ('settling', 'deposited')`,
                [s[0].id],
              );
            }
            break;
          }
          case "RefundRequested": {
            const depositId = ev.args.depositId;
            const rows = await tx.query<{ id: string; status: string }>("SELECT id, status FROM intents WHERE deposit_id = $1 FOR UPDATE", [depositId.toString()]);
            const intent = rows[0];
            if (!intent) break;
            if (intent.status === "paid" || intent.status === "challenged") {
              if (!toChallenge.includes(depositId)) toChallenge.push(depositId);
            } else if (intent.status !== "refund_requested" && intent.status !== "refunded") {
              // Any settlement holding it has already expired (deadlines end at the intent's).
              await tx.query("UPDATE intents SET status = 'refund_requested', updated_at = now() WHERE id = $1", [intent.id]);
            }
            break;
          }
          case "RefundChallenged":
            await tx.query("UPDATE intents SET status = 'challenged', updated_at = now() WHERE deposit_id = $1", [ev.args.depositId.toString()]);
            break;
          case "Refunded":
            await tx.query("UPDATE intents SET status = 'refunded', updated_at = now() WHERE deposit_id = $1", [ev.args.depositId.toString()]);
            break;
        }
      }
      await tx.query("INSERT INTO chain_cursor (id, block) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET block = EXCLUDED.block", [head.toString()]);
    });

    // Re-read events may point at refunds already challenged or finalized: only challenge
    // what is still open on-chain.
    const challenged: bigint[] = [];
    for (const depositId of toChallenge) {
      const dep = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "deposits", args: [depositId] });
      if (dep[5] !== 2) continue; // Status.RefundRequested
      try {
        await this.challenge(depositId);
        challenged.push(depositId);
      } catch (e) {
        console.error(`challenge for deposit ${depositId} failed:`, e);
      }
    }
    return { challenged };
  }

  /** Blocks a refund for an already-paid deposit by revealing its payout secret. */
  async challenge(depositId: bigint): Promise<Hex> {
    const rows = await this.cfg.db.query<{ secret: Hex }>("SELECT secret FROM intents WHERE deposit_id = $1", [depositId.toString()]);
    if (!rows[0]) throw new Error(`no intent for deposit ${depositId}`);
    return this.send("challengeRefund", [depositId, rows[0].secret]);
  }

  // ---------------------------------------------------------------- settlements

  /** Expires settlements that can no longer land and returns their intents to the queue. */
  async expireSettlements(nowSec: number): Promise<number> {
    const { db, publicClient, vault } = this.cfg;
    const stale = await db.query<{ id: string; nonce: string }>(
      "SELECT id, nonce::text FROM settlements WHERE status = 'signed' AND deadline < $1",
      [nowSec],
    );
    let expired = 0;
    for (const s of stale) {
      // It may have landed in a block we haven't indexed yet: only expire if the nonce is unused.
      if (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "nonceUsed", args: [BigInt(s.nonce)] })) continue;
      await db.transaction(async (tx) => {
        await tx.query("UPDATE settlements SET status = 'expired' WHERE id = $1 AND status = 'signed'", [s.id]);
        await tx.query("UPDATE intents SET status = 'deposited', settlement_id = NULL, updated_at = now() WHERE settlement_id = $1 AND status = 'settling'", [s.id]);
      });
      expired++;
    }
    return expired;
  }

  /**
   * Signs settlements for every due group of deposits. Returns the new settlement ids.
   *
   * Recipients a token refuses (blocklists, compliance hooks) are kept out of settlements, so
   * one bad recipient can't stall a whole batch on every retry:
   * 1. probe: a zero-amount transfer from the vault to each recipient is simulated; tokens with
   *    blocklists reject those too. A control transfer runs first so tokens that reject all
   *    zero transfers don't flag everyone.
   * 2. simulate: every settlement is simulated before it's stored. If it would revert for a
   *    reason other than price, the group is split in half until the failing payout is found.
   * Blocked deposits are marked `blocked`; their owners refund through the escape hatch.
   */
  async processDue(nowSec: number): Promise<number[]> {
    await this.expireSettlements(nowSec);
    const { db } = this.cfg;
    const fees = { feeBps: BigInt(await this.feeBps()), keeperBps: BigInt(this.cfg.keeperFeeBps) };
    const created: number[] = [];

    await db.transaction(async (tx) => {
      const due = await tx.query<DueIntent>(
        `SELECT id, token_in, token_out, deposited_amount::text, amount_in::text, min_out::text, recipient, deadline::text,
                deposit_id::text, secret
         FROM intents WHERE status = 'deposited' AND pay_at <= $1 AND deadline > $2
         ORDER BY pay_at FOR UPDATE SKIP LOCKED`,
        [nowSec, nowSec + this.margin],
      );
      const groups = new Map<string, DueIntent[]>();
      for (const i of due) {
        const k = `${i.token_in}:${i.token_out}`;
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
      for (const group of groups.values()) {
        const reachable = await this.dropUnreachableRecipients(tx, group);
        created.push(...(await this.settleGroup(tx, reachable, nowSec, fees)));
      }
    });
    return created;
  }

  /** Probes each recipient with a simulated zero-amount transfer from the vault. */
  private async dropUnreachableRecipients(tx: Db, intents: DueIntent[]): Promise<DueIntent[]> {
    if (intents.length === 0) return intents;
    const token = getAddress(intents[0]!.token_out);
    const probe = async (to: Address) => {
      try {
        await this.cfg.publicClient.call({
          account: this.cfg.vault, to: token,
          data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, 0n] }),
        });
        return true;
      } catch {
        return false;
      }
    };
    if (!(await probe(this.account.address))) return intents; // token rejects all zero transfers: probe tells us nothing

    const kept: DueIntent[] = [];
    for (const i of intents) {
      if (await probe(getAddress(i.recipient))) kept.push(i);
      else await this.markBlocked(tx, i, "output token refuses transfers to this recipient");
    }
    return kept;
  }

  /**
   * Builds, simulates and stores a settlement for `intents`. If the simulation reverts for a
   * non-price reason, splits the group in half and retries each half, until single deposits
   * that still fail are marked blocked.
   */
  private async settleGroup(tx: Db, intents: DueIntent[], nowSec: number, fees: Fees): Promise<number[]> {
    const built = await this.build(intents, nowSec, fees);
    if (!built) return [];
    const outcome = await this.simulate(built);
    if (outcome === "ok") return [await this.store(tx, built)];
    if (outcome === "price") return []; // price moved: retry next tick with a fresh quote
    if (built.rows.length === 1) {
      await this.markBlocked(tx, built.rows[0]!.intent, `settlement reverts: ${outcome.reason}`);
      return [];
    }
    const kept = built.rows.map((r) => r.intent);
    const mid = Math.ceil(kept.length / 2);
    return [
      ...(await this.settleGroup(tx, kept.slice(0, mid), nowSec, fees)),
      ...(await this.settleGroup(tx, kept.slice(mid), nowSec, fees)),
    ];
  }

  /** Quotes and signs a settlement, dropping intents the current price can't satisfy. */
  private async build(group: DueIntent[], nowSec: number, { feeBps, keeperBps }: Fees): Promise<Built | null> {
    let intents = group;
    if (intents.length === 0) return null;
    const tokenIn = getAddress(intents[0]!.token_in);
    const tokenOut = getAddress(intents[0]!.token_out);

    // Drop intents whose own minimum the current price can't meet; they wait for a better
    // price (or refund at their deadline). Repeat until the remaining set is consistent.
    let minOut = 0n;
    let totalIn = 0n;
    let picked: Quote = { amountOut: 0n };
    for (;;) {
      totalIn = intents.reduce((s, i) => s + BigInt(i.deposited_amount), 0n);
      if (totalIn === 0n) return null;
      picked = tokenIn === tokenOut ? { amountOut: totalIn } : await this.cfg.quote(tokenIn, tokenOut, totalIn);
      minOut = tokenIn === tokenOut ? totalIn : (picked.amountOut * (BPS - this.slippage)) / BPS;
      const ok = intents.filter((i) => this.netFor(i, minOut, totalIn, feeBps, keeperBps) >= this.minNet(i));
      if (ok.length === intents.length) break;
      intents = ok;
    }
    if (intents.length === 0 || minOut === 0n) return null;

    const payouts: PayoutStruct[] = [];
    const rows: Built["rows"] = [];
    let paid = 0n;
    for (const i of intents) {
      const gross = (minOut * BigInt(i.deposited_amount)) / totalIn;
      const protocolFee = (gross * feeBps) / BPS;
      const keeperFee = (gross * keeperBps) / BPS;
      const p: PayoutStruct = {
        recipient: getAddress(i.recipient), amount: gross - protocolFee - keeperFee, protocolFee, keeperFee,
        tag: keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(i.deposit_id), i.secret])),
      };
      payouts.push(p);
      rows.push({ intent: i, p });
      paid += gross;
    }
    const swap: SwapStruct = tokenIn === tokenOut
      ? { router: ZERO, tokenIn, amountIn: totalIn, tokenOut, minOut: 0n, data: "0x" }
      : { router: picked.router ?? this.cfg.router, tokenIn, amountIn: totalIn, tokenOut, minOut: paid,
          data: this.cfg.route({ vault: this.cfg.vault, tokenIn, tokenOut, amountIn: totalIn, minOut: paid, fee: picked.fee, v4: picked.v4 }) };
    const earliest = Math.min(...intents.map((i) => Number(i.deadline)));
    const deadline = BigInt(Math.min(earliest, nowSec + this.ttl));
    const nonce = BigInt(`0x${randomBytes(16).toString("hex")}`);
    const signature = await this.cfg.walletClient.signTypedData({
      account: this.account,
      domain: { name: "CurtainVault", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.vault },
      types: SETTLEMENT_TYPES,
      primaryType: "Settlement",
      message: { swapHash: hashSwap(swap), payoutsHash: hashPayouts(payouts), deadline, nonce },
    });
    return { swap, payouts, rows, deadline, nonce, signature };
  }

  /** "ok", "price" (swap output/minimum problem: retry later), or another revert reason. */
  private async simulate(b: Built): Promise<"ok" | "price" | { reason: string }> {
    try {
      await this.cfg.publicClient.simulateContract({
        account: this.account.address, address: this.cfg.vault, abi: VAULT_ABI, functionName: "settle",
        args: [b.swap, b.payouts, b.deadline, b.nonce, b.signature],
      });
      return "ok";
    } catch (e) {
      const name = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)?.data?.errorName : undefined;
      if (name && PRICE_ERRORS.has(name)) return "price";
      const reason = name ?? (e instanceof BaseError ? e.shortMessage : String(e));
      return { reason: reason.slice(0, 200) };
    }
  }

  private async store(tx: Db, b: Built): Promise<number> {
    const [s] = await tx.query<{ id: string }>(
      `INSERT INTO settlements (nonce, token_in, token_out, amount_in, min_out, router, swap_data, deadline, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [b.nonce.toString(), b.swap.tokenIn, b.swap.tokenOut, b.swap.amountIn.toString(), b.swap.minOut.toString(), b.swap.router,
        b.swap.data, b.deadline.toString(), b.signature],
    );
    for (const [position, { intent, p }] of b.rows.entries()) {
      await tx.query(
        `INSERT INTO payouts (settlement_id, position, intent_id, recipient, amount, protocol_fee, keeper_fee, tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s!.id, position, intent.id, p.recipient, p.amount.toString(), p.protocolFee.toString(), p.keeperFee.toString(), p.tag],
      );
      await tx.query("UPDATE intents SET status = 'settling', settlement_id = $2, amount_out = $3, updated_at = now() WHERE id = $1", [
        intent.id, s!.id, (p.amount + p.protocolFee + p.keeperFee).toString(),
      ]);
    }
    return Number(s!.id);
  }

  private async markBlocked(tx: Db, i: DueIntent, reason: string): Promise<void> {
    await tx.query("UPDATE intents SET status = 'blocked', blocked_reason = $2, updated_at = now() WHERE id = $1 AND status = 'deposited'", [i.id, reason]);
  }

  /** What the recipient would receive from `minOut` split pro rata, after fees. */
  private netFor(i: DueIntent, minOut: bigint, totalIn: bigint, feeBps: bigint, keeperBps: bigint): bigint {
    const gross = (minOut * BigInt(i.deposited_amount)) / totalIn;
    return gross - (gross * feeBps) / BPS - (gross * keeperBps) / BPS;
  }

  /** The intent's minimum, scaled if a different amount was deposited than requested. */
  private minNet(i: DueIntent): bigint {
    return (BigInt(i.min_out) * BigInt(i.deposited_amount)) / BigInt(i.amount_in);
  }

  /** Signed settlements that can still land — what any keeper may submit. */
  async pendingSettlements(nowSec: number): Promise<PendingSettlement[]> {
    const { db } = this.cfg;
    const settlements = await db.query<{ id: string; nonce: string; router: Address; token_in: Address; amount_in: string; token_out: Address; min_out: string; swap_data: Hex; deadline: string; signature: Hex }>(
      `SELECT id, nonce::text, router, token_in, amount_in::text, token_out, min_out::text, swap_data, deadline::text, signature
       FROM settlements WHERE status = 'signed' AND deadline >= $1 ORDER BY id`,
      [nowSec],
    );
    const out: PendingSettlement[] = [];
    for (const s of settlements) {
      const payouts = await db.query<{ recipient: Address; amount: string; protocol_fee: string; keeper_fee: string; tag: Hex }>(
        "SELECT recipient, amount::text, protocol_fee::text, keeper_fee::text, tag FROM payouts WHERE settlement_id = $1 ORDER BY position",
        [s.id],
      );
      out.push({
        swap: { router: s.router, tokenIn: s.token_in, amountIn: s.amount_in, tokenOut: s.token_out, minOut: s.min_out, data: s.swap_data },
        payouts: payouts.map((p) => ({ recipient: p.recipient, amount: p.amount, protocolFee: p.protocol_fee, keeperFee: p.keeper_fee, tag: p.tag })),
        deadline: s.deadline,
        nonce: s.nonce,
        signature: s.signature,
      });
    }
    return out;
  }

  /** The operator's own keeper: submits every pending settlement nobody else has landed yet. */
  async submitSettlements(nowSec: number): Promise<Hex[]> {
    const sent: Hex[] = [];
    for (const s of await this.pendingSettlements(nowSec)) {
      const nonceUsed = await this.cfg.publicClient.readContract({ address: this.cfg.vault, abi: VAULT_ABI, functionName: "nonceUsed", args: [BigInt(s.nonce)] });
      if (nonceUsed) continue; // another keeper landed it; syncChain() will record it
      try {
        sent.push(await this.send("settle", settleArgs(s)));
      } catch (e) {
        console.error(`settlement ${s.nonce} failed:`, e instanceof Error ? e.message.split("\n")[0] : e);
      }
    }
    return sent;
  }

  // ---------------------------------------------------------------- monitoring

  private lastTickAt = 0;

  /** Call after each completed operator tick (main loop). */
  markTick(): void {
    this.lastTickAt = Date.now();
  }

  /**
   * What an uptime monitor should watch. `ok` is false when users could be hurt or soon will be:
   * - the loop stopped ticking (deposits won't be settled)
   * - the operator can't afford gas for challenges and its own keeper
   * - a deposit is close to its deadline without a landed settlement (its owner will refund)
   * - the chain watcher is far behind the head
   */
  async status(nowSec: number, opts: { minBalanceWei?: bigint; maxTickAgeMs?: number; maxLagBlocks?: bigint } = {}) {
    const { db, publicClient } = this.cfg;
    const minBalance = opts.minBalanceWei ?? 5_000_000_000_000_000n; // 0.005 ETH
    const maxTickAge = opts.maxTickAgeMs ?? 60_000;
    const maxLag = opts.maxLagBlocks ?? 200n;

    const [balance, head, cur, atRisk, pending] = await Promise.all([
      publicClient.getBalance({ address: this.account.address }),
      publicClient.getBlockNumber(),
      db.query<{ block: string }>("SELECT block FROM chain_cursor WHERE id = 1"),
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM intents WHERE status IN ('deposited', 'settling') AND deadline - $1 < 180",
        [nowSec],
      ),
      db.query<{ n: string }>("SELECT count(*)::text AS n FROM settlements WHERE status = 'signed'"),
    ]);
    const lagBlocks = cur[0] ? head - BigInt(cur[0].block) : head;
    const tickAgeMs = this.lastTickAt ? Date.now() - this.lastTickAt : null;
    const problems: string[] = [];
    if (tickAgeMs === null || tickAgeMs > maxTickAge) problems.push("operator loop is not ticking");
    if (balance < minBalance) problems.push("operator gas balance is low");
    if (Number(atRisk[0]!.n) > 0) problems.push(`${atRisk[0]!.n} deposit(s) within 3 minutes of their deadline without a landed settlement`);
    if (lagBlocks > maxLag) problems.push(`chain watcher is ${lagBlocks} blocks behind`);
    return {
      ok: problems.length === 0,
      problems,
      operator: this.account.address,
      operatorBalanceWei: balance.toString(),
      lagBlocks: lagBlocks.toString(),
      lastTickAgeMs: tickAgeMs,
      pendingSettlements: Number(pending[0]!.n),
    };
  }

  // ---------------------------------------------------------------- helpers

  private feeCache?: { at: number; bps: number };
  private async feeBps(): Promise<number> {
    if (this.feeCache && Date.now() - this.feeCache.at < 60_000) return this.feeCache.bps;
    const bps = await this.cfg.publicClient.readContract({ address: this.cfg.vault, abi: VAULT_ABI, functionName: "feeBps" });
    this.feeCache = { at: Date.now(), bps };
    return bps;
  }

  private async send(functionName: "challengeRefund" | "settle", args: readonly unknown[]): Promise<Hex> {
    const hash = await this.cfg.walletClient.writeContract({
      chain: this.cfg.walletClient.chain, account: this.account, address: this.cfg.vault, abi: VAULT_ABI,
      functionName, args: args as never,
    });
    const r = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }
}

/** CurtainVault.settle() arguments from a pending settlement (JSON-safe strings -> bigints). */
export function settleArgs(s: PendingSettlement) {
  return [
    { ...s.swap, amountIn: BigInt(s.swap.amountIn), minOut: BigInt(s.swap.minOut) },
    s.payouts.map((p) => ({ recipient: p.recipient, amount: BigInt(p.amount), protocolFee: BigInt(p.protocolFee), keeperFee: BigInt(p.keeperFee), tag: p.tag })),
    BigInt(s.deadline),
    BigInt(s.nonce),
    s.signature,
  ] as const;
}
