/**
 * @curtain/sdk — Staking & Token utilities for $CRTN (M11)
 */

export interface CrtnBucketAllocations {
  community: bigint;  // 80% (80,000,000 CRTN)
  team: bigint;       // 10% (10,000,000 CRTN)
  backers: bigint;    // 5%  (5,000,000 CRTN)
  subsidies: bigint;  // 5%  (5,000,000 CRTN)
}

export const CRTN_TOTAL_SUPPLY = 100_000_000n * 10n ** 18n;
export const MIN_FEE_BPS = 10;
export const MAX_FEE_BPS = 30;
export const MIN_PROPOSAL_STAKE = 100_000n * 10n ** 18n;

/**
 * Calculates 60/40 fee split between stakers (60%) and protocol treasury (40%).
 */
export function calculateFeeSplit(feeAmount: bigint): { stakerShare: bigint; treasuryShare: bigint } {
  if (feeAmount <= 0n) {
    return { stakerShare: 0n, treasuryShare: 0n };
  }
  const treasuryShare = (feeAmount * 40n) / 100n;
  const stakerShare = feeAmount - treasuryShare;
  return { stakerShare, treasuryShare };
}

/**
 * Returns exact bucket allocations for $CRTN 80/10/5/5 distribution.
 */
export function getCrtnBucketAllocations(): CrtnBucketAllocations {
  return {
    community: 80_000_000n * 10n ** 18n,
    team: 10_000_000n * 10n ** 18n,
    backers: 5_000_000n * 10n ** 18n,
    subsidies: 5_000_000n * 10n ** 18n,
  };
}

/**
 * Validates whether a proposed fee in BPS falls within allowed governance bounds [10, 30] bps.
 */
export function validateFeeProposalBps(feeBps: number): boolean {
  return Number.isInteger(feeBps) && feeBps >= MIN_FEE_BPS && feeBps <= MAX_FEE_BPS;
}
