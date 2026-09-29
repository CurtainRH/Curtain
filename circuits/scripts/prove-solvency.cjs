// M2 proof-gen/verify vector for the solvency circuit (dev instantiation,
// chunkSize=4 — see solvency.circom's header for why). Builds a snapshot
// tree with 4 real note leaves and an empty nullifier SMT (i.e. none of
// them have been spent yet), proving Σamounts == partialSum.
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");

async function main() {
  const { buildPoseidon, newMemEmptyTrie } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (x) => F.toObject(x);
  const hash = (...inputs) => toField(poseidon(inputs));

  const TREE_DEPTH = 32;
  const NULL_DEPTH = 32;
  const CHUNK = 4;

  const zeros = [0n];
  for (let i = 1; i <= TREE_DEPTH; i++) zeros.push(hash(zeros[i - 1], zeros[i - 1]));

  const tokenId = 55n;
  const amount = [10n, 20n, 30n, 40n];
  const blinding = [1n, 2n, 3n, 4n];
  const ownerPkX = [100n, 200n, 300n, 400n];
  const ownerSk = [11n, 22n, 33n, 44n];

  const commits = amount.map((a, i) => hash(tokenId, a, ownerPkX[i], blinding[i]));

  // Build a 4-leaf snapshot tree (indices 0..3), rest zero.
  function pairUp(level) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hash(level[i], level[i + 1]));
    return next;
  }
  let level = commits;
  const levels = [level];
  while (level.length > 1) {
    level = pairUp(level);
    levels.push(level);
  }
  // levels[0] = leaves (4), levels[1] = 2 nodes, levels[2] = 1 node (root of the 4-leaf subtree)
  let snapshotRoot = levels[levels.length - 1][0];
  for (let i = 2; i < TREE_DEPTH; i++) snapshotRoot = hash(snapshotRoot, zeros[i]);

  function pathFor(leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    let idx = leafIndex;
    for (let d = 0; d < levels.length - 1; d++) {
      const levelNodes = levels[d];
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(levelNodes[siblingIdx]);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    for (let d = levels.length - 1; d < TREE_DEPTH; d++) {
      pathElements.push(zeros[d]);
      pathIndices.push(0);
    }
    return { pathElements, pathIndices };
  }

  const paths = [0, 1, 2, 3].map(pathFor);

  // Empty nullifier tree — none of these 4 notes have been spent.
  const nullSmt = await newMemEmptyTrie();
  const nullifiers = ownerSk.map((sk, i) => hash(sk, BigInt(i)));

  async function nonMembership(key) {
    const res = await nullSmt.find(key);
    if (res.found) throw new Error("nullifier unexpectedly already spent");
    const siblings = res.siblings.map((s) => nullSmt.F.toObject(s));
    while (siblings.length < NULL_DEPTH) siblings.push(0n);
    return {
      siblings,
      oldKey: res.isOld0 ? 0n : nullSmt.F.toObject(res.notFoundKey),
      oldValue: res.isOld0 ? 0n : nullSmt.F.toObject(res.notFoundValue),
      isOld0: res.isOld0 ? 1n : 0n,
    };
  }

  const nullWitnesses = await Promise.all(nullifiers.map(nonMembership));
  const nullifierRoot = nullSmt.F.toObject(nullSmt.root);

  const input = {
    snapshotRoot: snapshotRoot.toString(),
    nullifierRoot: nullifierRoot.toString(),
    tokenId: tokenId.toString(),
    amount: amount.map(String),
    blinding: blinding.map(String),
    ownerPkX: ownerPkX.map(String),
    leafIndex: ["0", "1", "2", "3"],
    pathElements: paths.map((p) => p.pathElements.map(String)),
    pathIndices: paths.map((p) => p.pathIndices),
    ownerSk: ownerSk.map(String),
    nullifierSiblings: nullWitnesses.map((w) => w.siblings.map(String)),
    nullifierOldKey: nullWitnesses.map((w) => w.oldKey.toString()),
    nullifierOldValue: nullWitnesses.map((w) => w.oldValue.toString()),
    nullifierIsOld0: nullWitnesses.map((w) => w.isOld0.toString()),
  };

  const buildDir = path.resolve(__dirname, "../build/solvency_dev");
  const wasmPath = path.join(buildDir, "solvency_dev_js", "solvency_dev.wasm");
  const zkeyPath = path.join(buildDir, "solvency_dev_final.zkey");
  const vkeyPath = path.join(buildDir, "verification_key.json");

  console.log("Generating witness + Groth16 proof for solvency...");
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const proveMs = performance.now() - t0;
  console.log(`Proving time: ${proveMs.toFixed(0)}ms`);

  const expectedSum = amount.reduce((a, b) => a + b, 0n);
  console.log(`partialSum (public output): ${publicSignals[0]}, expected: ${expectedSum}`);

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Verification result:", ok);

  fs.writeFileSync(path.join(buildDir, "test_input.json"), JSON.stringify(input, null, 2));
  fs.writeFileSync(path.join(buildDir, "test_proof.json"), JSON.stringify(proof, null, 2));
  fs.writeFileSync(path.join(buildDir, "test_public.json"), JSON.stringify(publicSignals, null, 2));

  console.log("\n=== Solvency (dev, chunk=4) proof-gen/verify vector ===");
  console.log(`Proof generated: yes`);
  console.log(`Proof verified:  ${ok}`);
  console.log(`Sum correct:     ${BigInt(publicSignals[0]) === expectedSum}`);
  if (!ok || BigInt(publicSignals[0]) !== expectedSum) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
