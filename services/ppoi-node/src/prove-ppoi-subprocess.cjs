// Standalone Node script (NOT run under Bun) that generates a Groth16 proof
// for the ppoi_dev circuit given an input JSON file, writing {a, b, c,
// publicSignals} (the exact Solidity calldata shape) to an output JSON file.
//
// Why a subprocess at all: snarkjs's witness calculator behaves differently
// under Bun than under Node for this circuit — re-running a previously-
// verified-working proof script under `bun` instead of `node` exited
// cleanly (code 0) partway through with no witness and no error, while
// Node completed it correctly. Isolating the actual proving step into a
// plain Node subprocess sidesteps whatever that difference is.
//
// Why `process.exit(0)` at the end: snarkjs/circom_runtime leaves the
// process alive after finishing (a lingering async handle, most likely
// from the WASM instance) — the script's actual work completes and
// `outputPath` gets written correctly, but the process never exits on its
// own, so a caller waiting on the child's `'exit'` event hangs forever even
// though there's nothing left to do. Spent a long debugging session
// chasing this as a Bun/stdio issue before confirming via CPU monitoring
// that the process was idle, not stuck, and the output file already had a
// valid proof in it.
const fs = require("fs");
const snarkjs = require("snarkjs");

async function main() {
  const [, , inputPath, outputPath, wasmPath, zkeyPath] = process.argv;
  const input = JSON.parse(fs.readFileSync(inputPath, "utf-8"));

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c] = JSON.parse(`[${calldata}]`);

  fs.writeFileSync(outputPath, JSON.stringify({ a, b, c, publicSignals }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
