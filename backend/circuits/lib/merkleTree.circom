pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/mux1.circom";

// Verifies that `leaf` is included in a depth-`levels` incremental Poseidon
// Merkle tree with the given `root`, following `pathIndices` (0 = leaf is
// the left child at that level, 1 = right child) and `pathElements`
// (the sibling hash at each level). Matches Curtain_Build.md §1: "Merkle
// tree: Incremental, depth 32, Poseidon".
template MerkleTreeInclusionProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component muxLeft[levels];
    component muxRight[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        // pathIndices[i] must be boolean.
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxLeft[i] = Mux1();
        muxLeft[i].c[0] <== levelHashes[i];
        muxLeft[i].c[1] <== pathElements[i];
        muxLeft[i].s <== pathIndices[i];

        muxRight[i] = Mux1();
        muxRight[i].c[0] <== pathElements[i];
        muxRight[i].c[1] <== levelHashes[i];
        muxRight[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxLeft[i].out;
        hashers[i].inputs[1] <== muxRight[i].out;

        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}
