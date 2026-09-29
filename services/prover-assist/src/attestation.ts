/**
 * Attestation, per Curtain_Build.md §4.3: "run prover-assist inside a CPU
 * TEE (TDX) with attestation; client verifies attestation before sending."
 *
 * MOCK, NOT REAL TDX (see this repo's README/Curtain_Build.md §11 for the
 * deferral): a genuine implementation needs actual TDX-capable hardware
 * (e.g. an Azure DCasv5 confidential VM) to produce a real Intel DCAP
 * quote, and neither this dev environment nor CI has that. What's built
 * here is structurally faithful to the real flow so swapping in real
 * verification later is a contained change, not a redesign:
 *
 *   REAL TDX/DCAP                          MOCK (this file)
 *   ---------------------------------      ---------------------------------
 *   Intel-signed root cert chain           MOCK_ROOT_PUBLIC_KEY (a fixed,
 *                                           hardcoded keypair "playing the
 *                                           part" of Intel's root of trust)
 *   MRENCLAVE (hash of the loaded          EXPECTED_MEASUREMENT (a fixed
 *   enclave image, hardware-measured)      hash both client and server
 *                                          agree represents "trusted code")
 *   Hardware-generated quote signed by     A plain ECDSA signature over the
 *   the platform's attested key            same fields, from a plain key
 *
 * Whoever holds MOCK_ROOT_PRIVATE_KEY can forge attestations — that's
 * exactly the property real hardware attestation exists to remove. This
 * mock only proves the PROTOCOL shape (verify-before-send, short-lived
 * ephemeral keys, measurement pinning) works end to end; it provides none
 * of TDX's actual security guarantee. Never deploy this mock as if it were
 * real attestation.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as rawBytesToHex, hexToBytes as rawHexToBytes, concatBytes } from "@noble/curves/utils.js";

export type Hex = `0x${string}`;

// @noble/curves' bytesToHex/hexToBytes work on bare hex (no "0x" prefix) —
// this file (and crypto.ts) standardize on "0x"-prefixed hex everywhere
// else in this codebase, so every conversion goes through these two
// instead of the raw noble functions directly.
export function toHex(bytes: Uint8Array): Hex {
  return `0x${rawBytesToHex(bytes)}`;
}
export function fromHex(hex: string): Uint8Array {
  return rawHexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}

export interface AttestationDocument {
  /** Ephemeral, one-time public key the client must encrypt its witness to — rotated per session (see enclave.ts). */
  enclavePublicKey: Hex;
  /** Mock MRENCLAVE — see this file's header. */
  measurement: Hex;
  issuedAt: number;
  expiresAt: number;
  signature: Hex;
}

// Fixed mock "platform root key" — deterministic so both the server (signs)
// and any client (verifies) agree on it without a real cert chain to fetch.
// Real TDX replaces this entire concept with Intel's published root certs.
const MOCK_ROOT_SEED = sha256(new TextEncoder().encode("curtain/prover-assist/mock-tdx-root/v1"));
export const MOCK_ROOT_PRIVATE_KEY: Uint8Array = MOCK_ROOT_SEED;
export const MOCK_ROOT_PUBLIC_KEY: Hex = toHex(secp256k1.getPublicKey(MOCK_ROOT_PRIVATE_KEY, true));

// A fixed stand-in for "the hash of the enclave code we trust to be running".
// Real TDX measures this from the actual loaded binary in hardware; here
// it's just a constant both sides check against.
export const EXPECTED_MEASUREMENT: Hex = toHex(sha256(new TextEncoder().encode("curtain/prover-assist/v0.0.1")));

export const ATTESTATION_TTL_MS = 5 * 60 * 1000; // short-lived, matches real quotes' freshness requirement

/**
 * secp256k1.sign()'s "compact" format serializes r/s as their minimal
 * big-endian byte length, so a component with a leading zero byte
 * occasionally (~1/256 chance each) produces a 63- rather than 64-byte
 * signature — noble-curves doesn't left-pad compact output to a fixed
 * width. Retrying with a fresh nonce until both components land at their
 * full 32 bytes is the simplest correct fix (verify() requires exactly 64
 * bytes) and terminates in an expected 1-2 attempts.
 */
function signCompact64(digest: Uint8Array, privateKey: Uint8Array): Uint8Array {
  for (let i = 0; i < 16; i++) {
    const sig = secp256k1.sign(digest, privateKey, { extraEntropy: true });
    if (sig.length === 64) return sig;
  }
  throw new Error("could not produce a fixed-length signature after 16 attempts");
}

function attestationDigest(doc: Omit<AttestationDocument, "signature">): Uint8Array {
  const encoder = new TextEncoder();
  return sha256(
    concatBytes(
      fromHex(doc.enclavePublicKey),
      fromHex(doc.measurement),
      encoder.encode(String(doc.issuedAt)),
      encoder.encode(String(doc.expiresAt)),
    ),
  );
}

/** Server side: produces a signed attestation binding this session's ephemeral enclave key to the (mock) trusted measurement. */
export function createAttestation(enclavePublicKey: Hex): AttestationDocument {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ATTESTATION_TTL_MS;
  const unsigned = { enclavePublicKey, measurement: EXPECTED_MEASUREMENT, issuedAt, expiresAt };
  const digest = attestationDigest(unsigned);
  const signature = signCompact64(digest, MOCK_ROOT_PRIVATE_KEY);
  return { ...unsigned, signature: toHex(signature) };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Client side: verifies an attestation document before trusting its
 * enclavePublicKey with anything. Checks (mirroring what a real DCAP
 * verifier checks): signature validity against the trusted root, that the
 * measurement matches the expected (trusted) code hash, and freshness.
 */
export function verifyAttestation(doc: AttestationDocument, now: number = Date.now()): VerifyResult {
  if (doc.measurement.toLowerCase() !== EXPECTED_MEASUREMENT.toLowerCase()) {
    return { ok: false, reason: "measurement does not match expected enclave code" };
  }
  if (now < doc.issuedAt || now > doc.expiresAt) {
    return { ok: false, reason: "attestation expired or not yet valid" };
  }
  const digest = attestationDigest(doc);
  const sigBytes = fromHex(doc.signature);
  const valid = secp256k1.verify(sigBytes, digest, fromHex(MOCK_ROOT_PUBLIC_KEY));
  if (!valid) return { ok: false, reason: "signature does not verify against the trusted root key" };
  return { ok: true };
}
