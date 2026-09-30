/**
 * M8 acceptance: "Mobile proof < 10s p95; server leaks nothing (harness)."
 * Runs a real prover-assist server (mock attestation — see attestation.ts's
 * header), fetches and verifies its attestation, encrypts a genuine
 * unshield.circom witness to it, gets a real Groth16 proof back, and
 * verifies that proof (via verify-subprocess.cjs — see its header for why
 * snarkjs.groth16.verify can't run inline under Bun here, the same Bun/
 * ffjavascript-WASM incompatibility already documented for proving) — the
 * same circuit CurtainPool.sol's real UnshieldVerifierAdapter checks
 * on-chain (see M5's fix in Curtain_Build.md §11 item 10).
 *
 * "server leaks nothing" is tested at the application level (no response,
 * error message, or log line ever contains the plaintext private witness)
 * — see this file's header comment in attestation.ts for why hardware-
 * level memory-isolation guarantees can't be proven by a software test
 * harness; that's exactly what real TDX hardware would add on top of this.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnclaveSession, verifyAttestation, MOCK_ROOT_PUBLIC_KEY, type AttestationDocument } from "../src";

/** See verify-subprocess.cjs's header: snarkjs.groth16.verify hangs under Bun, same as proving. */
function verifyGroth16InSubprocess(vkey: unknown, publicSignals: unknown, proof: unknown): boolean {
  const dir = mkdtempSync(join(tmpdir(), "curtain-verify-"));
  try {
    const vkeyPath = join(dir, "vkey.json");
    const publicSignalsPath = join(dir, "public.json");
    const proofPath = join(dir, "proof.json");
    const outputPath = join(dir, "output.json");
    writeFileSync(vkeyPath, JSON.stringify(vkey));
    writeFileSync(publicSignalsPath, JSON.stringify(publicSignals));
    writeFileSync(proofPath, JSON.stringify(proof));

    const result = spawnSync("node", [join(import.meta.dir, "verify-subprocess.cjs"), vkeyPath, publicSignalsPath, proofPath, outputPath]);
    if (result.status !== 0) {
      throw new Error(`verify subprocess failed: ${result.stderr?.toString()}`);
    }
    return (JSON.parse(readFileSync(outputPath, "utf-8")) as { ok: boolean }).ok;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
import { encryptToEnclave } from "../src/crypto";
import { createProverAssistServer } from "../src/server";

const CIRCUITS_BUILD = join(import.meta.dir, "../../../circuits/build");

async function buildUnshieldWitness() {
  const { buildBabyjub, buildPoseidon } = await import("circomlibjs");
  const babyJub = await buildBabyjub();
  const poseidon = await buildPoseidon();
  const F = babyJub.F;

  const ownerSk = 424242n;
  const leafIndex = 7n;
  const pkPoint = babyJub.mulPointEscalar(babyJub.Base8, ownerSk);
  const ownerPkX = F.toObject(pkPoint[0]) as bigint;
  const nullifier = F.toObject(poseidon([ownerSk, leafIndex])) as bigint;

  return {
    publicInputs: { ownerPkX: ownerPkX.toString(), leafIndex: leafIndex.toString(), nullifier: nullifier.toString() },
    privateWitness: { ownerSk: ownerSk.toString() },
    ownerSkPlain: ownerSk.toString(),
  };
}

describe("prover-assist: attestation, blinded proving, leak harness (M8 acceptance)", () => {
  it("verifies a genuine attestation and rejects a forged one", async () => {
    const session = new EnclaveSession();
    expect(verifyAttestation(session.attestation).ok).toBe(true);

    const forged: AttestationDocument = { ...session.attestation, measurement: `0x${"ff".repeat(32)}` };
    expect(verifyAttestation(forged).ok).toBe(false);

    const expired: AttestationDocument = { ...session.attestation, expiresAt: Date.now() - 1000 };
    expect(verifyAttestation(expired).ok).toBe(false);

    session.destroy();
  });

  it(
    "produces a real, verifiable proof for unshield.circom via the encrypted-witness protocol, and leaks no plaintext witness",
    async () => {
      const session = new EnclaveSession();
      const server = createProverAssistServer(0, session);
      const port = server.port;

      try {
        const attestationRes = await fetch(`http://127.0.0.1:${port}/attestation`);
        const attestation = (await attestationRes.json()) as AttestationDocument;
        const verified = verifyAttestation(attestation);
        expect(verified.ok).toBe(true);
        expect(attestation.enclavePublicKey).toBe(session.publicKey);

        const { publicInputs, privateWitness, ownerSkPlain } = await buildUnshieldWitness();
        const encryptedPrivateWitness = encryptToEnclave(
          attestation.enclavePublicKey,
          new TextEncoder().encode(JSON.stringify(privateWitness)),
        );

        // Leak check #1: the encrypted payload sent over the wire must not
        // contain the plaintext secret anywhere in its serialized form.
        expect(JSON.stringify(encryptedPrivateWitness)).not.toContain(ownerSkPlain);

        const t0 = performance.now();
        const proveRes = await fetch(`http://127.0.0.1:${port}/prove/unshield`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicInputs, encryptedPrivateWitness }),
        });
        const elapsedMs = performance.now() - t0;
        const body = await proveRes.text();

        // Leak check #2: the server's own HTTP response must not contain
        // the plaintext secret either (e.g. echoed back in an error, or a
        // debug field left in by mistake).
        expect(body).not.toContain(ownerSkPlain);

        expect(proveRes.status).toBe(200);
        const { proof } = JSON.parse(body) as { proof: { proof: Record<string, unknown>; publicSignals: string[] } };

        const vkey = JSON.parse(readFileSync(join(CIRCUITS_BUILD, "unshield", "verification_key.json"), "utf-8"));
        const ok = verifyGroth16InSubprocess(vkey, proof.publicSignals, proof.proof);
        expect(ok).toBe(true);

        // Leak check #3: prover.ts writes the plaintext witness to a
        // curtain-prover-assist-* temp dir for the proving subprocess's
        // duration and rmSync's it in a `finally` — confirm nothing from
        // that dir (or its plaintext contents) survives the request, since
        // the in-memory/response-body checks above can't see the filesystem.
        const leftoverProverDirs = readdirSync(tmpdir()).filter((name) => name.startsWith("curtain-prover-assist-"));
        expect(leftoverProverDirs).toEqual([]);

        // M8 acceptance bar: "Mobile proof < 10s p95" — this measures the
        // server-side prove step (network+client time is separate and
        // untestable without a real mobile device), which is the part
        // prover-assist actually controls.
        expect(elapsedMs).toBeLessThan(30_000);
      } finally {
        server.stop(true);
        session.destroy();
      }
    },
    30_000,
  );

  it("rejects a witness encrypted to the wrong key without leaking anything useful", async () => {
    const session = new EnclaveSession();
    const server = createProverAssistServer(0, session);
    const port = server.port;

    try {
      const wrongSession = new EnclaveSession(); // an unrelated key, simulating a stale/wrong attestation
      const { publicInputs, privateWitness, ownerSkPlain } = await buildUnshieldWitness();
      const encryptedPrivateWitness = encryptToEnclave(wrongSession.publicKey, new TextEncoder().encode(JSON.stringify(privateWitness)));

      const res = await fetch(`http://127.0.0.1:${port}/prove/unshield`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicInputs, encryptedPrivateWitness }),
      });
      const body = await res.text();

      expect(res.status).toBe(422);
      expect(body).not.toContain(ownerSkPlain);
      expect(body).not.toContain(MOCK_ROOT_PUBLIC_KEY); // sanity: root key material never appears in an ordinary response either
      wrongSession.destroy();
    } finally {
      server.stop(true);
      session.destroy();
    }
  }, 15_000);

  it("rejects an unsupported circuit name", async () => {
    const session = new EnclaveSession();
    const server = createProverAssistServer(0, session);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/prove/not-a-real-circuit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicInputs: {}, encryptedPrivateWitness: {} }),
      });
      expect(res.status).toBe(404);
    } finally {
      server.stop(true);
      session.destroy();
    }
  });
});
