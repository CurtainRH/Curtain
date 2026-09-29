import { describe, expect, it } from "bun:test";
import { deriveWalletKeys, generateSeed, generateWalletKeys, getBabyJub } from "../src/keys";

describe("wallet keys (Baby Jubjub spending/viewing keys)", () => {
  it("derives the same keys from the same seed (deterministic)", async () => {
    const seed = generateSeed();
    const keysA = await deriveWalletKeys(seed);
    const keysB = await deriveWalletKeys(seed);
    expect(keysA).toEqual(keysB);
  });

  it("derives different keys from different seeds", async () => {
    const { keys: a } = await generateWalletKeys();
    const { keys: b } = await generateWalletKeys();
    expect(a.sk).not.toBe(b.sk);
    expect(a.pkX).not.toBe(b.pkX);
  });

  it("keeps sk and vk under Baby Jubjub's subgroup order (fits circomlib's BabyPbk Num2Bits(253) bound)", async () => {
    const babyJub = await getBabyJub();
    const subOrder = babyJub.subOrder as bigint;
    // Regenerate many times: this specifically regression-tests the M5 bug
    // where reducing mod the full BN254 field (not the subgroup order) let
    // sk exceed 253 bits roughly half the time, causing an intermittent
    // circuit assertion failure that only showed up under send().
    for (let i = 0; i < 20; i++) {
      const { keys } = await generateWalletKeys();
      expect(keys.sk).toBeLessThan(subOrder);
      expect(keys.vk).toBeLessThan(subOrder);
    }
  });

  it("pkX is genuinely sk's Baby Jubjub public key (not the raw seed or an unrelated value)", async () => {
    const babyJub = await getBabyJub();
    const { keys } = await generateWalletKeys();
    const point = babyJub.mulPointEscalar(babyJub.Base8, keys.sk);
    expect(babyJub.F.toObject(point[0])).toBe(keys.pkX);
  });
});
