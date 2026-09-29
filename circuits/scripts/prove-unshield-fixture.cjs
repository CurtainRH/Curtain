// Generates a real Groth16 proof fixture for UnshieldVerifierAdapter's
// Foundry test suite (contracts/test/pool/UnshieldVerifierAdapter.t.sol):
// proves knowledge of the spending key behind a fixed ownerPkX and the
// nullifier it produces for a fixed leafIndex, per circuits/unshield.circom.
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");

async function main() {
  const { buildPoseidon, buildBabyjub } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const babyJub = await buildBabyjub();
  const F = poseidon.F;
  const toField = (x) => F.toObject(x);
  const hash = (...inputs) => toField(poseidon(inputs));
  const pubkeyX = (sk) => toField(babyJub.mulPointEscalar(babyJub.Base8, sk)[0]);

  const ownerSk = 777n;
  const leafIndex = 5n;
  const ownerPkX = pubkeyX(ownerSk);
  const nullifier = hash(ownerSk, leafIndex);

  const input = {
    ownerPkX: ownerPkX.toString(),
    leafIndex: leafIndex.toString(),
    nullifier: nullifier.toString(),
    ownerSk: ownerSk.toString(),
  };

  const buildDir = path.resolve(__dirname, "../build/unshield");
  const wasmPath = path.join(buildDir, "unshield_js", "unshield.wasm");
  const zkeyPath = path.join(buildDir, "unshield_final.zkey");
  const vkeyPath = path.join(buildDir, "verification_key.json");

  console.log("Generating unshield proof fixture...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Verified:", ok);
  if (!ok) process.exit(1);

  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c, pubSignals] = JSON.parse(`[${calldata}]`);

  const fixture = {
    ownerSk: ownerSk.toString(),
    leafIndex: leafIndex.toString(),
    ownerPkX: ownerPkX.toString(),
    nullifier: nullifier.toString(),
    a, b, c, pubSignals,
  };

  const outPath = path.resolve(__dirname, "../../contracts/test/fixtures/unshield_proof.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(0); // snarkjs leaves the process alive otherwise — see prove-ppoi-subprocess.cjs's header
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
