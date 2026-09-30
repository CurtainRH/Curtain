/**
 * Password-encrypted local storage for a Curtain wallet's 32-byte seed. The seed itself
 * (via @curtain/sdk's deriveWalletKeys) is what controls every shielded note the wallet
 * holds — storing it in localStorage as plaintext, even behind "just don't inspect
 * devtools," is not an acceptable bar for anything holding real funds. This wraps it with
 * scrypt (deliberately memory-hard, to raise the cost of a brute-force GPU/ASIC attack on a
 * stolen encrypted blob well above a plain PBKDF2/SHA-256 hash) + ChaCha20-Poly1305, both
 * already-vetted primitives this codebase uses elsewhere (keys.ts's HKDF, notes.ts's note
 * encryption).
 *
 * This is still a REFERENCE-GRADE keystore, not a hardened production wallet: there's no
 * hardware-key/secure-enclave binding, no auto-lock timer, and a compromised browser tab can
 * still read the decrypted seed from memory while unlocked (this is a limitation of any
 * browser-based key custody model, not something this file's crypto choices could fix).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { randomBytes } from "@noble/hashes/utils.js";

const STORAGE_KEY = "curtain.keystore.v1";
const SCRYPT_N = 2 ** 17; // ~128 MiB, ~0.3-0.5s on typical hardware — deliberately expensive
const SCRYPT_R = 8;
const SCRYPT_P = 1;

interface StoredKeystore {
  salt: string; // hex
  nonce: string; // hex
  ciphertext: string; // hex
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(new TextEncoder().encode(password), salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: 32 });
}

export function hasStoredKeystore(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function saveEncryptedSeed(seed: Uint8Array, password: string): void {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveKey(password, salt);
  const ciphertext = chacha20poly1305(key, nonce).encrypt(seed);
  const stored: StoredKeystore = { salt: toHex(salt), nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export class WrongPasswordError extends Error {
  constructor() {
    super("incorrect password (or corrupted keystore)");
  }
}

export function loadEncryptedSeed(password: string): Uint8Array {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error("no keystore found in this browser");
  const stored = JSON.parse(raw) as StoredKeystore;
  const key = deriveKey(password, fromHex(stored.salt));
  try {
    return chacha20poly1305(key, fromHex(stored.nonce)).decrypt(fromHex(stored.ciphertext));
  } catch {
    // ChaCha20-Poly1305's authentication tag check fails closed on a wrong key — this is
    // the expected, safe outcome of a wrong password, not a bug to work around.
    throw new WrongPasswordError();
  }
}

export function clearKeystore(): void {
  localStorage.removeItem(STORAGE_KEY);
}
