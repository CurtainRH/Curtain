// Standalone Node script (NOT run under Bun), test-only: snarkjs.groth16.verify
// uses the same ffjavascript WASM-backed curve arithmetic as proving, which
// hangs indefinitely under Bun's runtime rather than erroring (same root
// cause as the Bun/circom_runtime incompatibility documented in
// @curtain/sdk's prover.ts and services/ppoi-node's proving subprocess —
// this is the same issue showing up on the verify side instead of prove).
// The actual prover-assist SERVER never calls verify() itself, so this
// workaround is test-only.
const fs = require("fs");
const snarkjs = require("snarkjs");

async function main() {
  const [, , vkeyPath, publicSignalsPath, proofPath, outputPath] = process.argv;
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const publicSignals = JSON.parse(fs.readFileSync(publicSignalsPath, "utf-8"));
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf-8"));

  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  fs.writeFileSync(outputPath, JSON.stringify({ ok }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
