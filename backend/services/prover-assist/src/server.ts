/**
 * POST /prove/{circuit} per Curtain_Build.md §4.3, plus GET /attestation so
 * a client can fetch+verify this session's attestation before sending
 * anything. One EnclaveSession per server process for now — each session's
 * key is used for every request until the process restarts; rotating a
 * fresh session per request (or on a timer) is a small follow-up once a
 * real deployment target exists, not a structural change.
 */
import { join } from "node:path";
import { EnclaveSession } from "./enclave";
import { proveGroth16 } from "./prover";
import type { EncryptedPayload } from "./crypto";

const CIRCUITS_BUILD = join(import.meta.dir, "../../../circuits/build");

const SUPPORTED_CIRCUITS = new Set(["joinsplit2x2", "joinsplit3x3", "unshield"]);

function circuitPaths(circuit: string): { wasmPath: string; zkeyPath: string } {
  return {
    wasmPath: join(CIRCUITS_BUILD, circuit, `${circuit}_js`, `${circuit}.wasm`),
    zkeyPath: join(CIRCUITS_BUILD, circuit, `${circuit}_final.zkey`),
  };
}

interface ProveRequestBody {
  publicInputs: Record<string, unknown>;
  encryptedPrivateWitness: EncryptedPayload;
}

export function createProverAssistServer(port: number, session: EnclaveSession = new EnclaveSession()) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json({ ok: true });
      }

      if (url.pathname === "/attestation" && req.method === "GET") {
        return Response.json(session.attestation);
      }

      const proveMatch = url.pathname.match(/^\/prove\/([a-zA-Z0-9_]+)$/);
      if (proveMatch && req.method === "POST") {
        const circuit = proveMatch[1]!;
        if (!SUPPORTED_CIRCUITS.has(circuit)) {
          return Response.json({ error: `unsupported circuit "${circuit}"` }, { status: 404 });
        }

        try {
          const body = (await req.json()) as ProveRequestBody;
          const { wasmPath, zkeyPath } = circuitPaths(circuit);

          const proof = await session.withWitness(body.encryptedPrivateWitness, async (witnessBytes) => {
            const privateWitness = JSON.parse(new TextDecoder().decode(witnessBytes)) as Record<string, unknown>;
            const circuitInput = { ...body.publicInputs, ...privateWitness };
            return proveGroth16(circuitInput, wasmPath, zkeyPath);
          });

          return Response.json({ proof });
        } catch (e) {
          // Deliberately generic: never echo request/witness content back
          // into an error response — see test/prover-assist.e2e.test.ts's
          // "leak harness" for what this is guarding against.
          return Response.json({ error: "proving failed" }, { status: 422 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });
}
