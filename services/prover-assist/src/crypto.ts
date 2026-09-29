/**
 * ECIES-style encryption of the private witness to the enclave's ephemeral
 * public key, per Curtain_Build.md §4.3 ("the private witness is encrypted
 * to a one-time enclave/prover key"). secp256k1 ECDH + HKDF + ChaCha20-
 * Poly1305 — the same primitive combination @curtain/sdk's notes.ts
 * already uses for note encryption, reused here for consistency rather
 * than introducing a second crypto stack.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { toHex, fromHex, type Hex } from "./attestation";

const HKDF_INFO = new TextEncoder().encode("curtain/prover-assist/witness-encryption/v1");

export interface EncryptedPayload {
  /** Sender's ephemeral public key for this one ciphertext — NOT the enclave's own key. */
  ephemeralPublicKey: Hex;
  nonce: Hex;
  ciphertext: Hex;
}

function deriveSymmetricKey(sharedSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, sharedSecret, undefined, HKDF_INFO, 32);
}

/** Client side: encrypts `plaintext` (the JSON-serialized private witness) to the enclave's public key. */
export function encryptToEnclave(enclavePublicKey: Hex, plaintext: Uint8Array): EncryptedPayload {
  const ephemeralPrivateKey = secp256k1.utils.randomSecretKey();
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralPrivateKey, true);
  const sharedPoint = secp256k1.getSharedSecret(ephemeralPrivateKey, fromHex(enclavePublicKey), true);
  const key = deriveSymmetricKey(sharedPoint);

  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return {
    ephemeralPublicKey: toHex(ephemeralPublicKey),
    nonce: toHex(nonce),
    ciphertext: toHex(ciphertext),
  };
}

/** Server (enclave) side: decrypts a payload using the enclave's ephemeral private key. */
export function decryptFromClient(enclavePrivateKey: Uint8Array, payload: EncryptedPayload): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(enclavePrivateKey, fromHex(payload.ephemeralPublicKey), true);
  const key = deriveSymmetricKey(sharedPoint);
  const cipher = chacha20poly1305(key, fromHex(payload.nonce));
  return cipher.decrypt(fromHex(payload.ciphertext));
}
