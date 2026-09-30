// Standalone Node script (NOT run under Bun) that generates a Groth16
// proof for any circuit given an input JSON file, writing {a, b, c,
// publicSignals} (the exact Solidity calldata shape) to an output JSON
// file. Generic version of services/ppoi-node/src/prove-ppoi-subprocess.cjs
// — same two reasons for existing:
//
// 1. snarkjs's witness calculator behaves differently under Bun than under
//    Node for these circuits (confirmed during M4's ppoi-node work).
// 2. snarkjs/circom_runtime leaves the process alive after finishing (a
//    lingering async handle) — process.exit(0) is required, or a caller
//    waiting on the child's 'exit' event hangs forever even though the
//    proof was already written to disk.
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
