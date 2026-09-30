/**
 * Bundle assignment: "bundles carry a random assignee from the bonded set"
 * (Curtain_Build.md §4.1). Deterministic given the bundle and the bonded
 * set at read time, so every node computes the same answer independently
 * without any coordination round.
 */
import { keccak256, type Address } from "viem";
import { bundleId, type Bundle } from "./types";

/** Picks this bundle's assignee from `bondedSet` — same inputs always produce the same output. */
export function computeAssignee(bundle: Bundle, bondedSet: readonly Address[]): Address | undefined {
  if (bondedSet.length === 0) return undefined;
  const hash = keccak256(bundleId(bundle));
  const index = Number(BigInt(hash) % BigInt(bondedSet.length));
  return bondedSet[index];
}

/** True once `assignmentWindowMs` has elapsed since `assignedAtMs` — any bonded broadcaster may submit past this point. */
export function assignmentWindowElapsed(assignedAtMs: number, nowMs: number, assignmentWindowMs: number): boolean {
  return nowMs - assignedAtMs >= assignmentWindowMs;
}
