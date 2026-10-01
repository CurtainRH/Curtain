/**
 * Curtain v2 client (docs/CURTAIN_V2_SPEC.md) for the web app and scripts.
 *
 * Private swap:
 *   const swap = await curtain.swap({ tokenIn, amountIn, tokenOut, recipient, minOut, delaySeconds });
 *   // Persist `swap.ticket` (e.g. download it): it's the only way to use the escape hatch.
 *   await curtain.status(swap.intentId);
 *
 * Escape hatch (if a swap isn't paid): `refundAvailableAt(ticket)` -> `requestRefund(ticket)`
 * -> wait 10 minutes -> `finalizeRefund(ticket)`.
 *
 * Staking: `stake(amount, tier)`, `claim(id)`, `withdraw(id)`, `earned(id)`.
 */
import { decodeEventLog, encodeAbiParameters, getAddress, keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { ERC20_ABI, STAKING_ABI, VAULT_ABI } from "./abi";

export * from "./abi";
export * from "./tokens";

export const REFUND_DELAY_SECONDS = 180;
export const CHALLENGE_WINDOW_SECONDS = 600;
export const TIERS = [
  { tier: 0, days: 30, multiplier: 1 },
  { tier: 1, days: 90, multiplier: 1.5 },
  { tier: 2, days: 180, multiplier: 2 },
] as const;

/** Intent lifecycle, as reported by GET /intents/:id. */
export type IntentStatus =
  | "awaiting_deposit" // intent created, deposit not seen yet
  | "deposited"        // deposit seen, waiting for its payout time (or a better price)
  | "settling"         // settlement signed, waiting for a keeper to land it
  | "paid"             // output delivered to the recipient
  | "blocked"          // the output token refuses this recipient: refund via the escape hatch
  | "expired"          // deposit didn't match the intent (wrong token): refund via the escape hatch
  | "refund_requested" // escape hatch started; finalize after 10 minutes
  | "refunded"         // deposit returned
  | "challenged";      // a refund was requested for a deposit that had already been paid

export interface SwapQuote {
  amountIn: string;
  /** Raw market output before fees and tolerances. */
  marketOut: string;
  /** What the recipient should get if settled now (after protocol + keeper fees). */
  expectedOut: string;
  /** expectedOut minus the requested slippage: pass as `minOut`. */
  minOutSuggested: string;
  protocolFee: string;
  keeperFee: string;
  /** e.g. "uniswap-v4 0.3%", "uniswap-v3 0.05%", or "none" for same-token transfers. */
  venue: string;
  /** False when no pool can fill the swap right now. */
  available: boolean;
}

export interface SwapParams {
  tokenIn: Address;
  amountIn: bigint;
  tokenOut: Address;
  /** Where token Y goes. A fresh address gives the most privacy. */
  recipient: Address;
  /** Minimum the recipient receives (after fees). */
  minOut: bigint;
  /** 0 = instant; otherwise a random delay window in seconds (up to 180 days). */
  delaySeconds: number;
}

/** Everything needed to reclaim a deposit through the escape hatch. Keep it private. */
export interface EscapeTicket {
  vault: Address;
  depositId: string;
  deadline: string;
  salt: Hex;
}

/** An escape ticket before its deposit has landed (no deposit id yet). See `onIntent`. */
export interface PendingTicket {
  intentId: string;
  vault: Address;
  deadline: string;
  salt: Hex;
}

export interface CurtainConfig {
  apiUrl: string;
  /**
   * The vault address this app trusts (from its own config, not the API). When set, `swap()`
   * refuses to approve or deposit if the API names a different vault, and refunds refuse
   * tickets for another vault. Set it in production: a compromised API must not be able to
   * redirect deposits.
   */
  vaultAddress?: Address;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  stakingAddress?: Address;
  fetch?: typeof fetch;
}

export class CurtainClient {
  constructor(private cfg: CurtainConfig) {}

  private get wallet(): WalletClient {
    if (!this.cfg.walletClient) throw new Error("this action needs a walletClient");
    return this.cfg.walletClient;
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.apiUrl}${path}`, body === undefined ? undefined : {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    });
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  config() {
    return this.api<{ vault: Address; tokens: Record<string, Address>; keeperFeeBps: number; maxDelaySeconds: number }>("/config");
  }

  status(intentId: string) {
    return this.api<{ status: IntentStatus; depositId: string | null; amountOut: string | null; payoutTx: string | null; blockedReason: string | null }>(`/intents/${intentId}`);
  }

  /** Expected output for a swap right now, after fees. Use `minOutSuggested` as `minOut`. */
  quote(tokenIn: Address, tokenOut: Address, amountIn: bigint, slippageBps = 100) {
    const q = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString(), slippageBps: String(slippageBps) });
    return this.api<SwapQuote>(`/quote?${q}`);
  }

  private checkVault(vault: Address): void {
    if (this.cfg.vaultAddress && getAddress(vault) !== getAddress(this.cfg.vaultAddress)) {
      throw new Error(`Refusing to use vault ${vault}: this app is configured for ${this.cfg.vaultAddress}`);
    }
  }

  /**
   * Creates the intent, approves the vault if needed, and deposits. `onIntent` receives the
   * escape ticket's secrets BEFORE the wallet is asked to deposit: persist them there, so a
   * browser closed mid-deposit still leaves the user able to refund (recover the deposit id
   * later with `findDepositId`).
   */
  async swap(
    p: SwapParams,
    opts: { onIntent?: (pending: PendingTicket) => void | Promise<void> } = {},
  ): Promise<{ intentId: string; ticket: EscapeTicket; depositTx: Hex }> {
    const wallet = this.wallet;
    const owner = wallet.account!.address;
    // The operator matches the deposit on (depositor, hash), so it must come from this wallet.
    const intent = await this.api<{ id: string; deadline: string; salt: Hex; deadlineHash: Hex; vault: Address }>("/intents", { ...p, depositor: owner });
    this.checkVault(intent.vault);
    if (deadlineHashOf(BigInt(intent.deadline), intent.salt) !== intent.deadlineHash) {
      throw new Error("The service returned an inconsistent escape ticket; nothing was deposited.");
    }
    await opts.onIntent?.({ intentId: intent.id, vault: intent.vault, deadline: intent.deadline, salt: intent.salt });
    const { publicClient } = this.cfg;

    const allowance = await publicClient.readContract({ address: p.tokenIn, abi: ERC20_ABI, functionName: "allowance", args: [owner, intent.vault] });
    if (allowance < p.amountIn) {
      await this.send(await wallet.writeContract({
        chain: wallet.chain, account: wallet.account!, address: p.tokenIn, abi: ERC20_ABI, functionName: "approve", args: [intent.vault, p.amountIn],
      }));
    }
    const depositTx = await wallet.writeContract({
      chain: wallet.chain, account: wallet.account!, address: intent.vault, abi: VAULT_ABI, functionName: "deposit", args: [p.tokenIn, p.amountIn, intent.deadlineHash],
    });
    const receipt = await this.send(depositTx);
    let depositId: bigint | undefined;
    for (const l of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
        if (ev.eventName === "Deposited") depositId = ev.args.depositId;
      } catch {
        // not a vault event
      }
    }
    if (depositId === undefined) throw new Error("deposit: no Deposited event");
    return {
      intentId: intent.id,
      ticket: { vault: intent.vault, depositId: depositId.toString(), deadline: intent.deadline, salt: intent.salt },
      depositTx,
    };
  }

  /** Unix time from which `requestRefund` works for this ticket. */
  refundAvailableAt(t: EscapeTicket): number {
    return Number(t.deadline) + REFUND_DELAY_SECONDS;
  }

  async requestRefund(t: EscapeTicket): Promise<Hex> {
    this.checkVault(t.vault);
    const w = this.wallet;
    return this.sendTx(await w.writeContract({
      chain: w.chain, account: w.account!, address: t.vault, abi: VAULT_ABI, functionName: "requestRefund",
      args: [BigInt(t.depositId), BigInt(t.deadline), t.salt],
    }));
  }

  /** Callable by anyone once the 10-minute challenge window has passed; pays the depositor. */
  async finalizeRefund(t: EscapeTicket): Promise<Hex> {
    this.checkVault(t.vault);
    const w = this.wallet;
    return this.sendTx(await w.writeContract({
      chain: w.chain, account: w.account!, address: t.vault, abi: VAULT_ABI, functionName: "finalizeRefund", args: [BigInt(t.depositId)],
    }));
  }

  // ---- staking ----

  private get staking(): Address {
    if (!this.cfg.stakingAddress) throw new Error("stakingAddress not configured");
    return this.cfg.stakingAddress;
  }

  /** Approves if needed and stakes into a lock tier (0 = 30d, 1 = 90d, 2 = 180d). Returns the position id. */
  async stake(token: Address, amount: bigint, tier: 0 | 1 | 2): Promise<bigint> {
    const w = this.wallet;
    const owner = w.account!.address;
    const allowance = await this.cfg.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "allowance", args: [owner, this.staking] });
    if (allowance < amount) {
      await this.send(await w.writeContract({ chain: w.chain, account: w.account!, address: token, abi: ERC20_ABI, functionName: "approve", args: [this.staking, amount] }));
    }
    const receipt = await this.send(await w.writeContract({
      chain: w.chain, account: w.account!, address: this.staking, abi: STAKING_ABI, functionName: "stake", args: [amount, tier],
    }));
    for (const l of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: STAKING_ABI, data: l.data, topics: l.topics });
        if (ev.eventName === "Staked") return ev.args.positionId;
      } catch {
        // other event
      }
    }
    throw new Error("stake: no Staked event");
  }

  earned(positionId: bigint): Promise<bigint> {
    return this.cfg.publicClient.readContract({ address: this.staking, abi: STAKING_ABI, functionName: "earned", args: [positionId] });
  }

  async claim(positionId: bigint): Promise<Hex> {
    const w = this.wallet;
    return this.sendTx(await w.writeContract({ chain: w.chain, account: w.account!, address: this.staking, abi: STAKING_ABI, functionName: "claim", args: [positionId] }));
  }

  async withdraw(positionId: bigint): Promise<Hex> {
    const w = this.wallet;
    return this.sendTx(await w.writeContract({ chain: w.chain, account: w.account!, address: this.staking, abi: STAKING_ABI, functionName: "withdraw", args: [positionId] }));
  }

  private async send(hash: Hex) {
    const r = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return r;
  }

  private async sendTx(hash: Hex): Promise<Hex> {
    await this.send(hash);
    return hash;
  }
}

/** keccak256(abi.encode(deadline, salt)): the hash a deposit carries on-chain. */
export function deadlineHashOf(deadline: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [deadline, salt]));
}

/**
 * Finds the deposit id for a pending ticket (see `swap`'s `onIntent`) from the vault's
 * `Deposited` events: depositor and hash must both match. Returns undefined if no such deposit
 * was made (e.g. the user rejected it in their wallet).
 */
export async function findDepositId(
  publicClient: PublicClient,
  pending: PendingTicket,
  depositor: Address,
  fromBlock: bigint = 0n,
): Promise<bigint | undefined> {
  const hash = deadlineHashOf(BigInt(pending.deadline), pending.salt);
  const logs = await publicClient.getContractEvents({
    address: pending.vault, abi: VAULT_ABI, eventName: "Deposited", args: { depositor }, fromBlock,
  });
  const hit = logs.find((l) => (l.args as { deadlineHash?: Hex }).deadlineHash?.toLowerCase() === hash.toLowerCase());
  return hit ? (hit.args as { depositId: bigint }).depositId : undefined;
}

export interface StakePosition {
  id: bigint;
  amount: bigint;
  weighted: bigint;
  unlockAt: number;
  earned: bigint;
  closed: boolean;
}

/**
 * A wallet's staking positions. The contract has no per-owner index, so this reads the
 * `Staked(positionId, owner, ...)` events for `owner` (owner is indexed) from `fromBlock`
 * (the staking contract's deployment block), then each position's current state.
 */
export async function positionsOf(
  publicClient: PublicClient,
  staking: Address,
  owner: Address,
  fromBlock: bigint,
): Promise<StakePosition[]> {
  const logs = await publicClient.getContractEvents({ address: staking, abi: STAKING_ABI, eventName: "Staked", args: { owner }, fromBlock });
  const out: StakePosition[] = [];
  for (const l of logs) {
    const id = (l.args as { positionId: bigint }).positionId;
    const [, amount, weighted, unlockAt, , , closed] = await publicClient.readContract({ address: staking, abi: STAKING_ABI, functionName: "positions", args: [id] });
    const earned = closed ? 0n : await publicClient.readContract({ address: staking, abi: STAKING_ABI, functionName: "earned", args: [id] });
    out.push({ id, amount, weighted, unlockAt: Number(unlockAt), earned, closed });
  }
  return out;
}
