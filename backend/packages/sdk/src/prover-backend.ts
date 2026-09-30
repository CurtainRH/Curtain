/**
 * Pluggable Groth16 proving backends for CurtainWallet, per Curtain_Build.md §5's "Proving:
 * wasm (snarkjs) by default on desktop; prover-assist mobile flow: client sends blinded
 * witness, server never learns amounts/owners."
 *
 * Until this file existed, `pool-client.ts` called `proveGroth16` (./prover.ts) directly and
 * unconditionally — which spawns a Node.js child process (`prove-subprocess.cjs`) to work
 * around a Bun/snarkjs-WASM incompatibility. `node:child_process`/`node:fs` don't exist in a
 * browser, so every proof-requiring wallet operation (`send`, `relay`, `unshieldToOrigin`)
 * would simply fail to run in a real browser build of `apps/web` — shield() (no proof
 * needed) and balance display were the only things that actually worked there. This file
 * makes proving pluggable so a browser build can use `ProverAssistBackend` (talks to a real
 * `services/prover-assist` server over plain `fetch`, no Node APIs) instead of
 * `LocalNodeProverBackend` (desktop/CLI/tests, unchanged behavior).
 *
 * `./prover` (and its `node:child_process`/`node:fs` imports) is loaded via a LAZY dynamic
 * `import()` inside `LocalNodeProverBackend.prove()`, never a static top-level import — a
 * static import would pull `node:child_process` into every consumer's module graph
 * unconditionally, which a real browser bundler either fails to resolve at runtime or (as
 * discovered building apps/web's Vite config) silently "externalizes" with only a build-time
 * warning, deferring the actual failure to whenever a user's browser tries to load that
 * chunk. Since a browser build only ever constructs `ProverAssistBackend`, the dynamic
 * import here is simply never triggered, and bundlers correctly code-split it away instead
 * of ever shipping it to the browser at all.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Groth16Proof } from "./prover";

export interface CircuitPaths {
  wasm: string;
  zkey: string;
}

export type CircuitName = "joinsplit2x2" | "unshield";

export interface ProverBackend {
  prove(circuit: CircuitName, circuitInput: Record<string, unknown>): Promise<Groth16Proof>;
}

/** Desktop/CLI/test backend — unchanged behavior, wraps the existing local Node-subprocess prover. */
export class LocalNodeProverBackend implements ProverBackend {
  constructor(private paths: { joinsplit2x2: CircuitPaths; unshield: CircuitPaths }) {}

  async prove(circuit: CircuitName, circuitInput: Record<string, unknown>): Promise<Groth16Proof> {
    const p = this.paths[circuit];
    const { proveGroth16 } = await import("./prover");
    return proveGroth16(circuitInput, p.wasm, p.zkey);
  }
}

// ---- prover-assist ECIES client (mirrors services/prover-assist/src/crypto.ts and
// attestation.ts exactly — duplicated rather than cross-imported since services/ aren't
// meant to be library dependencies of packages/, and the primitives are a handful of pure
// functions, not worth a shared-package refactor for this alone). ----

type Hex = `0x${string}`;
function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}
function fromHex(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}

export interface AttestationDocument {
  enclavePublicKey: Hex;
  measurement: Hex;
  issuedAt: number;
  expiresAt: number;
  signature: Hex;
}

// Must match services/prover-assist/src/attestation.ts's MOCK_ROOT_PUBLIC_KEY/EXPECTED_MEASUREMENT
// exactly — see that file's header on why this is a mock, not real TDX/DCAP, and what
// swapping in real hardware attestation later would change (only these two constants and
// the signature-verification call below, not this file's protocol shape).
const MOCK_ROOT_SEED = sha256(new TextEncoder().encode("curtain/prover-assist/mock-tdx-root/v1"));
const MOCK_ROOT_PUBLIC_KEY: Hex = toHex(secp256k1.getPublicKey(MOCK_ROOT_SEED, true));
const EXPECTED_MEASUREMENT: Hex = toHex(sha256(new TextEncoder().encode("curtain/prover-assist/v0.0.1")));

function attestationDigest(doc: Omit<AttestationDocument, "signature">): Uint8Array {
  const encoder = new TextEncoder();
  const parts = [fromHex(doc.enclavePublicKey), fromHex(doc.measurement), encoder.encode(String(doc.issuedAt)), encoder.encode(String(doc.expiresAt))];
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { total.set(p, offset); offset += p.length; }
  return sha256(total);
}

function verifyAttestation(doc: AttestationDocument, now: number = Date.now()): { ok: boolean; reason?: string } {
  if (doc.measurement.toLowerCase() !== EXPECTED_MEASUREMENT.toLowerCase()) {
    return { ok: false, reason: "measurement does not match expected enclave code" };
  }
  if (now < doc.issuedAt || now > doc.expiresAt) {
    return { ok: false, reason: "attestation expired or not yet valid" };
  }
  const digest = attestationDigest(doc);
  const valid = secp256k1.verify(fromHex(doc.signature), digest, fromHex(MOCK_ROOT_PUBLIC_KEY));
  if (!valid) return { ok: false, reason: "signature does not verify against the trusted root key" };
  return { ok: true };
}

interface EncryptedPayload {
  ephemeralPublicKey: Hex;
  nonce: Hex;
  ciphertext: Hex;
}

const WITNESS_HKDF_INFO = new TextEncoder().encode("curtain/prover-assist/witness-encryption/v1");

function encryptToEnclave(enclavePublicKey: Hex, plaintext: Uint8Array): EncryptedPayload {
  const ephemeralPrivateKey = secp256k1.utils.randomSecretKey();
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralPrivateKey, true);
  const sharedPoint = secp256k1.getSharedSecret(ephemeralPrivateKey, fromHex(enclavePublicKey), true);
  const key = hkdf(sha256, sharedPoint, undefined, WITNESS_HKDF_INFO, 32);

  const nonce = randomBytes(12);
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return { ephemeralPublicKey: toHex(ephemeralPublicKey), nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
}

/**
 * Splits a circuit's full input object into its public and private fields — the private
 * fields are exactly what must never leave this device unencrypted. `inOwnerSk`/`ownerSk`
 * (the wallet's long-term spending key) is the single most sensitive field here: leaking it
 * anywhere compromises every note the wallet has ever held or will hold (see keys.ts's
 * header), which is exactly what this encrypted-witness protocol exists to prevent even from
 * the server doing the proving.
 */
const PRIVATE_FIELDS: Record<CircuitName, readonly string[]> = {
  joinsplit2x2: [
    "inAmount", "inBlinding", "inLeafIndex", "inOwnerSk",
    "inPathElements", "inPathIndices", "inClearedPathElements", "inClearedPathIndices",
    "outAmount", "outBlinding", "outOwnerPkX",
  ],
  unshield: ["ownerSk"],
};

/**
 * Groth16 proof calldata formatting — converts snarkjs's raw `{pi_a, pi_b, pi_c}` proof
 * object into the `{a, b, c}` shape CurtainPool's verifiers expect (the standard Groth16
 * Solidity-verifier calldata convention: `b`'s two G2 coordinate pairs are swapped relative
 * to snarkjs's internal representation). Implemented directly rather than depending on
 * `snarkjs.groth16.exportSolidityCallData` so a browser bundle never needs to pull in
 * snarkjs's much heavier WASM witness-calculation machinery just for this trivial reshaping.
 */
function formatGroth16Calldata(proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): Pick<Groth16Proof, "a" | "b" | "c"> {
  return {
    a: [proof.pi_a[0]!, proof.pi_a[1]!],
    b: [
      [proof.pi_b[0]![1]!, proof.pi_b[0]![0]!],
      [proof.pi_b[1]![1]!, proof.pi_b[1]![0]!],
    ],
    c: [proof.pi_c[0]!, proof.pi_c[1]!],
  };
}

function toJsonSafe(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = JSON.parse(JSON.stringify(v, (_key, val) => (typeof val === "bigint" ? val.toString() : val)));
  }
  return out;
}

/**
 * Browser/mobile-safe proving backend: fetches and verifies a `services/prover-assist`
 * server's attestation, encrypts the circuit's private fields to its one-time enclave key,
 * and posts the public fields + encrypted witness to `/prove/:circuit`. Uses only `fetch`
 * and pure-JS crypto (`@noble/*`) — no Node APIs — so it works unmodified in a browser bundle.
 */
export class ProverAssistBackend implements ProverBackend {
  constructor(private baseUrl: string) {}

  async prove(circuit: CircuitName, circuitInput: Record<string, unknown>): Promise<Groth16Proof> {
    const attestationRes = await fetch(`${this.baseUrl}/attestation`);
    if (!attestationRes.ok) throw new Error(`prover-assist: failed to fetch attestation (${attestationRes.status})`);
    const attestation = (await attestationRes.json()) as AttestationDocument;

    const verified = verifyAttestation(attestation);
    if (!verified.ok) throw new Error(`prover-assist: attestation rejected (${verified.reason})`);

    const privateKeys = PRIVATE_FIELDS[circuit];
    const input = toJsonSafe(circuitInput);
    const publicInputs: Record<string, unknown> = {};
    const privateWitness: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      (privateKeys.includes(k) ? privateWitness : publicInputs)[k] = v;
    }

    const encryptedPrivateWitness = encryptToEnclave(attestation.enclavePublicKey, new TextEncoder().encode(JSON.stringify(privateWitness)));

    const proveRes = await fetch(`${this.baseUrl}/prove/${circuit}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicInputs, encryptedPrivateWitness }),
    });
    if (!proveRes.ok) {
      const body = await proveRes.json().catch(() => ({}));
      throw new Error(`prover-assist: proving failed (${proveRes.status}): ${(body as { error?: string }).error ?? "unknown error"}`);
    }
    const { proof } = (await proveRes.json()) as { proof: { proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] } };

    return { ...formatGroth16Calldata(proof.proof), publicSignals: proof.publicSignals };
  }
}
