/**
 * Broadcaster protocol shapes, per Curtain_Build.md §4.1. `shieldMeta` is
 * listed as a bundle kind in spec but has no corresponding meta-tx
 * forwarder contract anywhere in this repo yet — bundles of that kind are
 * accepted and stored like any other, but `submitBundle` refuses to
 * execute them until such a contract exists (see Curtain_Build.md §11).
 */
import type { Address, Hex } from "viem";

export type BundleKind = "transact" | "relay" | "unshieldToOrigin" | "shieldMeta";

export interface Bundle {
  chainId: number;
  kind: BundleKind;
  /** The target contract this bundle's calldata should be sent to (CurtainPool or RelayAdapt). */
  to: Address;
  calldata: Hex;
  feeToken: Address;
  feeAmount: bigint;
  deadline: number; // unix seconds
  extDataHash: Hex;
  sig?: Hex;
}

/** A stable id for a bundle, used for assignment and dedup — NOT its eventual tx hash. */
export function bundleId(bundle: Bundle): Hex {
  // Cheap, deterministic, and good enough for assignment/dedup purposes —
  // collision-resistance against an adversarial bundle author isn't a
  // requirement here (a colliding bundle would just be treated as the same
  // bundle, which is at worst a liveness nuisance, not a fund-safety issue).
  const encoder = new TextEncoder();
  const bytes = encoder.encode(JSON.stringify({ ...bundle, feeAmount: bundle.feeAmount.toString() }));
  return `0x${Buffer.from(bytes).toString("hex").slice(0, 64).padEnd(64, "0")}` as Hex;
}

export interface FeeSchedule {
  [tokenAddress: Address]: {
    minFeeAmount: string; // stringified bigint — this is a published JSON document (GET /fees.json)
  };
}

export interface BroadcasterConfig {
  address: Address;
  /** Flat minimum fee this broadcaster accepts, per token — see index.ts's header on why this
   * is simpler than a real bps-of-notional schedule. */
  feeSchedule: Map<Address, bigint>;
  /** How long (ms) an assignee gets before any other broadcaster may submit — 10 min per spec. */
  assignmentWindowMs: number;
}
