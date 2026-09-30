/**
 * The Curtain operator (docs/CURTAIN_V2_SPEC.md):
 *
 * - `syncChain()`   reads vault events and moves intents along: deposit seen, payout
 *                   confirmed, refund requested/challenged/finalized. It challenges refunds
 *                   for deposits that were already paid.
 * - `processDue()`  takes deposits whose payout time has come, groups them by (tokenIn,
 *                   tokenOut), swaps each group inside the vault, splits the output pro rata
 *                   and signs one payout per deposit.
 * - `submitPayouts()` the operator's own keeper; anyone else can submit the same payouts.
 * - `reconcile()`   on start-up, resumes batches interrupted mid-swap.
 *
 * Every intent state change is one database transaction together with the rows it touches.
 *
 * Safety rule: a payout signature never outlives its intent's deadline. Refunds open 3
 * minutes after that deadline, so a signed-but-unsubmitted payout can never be paid after
 * (or alongside) a refund.
 */
import { randomBytes } from "node:crypto";
import {
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { Db } from "@curtain/db";
import { PAYOUT_TYPES, VAULT_ABI } from "./abi";
import type { RouteBuilder } from "./routes";

export interface OperatorConfig {
  db: Db;
  publicClient: PublicClient;
  walletClient: WalletClient; // the operator key
  chainId: number;
  vault: Address;
  router: Address;
  route: RouteBuilder;
  /** Keeper fee as bps of each payout's output. */
  keeperFeeBps: number;
  /** Don't start a swap for an intent closer than this to its deadline (seconds). */
  deadlineMargin?: number;
  /** First block to index if there is no cursor yet. */
  startBlock?: bigint;
  /** Blocks re-read on every sync, in case the RPC's log index lagged its block number or a
   * short reorg happened (default 10). Every handler is idempotent, so re-reading is safe. */
  rescanBlocks?: bigint;
}

interface DueIntent {
  id: string;
  token_in: Address;
  token_out: Address;
  deposited_amount: string;
  amount_in: string;
  min_out: string;
}

type VaultLog = ReturnType<typeof decodeEventLog<typeof VAULT_ABI>> & { blockNumber: bigint; transactionHash: Hex };

const BPS = 10_000n;
const WAD = 10n ** 18n;

export class Operator {
  private readonly margin: number;

  constructor(private cfg: OperatorConfig) {
    this.margin = cfg.deadlineMargin ?? 60;
  }

  private get account() {
    return this.cfg.walletClient.account!;
  }

  // ---------------------------------------------------------------- chain sync

  async syncChain(): Promise<{ challenged: bigint[] }> {
    const { db, publicClient, vault } = this.cfg;
    const cur = await db.query<{ block: string }>("SELECT block FROM chain_cursor WHERE id = 1");
    const start = this.cfg.startBlock ?? 0n;
    const rescan = this.cfg.rescanBlocks ?? 10n;
    const next = cur[0] ? BigInt(cur[0].block) + 1n : start;
    const from = next - rescan > start ? next - rescan : start;
    const head = await publicClient.getBlockNumber();
    if (from > head) return { challenged: [] };

    const raw = await publicClient.getLogs({ address: vault, fromBlock: from, toBlock: head });
    const logs: VaultLog[] = [];
    for (const l of raw) {
      try {
        logs.push({ ...decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics }), blockNumber: l.blockNumber!, transactionHash: l.transactionHash! });
      } catch {
        // not a vault event we track
      }
    }

    const toChallenge: bigint[] = [];
    await db.transaction(async (tx) => {
      for (const log of logs) {
        const a = log.args as Record<string, unknown>;
        switch (log.eventName) {
          case "Deposited": {
            const rows = await tx.query<{ id: string; token_in: string }>(
              "SELECT id, token_in FROM intents WHERE deadline_hash = $1 AND status = 'awaiting_deposit' FOR UPDATE",
              [a["deadlineHash"]],
            );
            const intent = rows[0];
            if (!intent) break; // a deposit without an intent: only its depositor can refund it
            const tokenOk = getAddress(a["token"] as string) === getAddress(intent.token_in);
            await tx.query(
              `UPDATE intents SET status = $2, deposit_id = $3, depositor = $4, deposited_amount = $5, updated_at = now() WHERE id = $1`,
              [intent.id, tokenOk ? "deposited" : "expired", (a["depositId"] as bigint).toString(), a["depositor"], (a["amount"] as bigint).toString()],
            );
            break;
          }
          case "PaidOut": {
            const p = await tx.query<{ intent_id: string }>(
              "UPDATE payouts SET status = 'confirmed', tx_hash = $2, keeper = $3 WHERE tag = $1 RETURNING intent_id",
              [a["tag"], log.transactionHash, a["keeper"]],
            );
            if (p[0]) {
              await tx.query(
                "UPDATE intents SET status = 'paid', updated_at = now() WHERE id = $1 AND status IN ('swapping', 'payout_signed')",
                [p[0].intent_id],
              );
            }
            break;
          }
          case "RefundRequested": {
            const depositId = a["depositId"] as bigint;
            const rows = await tx.query<{ id: string; status: string }>("SELECT id, status FROM intents WHERE deposit_id = $1 FOR UPDATE", [depositId.toString()]);
            const intent = rows[0];
            if (!intent) break;
            if (intent.status === "paid" || intent.status === "challenged") {
              if (!toChallenge.includes(depositId)) toChallenge.push(depositId);
            } else if (intent.status !== "refund_requested" && intent.status !== "refunded") {
              await tx.query("UPDATE intents SET status = 'refund_requested', updated_at = now() WHERE id = $1", [intent.id]);
              // Any signed payout has already expired (signatures end at the intent deadline).
              await tx.query("UPDATE payouts SET status = 'expired' WHERE intent_id = $1 AND status = 'signed'", [intent.id]);
            }
            break;
          }
          case "RefundChallenged":
            await tx.query("UPDATE intents SET status = 'challenged', updated_at = now() WHERE deposit_id = $1", [(a["depositId"] as bigint).toString()]);
            break;
          case "Refunded":
            await tx.query("UPDATE intents SET status = 'refunded', updated_at = now() WHERE deposit_id = $1", [(a["depositId"] as bigint).toString()]);
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

  // ---------------------------------------------------------------- swaps + payouts

  async processDue(nowSec: number): Promise<number[]> {
    const { db } = this.cfg;
    const batchIds: number[] = [];

    // 1. Claim due intents into batches (one transaction).
    await db.transaction(async (tx) => {
      const due = await tx.query<DueIntent>(
        `SELECT id, token_in, token_out, deposited_amount::text, amount_in::text, min_out::text FROM intents
         WHERE status = 'deposited' AND pay_at <= $1 AND deadline > $2
         ORDER BY pay_at FOR UPDATE SKIP LOCKED`,
        [nowSec, nowSec + this.margin],
      );
      const groups = new Map<string, DueIntent[]>();
      for (const i of due) {
        const k = `${i.token_in}:${i.token_out}`;
        groups.set(k, [...(groups.get(k) ?? []), i]);
      }
      for (const intents of groups.values()) {
        const totalIn = intents.reduce((s, i) => s + BigInt(i.deposited_amount), 0n);
        const minOut = await this.batchMinOut(intents, totalIn);
        const b = await tx.query<{ id: number }>(
          "INSERT INTO batches (token_in, token_out, amount_in, min_out) VALUES ($1, $2, $3, $4) RETURNING id",
          [intents[0]!.token_in, intents[0]!.token_out, totalIn.toString(), minOut.toString()],
        );
        const batchId = Number(b[0]!.id);
        await tx.query(
          `UPDATE intents SET status = 'swapping', batch_id = $1, updated_at = now() WHERE id = ANY($2::text[])`,
          [batchId, intents.map((i) => i.id)],
        );
        batchIds.push(batchId);
      }
    });

    // 2. Swap and pay each batch.
    for (const id of batchIds) await this.runBatch(id);
    return batchIds;
  }

  /**
   * The batch's on-chain minimum output: the strictest per-intent price, applied to the whole
   * batch, so a pro-rata split meets every intent's own minimum (after fees).
   */
  private async batchMinOut(intents: DueIntent[], totalIn: bigint): Promise<bigint> {
    const feeBps = BigInt(await this.feeBps());
    const net = BPS - feeBps - BigInt(this.cfg.keeperFeeBps);
    let ratio = 0n; // gross output per unit input, WAD-scaled
    for (const i of intents) {
      const dep = BigInt(i.deposited_amount);
      const minNet = (BigInt(i.min_out) * dep) / BigInt(i.amount_in); // scale if a different amount was deposited
      const minGross = (minNet * BPS + net - 1n) / net;
      const r = (minGross * WAD + dep - 1n) / dep;
      if (r > ratio) ratio = r;
    }
    return (totalIn * ratio + WAD - 1n) / WAD;
  }

  private async runBatch(batchId: number): Promise<void> {
    const { db } = this.cfg;
    const [batch] = await db.query<{ token_in: Address; token_out: Address; amount_in: string; min_out: string; tx_hash: Hex | null }>(
      "SELECT token_in, token_out, amount_in::text, min_out::text, tx_hash FROM batches WHERE id = $1",
      [batchId],
    );
    if (!batch) return;
    const amountIn = BigInt(batch.amount_in);

    let amountOut: bigint;
    if (getAddress(batch.token_in) === getAddress(batch.token_out)) {
      amountOut = amountIn; // same-token private transfer: nothing to swap
    } else {
      try {
        let hash = batch.tx_hash;
        if (!hash) {
          const data = this.cfg.route({ vault: this.cfg.vault, tokenIn: batch.token_in, tokenOut: batch.token_out, amountIn, minOut: BigInt(batch.min_out) });
          hash = await this.cfg.walletClient.writeContract({
            chain: this.cfg.walletClient.chain, account: this.account, address: this.cfg.vault, abi: VAULT_ABI,
            functionName: "executeSwap", args: [this.cfg.router, batch.token_in, amountIn, batch.token_out, BigInt(batch.min_out), data],
          });
          await db.query("UPDATE batches SET tx_hash = $2 WHERE id = $1", [batchId, hash]);
        }
        amountOut = await this.swapOutput(hash);
      } catch (e) {
        // Price moved past the batch minimum (or the swap failed): put the intents back and
        // retry next tick. If they run out of time, their depositors refund.
        await db.transaction(async (tx) => {
          await tx.query("UPDATE batches SET status = 'failed', error = $2 WHERE id = $1", [batchId, String(e).slice(0, 500)]);
          await tx.query("UPDATE intents SET status = 'deposited', batch_id = NULL, updated_at = now() WHERE batch_id = $1 AND status = 'swapping'", [batchId]);
        });
        return;
      }
    }
    await this.allocateAndSign(batchId, amountIn, amountOut);
  }

  private async swapOutput(hash: Hex): Promise<bigint> {
    const receipt = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`executeSwap reverted: ${hash}`);
    for (const l of receipt.logs) {
      if (getAddress(l.address) !== getAddress(this.cfg.vault)) continue;
      try {
        const ev = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
        if (ev.eventName === "Swapped") return ev.args.amountOut;
      } catch {
        // other event
      }
    }
    throw new Error(`no Swapped event in ${hash}`);
  }

  /** Splits `amountOut` pro rata and signs one payout per intent — one transaction. */
  private async allocateAndSign(batchId: number, amountIn: bigint, amountOut: bigint): Promise<void> {
    const feeBps = BigInt(await this.feeBps());
    const keeperBps = BigInt(this.cfg.keeperFeeBps);
    const domain = { name: "CurtainVault", version: "1", chainId: this.cfg.chainId, verifyingContract: this.cfg.vault } as const;

    await this.cfg.db.transaction(async (tx) => {
      const intents = await tx.query<{ id: string; deposited_amount: string; token_out: Address; recipient: Address; deadline: string; deposit_id: string; secret: Hex }>(
        `SELECT id, deposited_amount::text, token_out, recipient, deadline::text, deposit_id::text, secret FROM intents
         WHERE batch_id = $1 AND status = 'swapping' FOR UPDATE`,
        [batchId],
      );
      for (const i of intents) {
        const out = (amountOut * BigInt(i.deposited_amount)) / amountIn;
        const protocolFee = (out * feeBps) / BPS;
        const keeperFee = (out * keeperBps) / BPS;
        const payout = {
          recipient: i.recipient,
          token: i.token_out,
          amount: out - protocolFee - keeperFee,
          protocolFee,
          keeperFee,
          deadline: BigInt(i.deadline), // never later than the intent's deadline
          nonce: BigInt(`0x${randomBytes(16).toString("hex")}`),
          tag: keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(i.deposit_id), i.secret])),
        };
        const signature = await this.cfg.walletClient.signTypedData({
          account: this.account, domain, types: PAYOUT_TYPES, primaryType: "Payout", message: payout,
        });
        await tx.query(
          `INSERT INTO payouts (intent_id, nonce, recipient, token, amount, protocol_fee, keeper_fee, deadline, tag, signature)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [i.id, payout.nonce.toString(), payout.recipient, payout.token, payout.amount.toString(), protocolFee.toString(),
            keeperFee.toString(), payout.deadline.toString(), payout.tag, signature],
        );
        await tx.query("UPDATE intents SET status = 'payout_signed', amount_out = $2, updated_at = now() WHERE id = $1", [i.id, out.toString()]);
      }
      await tx.query("UPDATE batches SET status = 'done', amount_out = $2 WHERE id = $1", [batchId, amountOut.toString()]);
    });
  }

  /** Crash recovery: resume batches interrupted mid-way (sends the swap if it never went out,
   * otherwise reads its receipt), then allocates and signs as usual. */
  async reconcile(): Promise<void> {
    const pending = await this.cfg.db.query<{ id: number }>("SELECT id FROM batches WHERE status = 'pending'");
    for (const b of pending) await this.runBatch(Number(b.id));
  }

  // ---------------------------------------------------------------- keeper

  /** Signed, unexpired payouts — what any keeper may submit. */
  async pendingPayouts(nowSec: number) {
    return this.cfg.db.query<PendingPayout>(
      `SELECT recipient, token, amount::text, protocol_fee::text AS "protocolFee", keeper_fee::text AS "keeperFee",
              deadline::text, nonce::text, tag, signature
       FROM payouts WHERE status = 'signed' AND deadline > $1 ORDER BY id`,
      [nowSec],
    );
  }

  /** The operator's own keeper: submits every pending payout nobody else has submitted yet. */
  async submitPayouts(nowSec: number): Promise<Hex[]> {
    const sent: Hex[] = [];
    for (const p of await this.pendingPayouts(nowSec)) {
      const used = await this.cfg.publicClient.readContract({ address: this.cfg.vault, abi: VAULT_ABI, functionName: "tagUsed", args: [p.tag] });
      if (used) continue; // another keeper got there first; syncChain() will record it
      try {
        sent.push(await this.send("payout", [toPayout(p), p.signature]));
      } catch (e) {
        console.error(`payout ${p.tag} failed:`, e);
      }
    }
    return sent;
  }

  // ---------------------------------------------------------------- helpers

  private feeCache?: { at: number; bps: number };
  private async feeBps(): Promise<number> {
    if (this.feeCache && Date.now() - this.feeCache.at < 60_000) return this.feeCache.bps;
    const bps = await this.cfg.publicClient.readContract({ address: this.cfg.vault, abi: VAULT_ABI, functionName: "feeBps" });
    this.feeCache = { at: Date.now(), bps };
    return bps;
  }

  private async send(functionName: "challengeRefund" | "payout", args: readonly unknown[]): Promise<Hex> {
    const hash = await this.cfg.walletClient.writeContract({
      chain: this.cfg.walletClient.chain, account: this.account, address: this.cfg.vault, abi: VAULT_ABI,
      functionName, args: args as never,
    });
    const r = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }
}

export interface PendingPayout {
  recipient: Address;
  token: Address;
  amount: string;
  protocolFee: string;
  keeperFee: string;
  deadline: string;
  nonce: string;
  tag: Hex;
  signature: Hex;
}

export function toPayout(p: PendingPayout) {
  return {
    recipient: p.recipient,
    token: p.token,
    amount: BigInt(p.amount),
    protocolFee: BigInt(p.protocolFee),
    keeperFee: BigInt(p.keeperFee),
    deadline: BigInt(p.deadline),
    nonce: BigInt(p.nonce),
    tag: p.tag,
  };
}
