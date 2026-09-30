/**
 * Disclosure UX helpers per Curtain_Build.md §3.6 and §5.
 * Allows note owners to create encrypted viewing key grants for auditors/viewers,
 * and allows viewers to decrypt those viewing keys using their secret key.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { keccak256, toHex, type Hex } from "viem";
import { getBabyJub, getPoseidon } from "./keys";

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

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface DisclosureGrantParams {
  scope: string;
  viewingKey: bigint;
  viewerEkX: bigint;
  viewerEkY: bigint;
  until?: bigint;
}

export interface DisclosureGrantBundle {
  scopeHash: Hex;
  viewerEk: Hex;
  encryptedVk: Hex;
  until: bigint;
}

/**
 * Creates an encrypted viewing key grant for a viewer.
 */
export async function createDisclosureGrant(params: DisclosureGrantParams): Promise<DisclosureGrantBundle> {
  const { scope, viewingKey, viewerEkX, viewerEkY, until = 0n } = params;

  const babyJub = await getBabyJub();
  const poseidon = await getPoseidon();
  const F = babyJub.F;

  const rBytes = randomBytes(32);
  let r = bytesToBigint(rBytes) % (babyJub.subOrder as bigint);
  if (r === 0n) r = 1n;

  const ephemeralPoint = babyJub.mulPointEscalar(babyJub.Base8, r);
  const sharedPoint = babyJub.mulPointEscalar([F.e(viewerEkX), F.e(viewerEkY)], r);
  const sharedX = F.toObject(sharedPoint[0]) as bigint;
  const sharedY = F.toObject(sharedPoint[1]) as bigint;

  const symmetricKey = bigintToBytes32(poseidon.F.toObject(poseidon([sharedX, sharedY])) as bigint).slice(0, 32);
  const nonce = randomBytes(12);

  const vkBytes = bigintToBytes32(viewingKey);
  const cipher = chacha20poly1305(symmetricKey, nonce);
  const sealed = cipher.encrypt(vkBytes);

  const viewerEkBytes = new Uint8Array(64);
  viewerEkBytes.set(bigintToBytes32(F.toObject(ephemeralPoint[0]) as bigint), 0);
  viewerEkBytes.set(bigintToBytes32(F.toObject(ephemeralPoint[1]) as bigint), 32);

  const ctBytes = new Uint8Array(nonce.length + sealed.length);
  ctBytes.set(nonce, 0);
  ctBytes.set(sealed, nonce.length);

  return {
    scopeHash: keccak256(Buffer.from(scope, "utf8")),
    viewerEk: toHex(viewerEkBytes),
    encryptedVk: toHex(ctBytes),
    until,
  };
}

/**
 * Viewer side: Decrypts an encrypted viewing key using viewer's private key `viewerSk`.
 */
export async function decryptGrantedViewingKey(
  viewerSk: bigint,
  ephemeralEkHex: Hex,
  encryptedVkHex: Hex,
): Promise<bigint | undefined> {
  try {
    const babyJub = await getBabyJub();
    const poseidon = await getPoseidon();
    const F = babyJub.F;

    const ephBytes = hexToBytes(ephemeralEkHex);
    if (ephBytes.length < 64) return undefined;
    const ephX = bytesToBigint(ephBytes.slice(0, 32));
    const ephY = bytesToBigint(ephBytes.slice(32, 64));

    const sharedPoint = babyJub.mulPointEscalar([F.e(ephX), F.e(ephY)], viewerSk);
    const sharedX = F.toObject(sharedPoint[0]) as bigint;
    const sharedY = F.toObject(sharedPoint[1]) as bigint;

    const symmetricKey = bigintToBytes32(poseidon.F.toObject(poseidon([sharedX, sharedY])) as bigint).slice(0, 32);

    const ctBytes = hexToBytes(encryptedVkHex);
    if (ctBytes.length < 12 + 32) return undefined;

    const nonce = ctBytes.slice(0, 12);
    const sealed = ctBytes.slice(12);

    const cipher = chacha20poly1305(symmetricKey, nonce);
    const decrypted = cipher.decrypt(sealed);

    return bytesToBigint(decrypted);
  } catch {
    return undefined;
  }
}
