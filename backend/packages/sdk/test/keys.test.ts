import { describe, expect, it } from "bun:test";
import {
  deriveWalletKeys,
  generateSeed,
  generateWalletKeys,
  generateWalletKeysWithMnemonic,
  getBabyJub,
  mnemonicFromSeed,
  recoverWalletKeysFromMnemonic,
  seedFromMnemonic,
} from "../src/keys";

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

describe("mnemonic (BIP-39) backup/recovery", () => {
  it("round-trips a seed through mnemonicFromSeed/seedFromMnemonic unchanged", () => {
    const seed = generateSeed();
    const mnemonic = mnemonicFromSeed(seed);
    expect(mnemonic.split(" ")).toHaveLength(24);
    const recovered = seedFromMnemonic(mnemonic);
    expect(recovered).toEqual(seed);
  });

  it("recovers the exact same wallet keys from a mnemonic as from the original seed", async () => {
    const { seed, mnemonic, keys } = await generateWalletKeysWithMnemonic();
    const { seed: recoveredSeed, keys: recoveredKeys } = await recoverWalletKeysFromMnemonic(mnemonic);
    expect(recoveredSeed).toEqual(seed);
    expect(recoveredKeys).toEqual(keys);
  });

  it("accepts a mnemonic typed with extra whitespace or different casing", async () => {
    const { mnemonic, keys } = await generateWalletKeysWithMnemonic();
    const messy = `  ${mnemonic.split(" ").map((w, i) => (i % 2 === 0 ? w.toUpperCase() : w)).join("   ")}  `;
    const { keys: recoveredKeys } = await recoverWalletKeysFromMnemonic(messy);
    expect(recoveredKeys).toEqual(keys);
  });

  it("rejects a mnemonic with an invalid checksum", () => {
    const { mnemonic } = { mnemonic: mnemonicFromSeed(generateSeed()) };
    const words = mnemonic.split(" ");
    // Swap the last word for a different valid wordlist entry — extremely likely to break
    // the BIP-39 checksum (the last word encodes checksum bits, not just entropy).
    words[words.length - 1] = words[words.length - 1] === "zoo" ? "abandon" : "zoo";
    const tampered = words.join(" ");
    expect(() => seedFromMnemonic(tampered)).toThrow();
  });

  it("rejects a mnemonic containing a word outside the BIP-39 wordlist", () => {
    const mnemonic = mnemonicFromSeed(generateSeed());
    const words = mnemonic.split(" ");
    words[0] = "notarealbip39word";
    expect(() => seedFromMnemonic(words.join(" "))).toThrow();
  });
});
