/**
 * UTXO note commitments, nullifiers, and ECDH note encryption, per
 * Curtain_Build.md §1. Mirrors the exact formulas circuits/joinsplit.circom
 * and CurtainPool.sol use, so notes built here open correctly on-chain.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { getBabyJub, getPoseidon } from "./keys";
import type { WalletKeys } from "./keys";

export interface Note {
  tokenId: bigint;
  rawAmount: bigint;
  ownerPkX: bigint;
  blinding: bigint;
  /** Position in CurtainPool's main tree — undefined until observed on-chain. */
  leafIndex?: number;
  commit: bigint;
}

export interface NotePlaintext {
  tokenId: bigint;
  rawAmount: bigint;
  blinding: bigint;
}

/** `C = Poseidon(tokenId, rawAmount, ownerPk_x, blinding)` — must match CurtainPool.sol and joinsplit.circom exactly. */
export async function computeCommitment(note: Omit<Note, "commit" | "leafIndex">): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([note.tokenId, note.rawAmount, note.ownerPkX, note.blinding])) as bigint;
}

/** `N = Poseidon(ownerSk, leafIndex)` — the nullifier a join-split spend of this note produces. */
export async function computeNullifier(ownerSk: bigint, leafIndex: number | bigint): Promise<bigint> {
  const poseidon = await getPoseidon();
  const F = poseidon.F;
  return F.toObject(poseidon([ownerSk, BigInt(leafIndex)])) as bigint;
}

function bigintToBytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Sender side. ECDH on Baby Jubjub (ephemeral `r`, shared `S = r·ek`) ->
 * ChaCha20-Poly1305 key = Poseidon(S.x, S.y), per Curtain_Build.md §1.
 * Returns the `(ephemeralPk, ct)` pair CurtainPool's NoteCiphertext event
 * expects.
 */
export async function encryptNoteTo(
  recipientEkX: bigint,
  recipientEkY: bigint,
  plaintext: NotePlaintext,
): Promise<{ ephemeralPk: `0x${string}`; ct: `0x${string}` }> {
  const babyJub = await getBabyJub();
  const poseidon = await getPoseidon();
  const F = babyJub.F;

  const rBytes = randomBytes(32);
  let r = bytesToBigint(rBytes) % (babyJub.subOrder as bigint);
  if (r === 0n) r = 1n;

  const ephemeralPoint = babyJub.mulPointEscalar(babyJub.Base8, r);
  const sharedPoint = babyJub.mulPointEscalar([F.e(recipientEkX), F.e(recipientEkY)], r);
  const sharedX = F.toObject(sharedPoint[0]) as bigint;
  const sharedY = F.toObject(sharedPoint[1]) as bigint;

  const symmetricKey = bigintToBytes32(poseidon.F.toObject(poseidon([sharedX, sharedY])) as bigint).slice(0, 32);
  const nonce = randomBytes(12);

  const plaintextBytes = new Uint8Array(96);
  plaintextBytes.set(bigintToBytes32(plaintext.tokenId), 0);
  plaintextBytes.set(bigintToBytes32(plaintext.rawAmount), 32);
  plaintextBytes.set(bigintToBytes32(plaintext.blinding), 64);

  const cipher = chacha20poly1305(symmetricKey, nonce);
  const sealed = cipher.encrypt(plaintextBytes);

  const ephemeralPkBytes = new Uint8Array(64);
  ephemeralPkBytes.set(bigintToBytes32(F.toObject(ephemeralPoint[0]) as bigint), 0);
  ephemeralPkBytes.set(bigintToBytes32(F.toObject(ephemeralPoint[1]) as bigint), 32);

  const ctBytes = new Uint8Array(nonce.length + sealed.length);
  ctBytes.set(nonce, 0);
  ctBytes.set(sealed, nonce.length);

  return {
    ephemeralPk: `0x${Buffer.from(ephemeralPkBytes).toString("hex")}`,
    ct: `0x${Buffer.from(ctBytes).toString("hex")}`,
  };
}

/**
 * Recipient side. Trial-decrypts a NoteCiphertext entry with this wallet's
 * viewing key. Returns `undefined` on auth failure (not this wallet's note)
 * rather than throwing — callers scan many entries and expect most to fail.
 */
export async function tryDecryptNote(
  keys: WalletKeys,
  ephemeralPk: `0x${string}`,
  ct: `0x${string}`,
): Promise<NotePlaintext | undefined> {
  const babyJub = await getBabyJub();
  const poseidon = await getPoseidon();
  const F = babyJub.F;

  const ephemeralBytes = Buffer.from(ephemeralPk.slice(2), "hex");
  if (ephemeralBytes.length !== 64) return undefined;
  const ephemeralX = bytesToBigint(ephemeralBytes.subarray(0, 32));
  const ephemeralY = bytesToBigint(ephemeralBytes.subarray(32, 64));

  const sharedPoint = babyJub.mulPointEscalar([F.e(ephemeralX), F.e(ephemeralY)], keys.vk);
  const sharedX = F.toObject(sharedPoint[0]) as bigint;
  const sharedY = F.toObject(sharedPoint[1]) as bigint;
  const symmetricKey = bigintToBytes32(poseidon.F.toObject(poseidon([sharedX, sharedY])) as bigint).slice(0, 32);

  const ctBytes = Buffer.from(ct.slice(2), "hex");
  if (ctBytes.length < 12) return undefined;
  const nonce = ctBytes.subarray(0, 12);
  const sealed = ctBytes.subarray(12);

  try {
    const cipher = chacha20poly1305(symmetricKey, nonce);
    const plaintextBytes = cipher.decrypt(sealed);
    return {
      tokenId: bytesToBigint(plaintextBytes.subarray(0, 32)),
      rawAmount: bytesToBigint(plaintextBytes.subarray(32, 64)),
      blinding: bytesToBigint(plaintextBytes.subarray(64, 96)),
    };
  } catch {
    return undefined; // wrong key — not an error, just not this wallet's note
  }
}
