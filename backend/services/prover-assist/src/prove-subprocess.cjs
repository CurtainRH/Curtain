// Standalone Node script (NOT run under Bun) that generates a Groth16
// proof for any circuit given an input JSON file — same rationale as
// @curtain/sdk's prove-subprocess.cjs and services/ppoi-node's: snarkjs
// behaves differently under Bun than Node for these circuits, and
// snarkjs/circom_runtime never exits its own process on completion, so
// process.exit(0) is required after the result is written.
const fs = require("fs");
const snarkjs = require("snarkjs");

async function main() {
  const [, , inputPath, outputPath, wasmPath, zkeyPath] = process.argv;
  const input = JSON.parse(fs.readFileSync(inputPath, "utf-8"));

  // Raw snarkjs proof format (pi_a/pi_b/pi_c), NOT Solidity calldata — the
  // caller (a wallet submitting on-chain) is responsible for that
  // conversion via snarkjs.groth16.exportSolidityCallData, same as
  // @curtain/sdk's own prover.ts does. Returning the raw format here keeps
  // this output directly verifiable with snarkjs.groth16.verify, which the
  // Solidity-calldata reordering is not.
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

  fs.writeFileSync(outputPath, JSON.stringify({ proof, publicSignals }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
