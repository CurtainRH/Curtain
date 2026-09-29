// Generates a plain (non-ZK) Merkle inclusion proof fixture for
// ScreeningGate.flag()'s test: proves a specific address is included in a
// provider's published flagRoot, using the same depth-32 Poseidon tree
// convention as everywhere else (IncrementalMerkleTree.sol / merkleTree.circom).
const path = require("path");
const fs = require("fs");
const { computeZeros, buildSparseTree } = require("./lib/sparseTree.cjs");

const LEVELS = 32;
// Matches the Foundry test's `bob` address it wants to prove listed.
const FLAGGED_ADDR = 0xB0Bn;

async function main() {
  const { buildPoseidon } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (x) => F.toObject(x);
  const hash = (...inputs) => toField(poseidon(inputs));

  const zeros = computeZeros(LEVELS, hash);

  // A small flagged-address list; FLAGGED_ADDR sits at index 2 alongside
  // some unrelated entries.
  const tree = buildSparseTree(
    new Map([
      [0, 0x1111n],
      [2, FLAGGED_ADDR],
      [5, 0x2222n],
    ]),
    LEVELS, zeros, hash,
  );
  const { pathElements, pathIndices } = tree.getPath(2);

  const fixture = {
    flaggedAddr: "0x" + FLAGGED_ADDR.toString(16).padStart(40, "0"),
    flagRoot: "0x" + tree.root.toString(16).padStart(64, "0"),
    pathElements: pathElements.map((e) => "0x" + e.toString(16).padStart(64, "0")),
    pathIndices,
  };

  const outPath = path.resolve(__dirname, "../../contracts/test/fixtures/flag_proof.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log("flagRoot:", fixture.flagRoot);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
