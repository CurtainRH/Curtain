/**
 * Wraps prove-subprocess.cjs — see that file's header for why proving runs
 * in a plain Node child process rather than inline under Bun/wasm directly.
 * Corresponds to Curtain_Build.md §5's "Proving: wasm (snarkjs) by default
 * on desktop" — `prover-assist` (mobile, TEE-attested) is a later milestone.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SUBPROCESS_SCRIPT = fileURLToPath(new URL("./prove-subprocess.cjs", import.meta.url));

export interface Groth16Proof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  publicSignals: string[];
}

function toJsonSafe(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = JSON.parse(JSON.stringify(v, (_key, val) => (typeof val === "bigint" ? val.toString() : val)));
  }
  return out;
}

/** Generates a Groth16 proof for `circuitInput` against the given wasm/zkey, via a Node subprocess. */
export async function proveGroth16(
  circuitInput: Record<string, unknown>,
  wasmPath: string,
  zkeyPath: string,
): Promise<Groth16Proof> {
  const dir = mkdtempSync(join(tmpdir(), "curtain-prove-"));
  const inputPath = join(dir, "input.json");
  const outputPath = join(dir, "output.json");
  writeFileSync(inputPath, JSON.stringify(toJsonSafe(circuitInput)));

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
    rmSync(dir, { recursive: true, force: true });
  }
}
