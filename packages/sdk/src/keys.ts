/**
 * Note-spending keys, per Curtain_Build.md §1 and §5. Distinct from the
 * secp256k1 ERC-5564 stealth keys in stealth.ts — these are Baby Jubjub
 * keys the ZK pool (joinsplit.circom / unshield.circom) operates on.
 *
 * One long-term spending key controls every note a wallet owns (like
 * Zcash Sapling's spending key) — see CurtainPool.sol's header for why
 * this matters: it's exactly what made the unshieldToOrigin double-spend
 * fix unable to simply reveal `sk` on-chain.
 */
import { buildBabyjub, buildPoseidon } from "circomlibjs";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const HKDF_INFO = new TextEncoder().encode("curtain/spend/v1");

export interface WalletKeys {
  /** Spending key `sk` — controls every note this wallet owns. Never reveal. */
  sk: bigint;
  /** Baby Jubjub public key X coordinate — the `ownerPk_x` embedded in every note commitment. */
  pkX: bigint;
  /** Viewing key `vk = Poseidon(sk, 1)` — derives the note-encryption key; safe to export for disclosure. */
  vk: bigint;
  /** Note-encryption key `ek = vk·G` (Baby Jubjub point) — published so others can encrypt notes to this wallet. */
  ekX: bigint;
  ekY: bigint;
}

let babyJubPromise: ReturnType<typeof buildBabyjub> | undefined;
let poseidonPromise: ReturnType<typeof buildPoseidon> | undefined;

function getBabyJub() {
  babyJubPromise ??= buildBabyjub();
  return babyJubPromise;
}

function getPoseidon() {
  poseidonPromise ??= buildPoseidon();
  return poseidonPromise;
}

/** Generates a fresh 32-byte seed. */
export function generateSeed(): Uint8Array {
  return randomBytes(32);
}

/** Number of mnemonic words a 32-byte seed encodes as, per BIP-39 (256 bits of entropy -> 24 words). */
export const MNEMONIC_WORD_COUNT = 24;

/**
 * Encodes a wallet's 32-byte seed as a 24-word BIP-39 mnemonic, for backup/recovery.
 *
 * This is a direct, reversible entropy<->mnemonic encoding (no PBKDF2 stretching, no
 * passphrase) — the seed IS the entropy, and `deriveWalletKeys` already does its own
 * HKDF-SHA256 stretching from that seed. Adding BIP-39's standard PBKDF2 seed-derivation
 * on top would just be a second, redundant KDF pass with its own passphrase UX to design
 * around, for no real security benefit over the existing HKDF step.
 */
export function mnemonicFromSeed(seed: Uint8Array): string {
  if (seed.length !== 32) {
    throw new Error(`mnemonicFromSeed: expected a 32-byte seed, got ${seed.length} bytes`);
  }
  return entropyToMnemonic(seed, wordlist);
}

/** Decodes a 24-word BIP-39 mnemonic back into the original 32-byte wallet seed. */
export function seedFromMnemonic(mnemonic: string): Uint8Array {
  const normalized = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("seedFromMnemonic: invalid mnemonic (bad word, wrong length, or checksum failure)");
  }
  return mnemonicToEntropy(normalized, wordlist);
}

/** Convenience: generates a fresh seed, its 24-word mnemonic backup, and derives its keys in one call. */
export async function generateWalletKeysWithMnemonic(): Promise<{ seed: Uint8Array; mnemonic: string; keys: WalletKeys }> {
  const seed = generateSeed();
  const mnemonic = mnemonicFromSeed(seed);
  const keys = await deriveWalletKeys(seed);
  return { seed, mnemonic, keys };
}

/** Recovers a wallet's seed and full key set from its 24-word mnemonic backup. */
export async function recoverWalletKeysFromMnemonic(mnemonic: string): Promise<{ seed: Uint8Array; keys: WalletKeys }> {
  const seed = seedFromMnemonic(mnemonic);
  const keys = await deriveWalletKeys(seed);
  return { seed, keys };
}

/** Derives the wallet's full key set from a seed via HKDF, per Curtain_Build.md §5. */
export async function deriveWalletKeys(seed: Uint8Array): Promise<WalletKeys> {
  const babyJub = await getBabyJub();
  const poseidon = await getPoseidon();
  const F = babyJub.F;

  // Both sk and vk are used as Baby Jubjub scalar-mult scalars (BabyPbk to
  // derive pk, and here to derive ek). circomlib's BabyPbk template range-
  // checks its scalar input with Num2Bits(253) — reducing mod the full
  // BN254 scalar field (~2^254) isn't enough, since that still overflows
  // 253 bits roughly half the time (caught as an intermittent circuit
  // assertion failure while building M5's send() flow, not a consistent
  // one, which is what made it non-obvious). Reducing mod Baby Jubjub's
  // own subgroup order (~2^251) keeps every derived scalar safely under
  // the 253-bit bound.
  const skBytes = hkdf(sha256, seed, undefined, HKDF_INFO, 32);
  let sk = 0n;
  for (const byte of skBytes) sk = (sk << 8n) | BigInt(byte);
  sk %= babyJub.subOrder as bigint;

  const pkPoint = babyJub.mulPointEscalar(babyJub.Base8, sk);
  const pkX = F.toObject(pkPoint[0]) as bigint;

  const vk = (F.toObject(poseidon([sk, 1n])) as bigint) % (babyJub.subOrder as bigint);
  const ekPoint = babyJub.mulPointEscalar(babyJub.Base8, vk);
  const ekX = F.toObject(ekPoint[0]) as bigint;
  const ekY = F.toObject(ekPoint[1]) as bigint;

  return { sk, pkX, vk, ekX, ekY };
}

/** Convenience: generates a fresh seed and derives its keys in one call. */
export async function generateWalletKeys(): Promise<{ seed: Uint8Array; keys: WalletKeys }> {
  const seed = generateSeed();
  const keys = await deriveWalletKeys(seed);
  return { seed, keys };
}

export { getBabyJub, getPoseidon };
