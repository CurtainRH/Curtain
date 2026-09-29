/**
 * Solvency proof and receipt verification functions for @curtain/verifier.
 */

export interface SolvencyPublicSignals {
  partialSum: bigint;
  snapshotRoot: bigint;
  nullifierRoot: bigint;
  tokenId: bigint;
}

export interface SolvencyEpochResult {
  epoch: bigint;
  token: string;
  totalLiveNotes: bigint;
  poolBalance: bigint;
  isSolvent: boolean;
  timestamp: number;
}

/**
 * Validates public signals for a chunked solvency proof.
 */
export function validateSolvencyPublicSignals(signals: SolvencyPublicSignals): boolean {
  if (signals.partialSum < 0n) return false;
  if (signals.snapshotRoot === 0n) return false;
  if (signals.nullifierRoot === 0n) return false;
  if (signals.tokenId === 0n) return false;
  return true;
}

/**
 * Verifies if the aggregated live note total across all chunks is fully backed by pool balance.
 */
export function verifySolvencySolvent(totalLiveNotes: bigint, poolBalance: bigint): boolean {
  return totalLiveNotes <= poolBalance;
}
