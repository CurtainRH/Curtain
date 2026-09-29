// M2 acceptance test: generates a real witness + Groth16 proof for the
// joinsplit2x2 circuit, verifies it, and times the wasm proving step
// against the "<8s desktop" bar in Curtain_Build.md's M2 acceptance row.
//
// Builds a tiny depth-32 Poseidon Merkle tree with exactly two real leaves
// (everything else zero-filled) — enough to produce a genuine inclusion
// proof without needing the full indexer/service stack M4+ will provide.
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

async function main() {
  const { buildPoseidon, buildBabyjub } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const babyJub = await buildBabyjub();
  const F = poseidon.F;

  const toField = (x) => F.toObject(x);
  const hash = (...inputs) => toField(poseidon(inputs));
  const pubkeyX = (sk) => {
    const point = babyJub.mulPointEscalar(babyJub.Base8, sk);
    return toField(point[0]);
  };

  // ---- zero hashes for an empty depth-32 tree (matches IncrementalMerkleTree.sol) ----
  const LEVELS = 32;
  const zeros = [0n];
  for (let i = 1; i <= LEVELS; i++) zeros.push(hash(zeros[i - 1], zeros[i - 1]));

  // ---- two input notes ----
  const tokenId = 12345n;
  const ownerSk = [111n, 222n];
  const inAmount = [60n, 40n];
  const inBlinding = [1001n, 1002n];

  const inPkX = ownerSk.map(pubkeyX);
  const inCommit = inAmount.map((amt, i) => hash(tokenId, amt, inPkX[i], inBlinding[i]));
  const nullifiers = ownerSk.map((sk, i) => hash(sk, BigInt(i)));

  // leaf0 = inCommit[0] at index 0, leaf1 = inCommit[1] at index 1 — the
  // rest of the tree is empty, so paths are trivial to construct by hand.
  const root = hash(hash(inCommit[0], inCommit[1]), ...[]); // placeholder, replaced below
  let level0Parent = hash(inCommit[0], inCommit[1]);
  let treeRoot = level0Parent;
  for (let i = 1; i < LEVELS; i++) treeRoot = hash(treeRoot, zeros[i]);

  const inPathElements = [
    [inCommit[1], ...Array(LEVELS - 1).fill(0).map((_, i) => zeros[i + 1])],
    [inCommit[0], ...Array(LEVELS - 1).fill(0).map((_, i) => zeros[i + 1])],
  ];
  const inPathIndices = [
    [0, ...Array(LEVELS - 1).fill(0)],
    [1, ...Array(LEVELS - 1).fill(0)],
  ];

  // ---- two output notes + unshield + fee, conserving value: 60+40 = 70+20+5+5 ----
  const outAmount = [70n, 20n];
  const outBlinding = [2001n, 2002n];
  const outOwnerSk = [333n, 444n];
  const outPkX = outOwnerSk.map(pubkeyX);
  const newCommitments = outAmount.map((amt, j) => hash(tokenId, amt, outPkX[j], outBlinding[j]));

  const unshieldAmount = 5n;
  const feeAmount = 5n;
  const unshieldTo = 0xB0Bn;
  const extDataHash = (hash(unshieldTo, unshieldAmount, feeAmount)) % FIELD_SIZE;

  const input = {
    root: treeRoot.toString(),
    nullifiers: nullifiers.map(String),
    newCommitments: newCommitments.map(String),
    tokenId: tokenId.toString(),
    unshieldAmount: unshieldAmount.toString(),
    unshieldTo: unshieldTo.toString(),
    feeAmount: feeAmount.toString(),
    extDataHash: extDataHash.toString(),
    inAmount: inAmount.map(String),
    inBlinding: inBlinding.map(String),
    inLeafIndex: ["0", "1"],
    inOwnerSk: ownerSk.map(String),
    inPathElements: inPathElements.map((row) => row.map(String)),
    inPathIndices: inPathIndices,
    outAmount: outAmount.map(String),
    outBlinding: outBlinding.map(String),
    outOwnerPkX: outPkX.map(String),
  };

  const buildDir = path.resolve(__dirname, "../build/joinsplit2x2");
  const wasmPath = path.join(buildDir, "joinsplit2x2_js", "joinsplit2x2.wasm");
  const zkeyPath = path.join(buildDir, "joinsplit2x2_final.zkey");
  const vkeyPath = path.join(buildDir, "verification_key.json");

  console.log("Generating witness + Groth16 proof...");
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const proveMs = performance.now() - t0;
  console.log(`Proving time: ${proveMs.toFixed(0)}ms`);

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Verification result:", ok);

  const solidityCalldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);

  const outDir = path.resolve(__dirname, "../build/joinsplit2x2");
  fs.writeFileSync(path.join(outDir, "test_input.json"), JSON.stringify(input, null, 2));
  fs.writeFileSync(path.join(outDir, "test_proof.json"), JSON.stringify(proof, null, 2));
  fs.writeFileSync(path.join(outDir, "test_public.json"), JSON.stringify(publicSignals, null, 2));
  fs.writeFileSync(path.join(outDir, "test_calldata.txt"), solidityCalldata);

  console.log("\n=== M2 acceptance summary (joinsplit 2x2) ===");
  console.log(`Proof generated: yes`);
  console.log(`Proof verified:  ${ok}`);
  console.log(`Proving time:    ${proveMs.toFixed(0)}ms (target: < 8000ms)`);
  console.log(`PASS: ${ok && proveMs < 8000}`);

  if (!ok || proveMs >= 8000) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
