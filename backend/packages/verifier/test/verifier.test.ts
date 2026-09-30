import { describe, expect, it } from "bun:test";
import { isGrantValid, validateSolvencyPublicSignals, verifySolvencySolvent } from "../src/index";

describe("@curtain/verifier", () => {
  it("validates solvency public signals structure", () => {
    const valid = validateSolvencyPublicSignals({
      partialSum: 100n,
      snapshotRoot: 12345n,
      nullifierRoot: 67890n,
      tokenId: 1n,
    });
    expect(valid).toBe(true);

    const invalid = validateSolvencyPublicSignals({
      partialSum: 100n,
      snapshotRoot: 0n,
      nullifierRoot: 67890n,
      tokenId: 1n,
    });
    expect(invalid).toBe(false);
  });

  it("verifies solvency balance conservation", () => {
    expect(verifySolvencySolvent(900n, 1000n)).toBe(true);
    expect(verifySolvencySolvent(1000n, 1000n)).toBe(true);
    expect(verifySolvencySolvent(1001n, 1000n)).toBe(false);
  });

  it("validates active and revoked disclosure grants", () => {
    const grant = {
      grantId: "0x1",
      granter: "0x0000000000000000000000000000000000000001",
      scopeHash: "0x2",
      viewerEk: "0x3",
      encryptedVk: "0x4",
      until: 1000,
      revoked: false,
    };

    expect(isGrantValid(grant, 500)).toBe(true);
    expect(isGrantValid(grant, 1001)).toBe(false);
    expect(isGrantValid({ ...grant, revoked: true }, 500)).toBe(false);
  });
});
