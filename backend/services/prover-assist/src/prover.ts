/**
 * Wraps prove-subprocess.cjs — see that file's header for why proving runs
 * in a plain Node child process rather than inline under Bun.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUBPROCESS_SCRIPT = fileURLToPath(new URL("./prove-subprocess.cjs", import.meta.url));

export interface Groth16Proof {
  proof: Record<string, unknown>; // raw snarkjs proof object (pi_a/pi_b/pi_c/protocol/curve) — see prove-subprocess.cjs's header
  publicSignals: string[];
}

export async function proveGroth16(
  circuitInput: Record<string, unknown>,
  wasmPath: string,
  zkeyPath: string,
): Promise<Groth16Proof> {
  const dir = mkdtempSync(join(tmpdir(), "curtain-prover-assist-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(inputPath, JSON.stringify(circuitInput));

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("node", [SUBPROCESS_SCRIPT, inputPath, outputPath, wasmPath, zkeyPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`prove subprocess exited ${code}: ${stderr}`))));
    });

    return JSON.parse(readFileSync(outputPath, "utf-8")) as Groth16Proof;
  } finally {
    // Input file held the plaintext witness on disk for the subprocess's
    // duration — remove it immediately after, same "discard after proof"
    // discipline as the in-memory copy (enclave.ts's withWitness).
    rmSync(dir, { recursive: true, force: true });
  }
}
