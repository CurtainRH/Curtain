import { describe, expect, it } from "bun:test";
import { aggregateSolvencyEpoch } from "../src/index";

describe("@curtain/solvency service", () => {
  it("aggregates solvency chunks and verifies solvency state", () => {
    const chunks = [
      { chunkIdx: 0, partialSum: 400n * 10n ** 18n, snapshotRoot: 100n, nullifierRoot: 200n, tokenId: 1n },
      { chunkIdx: 1, partialSum: 500n * 10n ** 18n, snapshotRoot: 100n, nullifierRoot: 200n, tokenId: 1n },
    ];

    const report = aggregateSolvencyEpoch(1, "0x000000000000000000000000000000000000000b", chunks, 1000n * 10n ** 18n);

    expect(report.epoch).toBe(1);
    expect(report.totalLiveNotes).toBe(900n * 10n ** 18n);
    expect(report.poolBalance).toBe(1000n * 10n ** 18n);
    expect(report.isSolvent).toBe(true);
  });

  it("detects insolvency when live notes exceed pool balance", () => {
    const chunks = [
      { chunkIdx: 0, partialSum: 1200n * 10n ** 18n, snapshotRoot: 100n, nullifierRoot: 200n, tokenId: 1n },
    ];

    const report = aggregateSolvencyEpoch(1, "0x000000000000000000000000000000000000000b", chunks, 1000n * 10n ** 18n);

    expect(report.isSolvent).toBe(false);
  });
});
