import { describe, expect, it } from "bun:test";
import {
  CRTN_TOTAL_SUPPLY,
  MIN_FEE_BPS,
  MAX_FEE_BPS,
  calculateFeeSplit,
  getCrtnBucketAllocations,
  validateFeeProposalBps,
} from "../src/staking";

describe("SDK Staking & CRTN Tokenomics", () => {
  it("computes exact 60/40 fee split", () => {
    const { stakerShare, treasuryShare } = calculateFeeSplit(1_000_000n);
    expect(stakerShare).toBe(600_000n);
    expect(treasuryShare).toBe(400_000n);
    expect(stakerShare + treasuryShare).toBe(1_000_000n);
  });

  it("handles zero or negative fee split gracefully", () => {
    const zeroSplit = calculateFeeSplit(0n);
    expect(zeroSplit.stakerShare).toBe(0n);
    expect(zeroSplit.treasuryShare).toBe(0n);
  });

  it("validates 80/10/5/5 total supply allocations", () => {
    const buckets = getCrtnBucketAllocations();
    const sum = buckets.community + buckets.team + buckets.backers + buckets.subsidies;
    expect(sum).toBe(CRTN_TOTAL_SUPPLY);
    expect(buckets.community).toBe((CRTN_TOTAL_SUPPLY * 80n) / 100n);
    expect(buckets.team).toBe((CRTN_TOTAL_SUPPLY * 10n) / 100n);
    expect(buckets.backers).toBe((CRTN_TOTAL_SUPPLY * 5n) / 100n);
    expect(buckets.subsidies).toBe((CRTN_TOTAL_SUPPLY * 5n) / 100n);
  });

  it("validates fee proposal BPS range [10, 30]", () => {
    expect(validateFeeProposalBps(10)).toBe(true);
    expect(validateFeeProposalBps(20)).toBe(true);
    expect(validateFeeProposalBps(30)).toBe(true);

    expect(validateFeeProposalBps(9)).toBe(false);
    expect(validateFeeProposalBps(31)).toBe(false);
    expect(validateFeeProposalBps(15.5)).toBe(false);
  });
});
