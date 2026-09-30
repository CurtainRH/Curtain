// M2/M4 acceptance test: generates a real witness + Groth16 proof for the
// joinsplit2x2 circuit, verifies it, and times the wasm proving step
// against the "<8s desktop" bar in Curtain_Build.md's M2 acceptance row.
//
// Builds two independent tiny depth-32 Poseidon Merkle trees — the main
// deposit tree and the M4 "cleared" tree (see joinsplit.circom's header) —
// each with the same two commitments at different leaf indices, to
// demonstrate the two membership proofs are genuinely independent.
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");
const { computeZeros, buildSparseTree } = require("./lib/sparseTree.cjs");

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const LEVELS = 32;

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

  const zeros = computeZeros(LEVELS, hash);

  // ---- two input notes ----
  const tokenId = 12345n;
  const ownerSk = [111n, 222n];
  const inAmount = [60n, 40n];
  const inBlinding = [1001n, 1002n];

  const inPkX = ownerSk.map(pubkeyX);
  const inCommit = inAmount.map((amt, i) => hash(tokenId, amt, inPkX[i], inBlinding[i]));
  const nullifiers = ownerSk.map((sk, i) => hash(sk, BigInt(i)));

  // Main deposit tree: both notes shielded at indices 0 and 1.
  const mainTree = buildSparseTree(
    new Map([[0, inCommit[0]], [1, inCommit[1]]]),
    LEVELS, zeros, hash,
  );
  const inPathElements = [mainTree.getPath(0).pathElements, mainTree.getPath(1).pathElements];
  const inPathIndices = [mainTree.getPath(0).pathIndices, mainTree.getPath(1).pathIndices];

  // Cleared tree: same two commitments, but at different indices (3 and 7)
  // — they cleared PPOI independently of their shield order, alongside
  // other (irrelevant, zero here) cleared notes.
  const clearedTree = buildSparseTree(
    new Map([[3, inCommit[0]], [7, inCommit[1]]]),
    LEVELS, zeros, hash,
  );
  const inClearedPathElements = [clearedTree.getPath(3).pathElements, clearedTree.getPath(7).pathElements];
  const inClearedPathIndices = [clearedTree.getPath(3).pathIndices, clearedTree.getPath(7).pathIndices];

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
    root: mainTree.root.toString(),
    clearedRoot: clearedTree.root.toString(),
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
    inPathIndices,
    inClearedPathElements: inClearedPathElements.map((row) => row.map(String)),
    inClearedPathIndices,
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

  const outDir = buildDir;
  fs.writeFileSync(path.join(outDir, "test_input.json"), JSON.stringify(input, null, 2));
  fs.writeFileSync(path.join(outDir, "test_proof.json"), JSON.stringify(proof, null, 2));
  fs.writeFileSync(path.join(outDir, "test_public.json"), JSON.stringify(publicSignals, null, 2));
  fs.writeFileSync(path.join(outDir, "test_calldata.txt"), solidityCalldata);

  console.log("\n=== M2/M4 acceptance summary (joinsplit 2x2) ===");
  console.log(`Proof generated: yes`);
  console.log(`Proof verified:  ${ok}`);
  console.log(`Public signals:  ${publicSignals.length} (expect 11: root, clearedRoot, 2 nullifiers, 2 newCommitments, tokenId, unshieldAmount, unshieldTo, feeAmount, extDataHash)`);
  console.log(`Proving time:    ${proveMs.toFixed(0)}ms (target: < 8000ms)`);
  console.log(`PASS: ${ok && proveMs < 8000 && publicSignals.length === 11}`);

  if (!ok || proveMs >= 8000 || publicSignals.length !== 11) process.exit(1);
  process.exit(0); // snarkjs leaves the process alive otherwise — see prove-ppoi-subprocess.cjs's header
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
