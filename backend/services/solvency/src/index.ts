/**
 * @curtain/solvency — Solvency proof service
 * Computes chunked solvency totals across unspent commitments and verifies pool balance backing per epoch.
 */
import { validateSolvencyPublicSignals, verifySolvencySolvent } from "@curtain/verifier";

export const name = "solvency" as const;

export function ready(): boolean {
  return true;
}

export interface SolvencyChunkData {
  chunkIdx: number;
  partialSum: bigint;
  snapshotRoot: bigint;
  nullifierRoot: bigint;
  tokenId: bigint;
}

export interface SolvencyEpochReport {
  epoch: number;
  token: string;
  totalLiveNotes: bigint;
  poolBalance: bigint;
  isSolvent: boolean;
  timestamp: number;
}

/**
 * Validates and aggregates solvency chunk data for an epoch report.
 */
export function aggregateSolvencyEpoch(
  epoch: number,
  token: string,
  chunks: SolvencyChunkData[],
  poolBalance: bigint
): SolvencyEpochReport {
  let totalLiveNotes = 0n;

  for (const chunk of chunks) {
    if (!validateSolvencyPublicSignals(chunk)) {
      throw new Error(`Invalid solvency chunk signals for chunk ${chunk.chunkIdx}`);
    }
    totalLiveNotes += chunk.partialSum;
  }

  const isSolvent = verifySolvencySolvent(totalLiveNotes, poolBalance);

  return {
    epoch,
    token,
    totalLiveNotes,
    poolBalance,
    isSolvent,
    timestamp: Math.floor(Date.now() / 1000),
  };
}
