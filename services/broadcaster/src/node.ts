/**
 * Core broadcaster node logic, per Curtain_Build.md §4.1: simulate ->
 * check fee -> submit -> return txHash, plus assignment tracking and the
 * censorship fallback (any broadcaster may submit past the 10-minute
 * assignment window). Deliberately separate from the HTTP transport
 * (index.ts) so this logic is directly testable without spinning up real
 * servers — see test/broadcaster.e2e.test.ts.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { computeAssignee, assignmentWindowElapsed } from "./assignment";
import { bundleId, type Bundle, type BroadcasterConfig } from "./types";

export class InsufficientFeeError extends Error {
  constructor(token: Address, offered: bigint, required: bigint) {
    super(`fee ${offered} for ${token} is below this broadcaster's published minimum ${required}`);
  }
}

export class UnknownFeeTokenError extends Error {
  constructor(token: Address) {
    super(`no published fee schedule for token ${token}`);
  }
}

export class NotYetAssignableError extends Error {
  constructor(assignee: Address, availableAt: number) {
    super(`bundle is assigned to ${assignee} until ${new Date(availableAt).toISOString()}`);
  }
}

export class UnsupportedBundleKindError extends Error {
  constructor(kind: string) {
    super(`bundle kind "${kind}" has no corresponding on-chain entry point yet — see Curtain_Build.md §11`);
  }
}

interface TrackedBundle {
  bundle: Bundle;
  assignee: Address | undefined;
  assignedAtMs: number;
  minedTxHash?: Hex;
}

export class BroadcasterNode {
  private tracked = new Map<Hex, TrackedBundle>();

  constructor(
    private config: BroadcasterConfig,
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private getBondedSet: () => Promise<readonly Address[]>,
  ) {}

  /** Records a bundle this node has observed (via gossip or the HTTPS fallback) and computes its assignee. */
  async trackBundle(bundle: Bundle, nowMs: number = Date.now()): Promise<void> {
    const id = bundleId(bundle);
    if (this.tracked.has(id)) return;
    const bondedSet = await this.getBondedSet();
    this.tracked.set(id, { bundle, assignee: computeAssignee(bundle, bondedSet), assignedAtMs: nowMs });
  }

  markMined(bundle: Bundle, txHash: Hex): void {
    const tracked = this.tracked.get(bundleId(bundle));
    if (tracked) tracked.minedTxHash = txHash;
  }

  isMined(bundle: Bundle): boolean {
    return this.tracked.get(bundleId(bundle))?.minedTxHash !== undefined;
  }

  /** Checks the bundle's fee against this node's own published schedule — see types.ts's header on why this is a flat minimum, not a bps-of-notional schedule. */
  checkFee(bundle: Bundle): void {
    const required = this.config.feeSchedule.get(bundle.feeToken);
    if (required === undefined) throw new UnknownFeeTokenError(bundle.feeToken);
    if (bundle.feeAmount < required) throw new InsufficientFeeError(bundle.feeToken, bundle.feeAmount, required);
  }

  /**
   * Submits `bundle` if this node is either the current assignee or the
   * assignment window has elapsed (the censorship-fallback path). Simulates
   * first (an `eth_call` against the exact calldata) so a doomed
   * transaction never gets broadcast and burns real gas.
   */
  async submitBundle(bundle: Bundle, nowMs: number = Date.now()): Promise<Hex> {
    if (bundle.kind === "shieldMeta") throw new UnsupportedBundleKindError(bundle.kind);

    await this.trackBundle(bundle, nowMs);
    const tracked = this.tracked.get(bundleId(bundle))!;

    const isAssignee = tracked.assignee === undefined || tracked.assignee.toLowerCase() === this.config.address.toLowerCase();
    if (!isAssignee) {
      const windowElapsed = assignmentWindowElapsed(tracked.assignedAtMs, nowMs, this.config.assignmentWindowMs);
      if (!windowElapsed) throw new NotYetAssignableError(tracked.assignee!, tracked.assignedAtMs + this.config.assignmentWindowMs);
    }

    this.checkFee(bundle);

    await this.publicClient.call({ account: this.config.address, to: bundle.to, data: bundle.calldata });

    const hash = await this.walletClient.sendTransaction({
      chain: this.walletClient.chain,
      account: this.config.address,
      to: bundle.to,
      data: bundle.calldata,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
    if (receipt.status !== "success") throw new Error(`submitted bundle reverted on-chain: ${hash}`);

    this.markMined(bundle, hash);
    return hash;
  }

  /**
   * True if this bundle was assigned to someone other than `nowMs`'s caller
   * (i.e. not this node), that assignee's window has elapsed, and the
   * bundle still isn't mined — the precondition for filing censorship
   * evidence against the assignee. Gathering the attestor signatures a real
   * `BroadcasterBond.slash()` call needs is a separate, off-chain
   * governance process this method does not perform — see
   * Curtain_Build.md §11.
   */
  detectCensorship(bundle: Bundle, nowMs: number = Date.now()): { censored: boolean; assignee?: Address } {
    const tracked = this.tracked.get(bundleId(bundle));
    if (!tracked || !tracked.assignee || tracked.minedTxHash) return { censored: false };
    const windowElapsed = assignmentWindowElapsed(tracked.assignedAtMs, nowMs, this.config.assignmentWindowMs);
    return { censored: windowElapsed, assignee: tracked.assignee };
  }

  publishFeeSchedule(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [token, amount] of this.config.feeSchedule) out[token] = amount.toString();
    return out;
  }
}
