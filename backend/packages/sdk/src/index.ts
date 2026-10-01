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
import { decodeEventLog, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { ERC20_ABI, STAKING_ABI, VAULT_ABI } from "./abi";

export * from "./abi";

export const REFUND_DELAY_SECONDS = 180;
export const CHALLENGE_WINDOW_SECONDS = 600;
export const TIERS = [
  { tier: 0, days: 30, multiplier: 1 },
  { tier: 1, days: 90, multiplier: 1.5 },
  { tier: 2, days: 180, multiplier: 2 },
] as const;

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

export interface CurtainConfig {
  apiUrl: string;
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
    return this.api<{ status: string; depositId: string | null; amountOut: string | null; payoutTx: string | null }>(`/intents/${intentId}`);
  }

  /** Creates the intent, approves the vault if needed, and deposits. */
  async swap(p: SwapParams): Promise<{ intentId: string; ticket: EscapeTicket; depositTx: Hex }> {
    const wallet = this.wallet;
    const owner = wallet.account!.address;
    // The operator matches the deposit on (depositor, hash), so it must come from this wallet.
    const intent = await this.api<{ id: string; deadline: string; salt: Hex; deadlineHash: Hex; vault: Address }>("/intents", { ...p, depositor: owner });
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
    const w = this.wallet;
    return this.sendTx(await w.writeContract({
      chain: w.chain, account: w.account!, address: t.vault, abi: VAULT_ABI, functionName: "requestRefund",
      args: [BigInt(t.depositId), BigInt(t.deadline), t.salt],
    }));
  }

  /** Callable by anyone once the 10-minute challenge window has passed; pays the depositor. */
  async finalizeRefund(t: EscapeTicket): Promise<Hex> {
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
