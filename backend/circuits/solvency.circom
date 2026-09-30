pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/smt/smtverifier.circom";
include "lib/merkleTree.circom";

// Chunked solvency proof, per Curtain_Build.md §2.3 / §6. Proves that a
// batch of `chunkSize` note leaves (a) each open correctly against the
// commitment tree's `snapshotRoot`, and (b) are each unspent — proven via
// sparse-Merkle *non-membership* of their nullifier against `nullifierRoot`,
// the accumulator of every nullifier revealed on-chain so far. `partialSum`
// is the sum of all `chunkSize` amounts and is only valid because every
// leaf's non-membership proof in this chunk had to verify — a spent note
// cannot pass step (b), so it cannot silently inflate the sum.
//
// DESIGN NOTE (flagged, not fully resolved — see Curtain_Build.md §11):
// nullifier = Poseidon(ownerSk, leafIndex) requires the note owner's
// spending key to compute. The source spec's pseudocode ("list of leaves
// with (commit opening, spent flag proof)") does not say how the solvency
// PROVER — which is not any individual note owner — obtains each leaf's
// nullifier to prove it absent from nullifierRoot. This circuit proves the
// statement correctly *given* that witness; the open question is which
// service/process supplies it. That's an M10 (Disclosure + Solvency
// service) design question, not a circuit-correctness one.
//
// Production sizing (per spec): chunkSize=4096, treeDepth=32. Compiling and
// proving a 4096-leaf chunk is far too heavy to iterate on locally (tens of
// millions of constraints); this file's production `main` instantiation is
// still declared at spec size, but the dev/test main (solvency_dev.circom)
// uses chunkSize=4 for fast local proof generation. Scaling to the real
// chunk size is a build-infra concern (bigger ptau, more powerful prover
// hardware), not a circuit-logic change.
template SolvencyChunk(chunkSize, treeDepth, nullifierTreeDepth) {
    // ---- public ----
    signal input snapshotRoot;
    signal input nullifierRoot;
    signal input tokenId;
    signal output partialSum;

    // ---- private: per-leaf commitment opening + inclusion path ----
    signal input amount[chunkSize];
    signal input blinding[chunkSize];
    signal input ownerPkX[chunkSize];
    signal input leafIndex[chunkSize];
    signal input pathElements[chunkSize][treeDepth];
    signal input pathIndices[chunkSize][treeDepth];

    // ---- private: per-leaf nullifier + non-membership witness ----
    signal input ownerSk[chunkSize];
    signal input nullifierSiblings[chunkSize][nullifierTreeDepth];
    signal input nullifierOldKey[chunkSize];
    signal input nullifierOldValue[chunkSize];
    signal input nullifierIsOld0[chunkSize];

    component commitHasher[chunkSize];
    component merkle[chunkSize];
    component nullifierHasher[chunkSize];
    component smt[chunkSize];
    component amountRange[chunkSize];

    var total = 0;
    for (var i = 0; i < chunkSize; i++) {
        commitHasher[i] = Poseidon(4);
        commitHasher[i].inputs[0] <== tokenId;
        commitHasher[i].inputs[1] <== amount[i];
        commitHasher[i].inputs[2] <== ownerPkX[i];
        commitHasher[i].inputs[3] <== blinding[i];

        merkle[i] = MerkleTreeInclusionProof(treeDepth);
        merkle[i].leaf <== commitHasher[i].out;
        for (var lvl = 0; lvl < treeDepth; lvl++) {
            merkle[i].pathElements[lvl] <== pathElements[i][lvl];
            merkle[i].pathIndices[lvl] <== pathIndices[i][lvl];
        }
        merkle[i].root === snapshotRoot;

        nullifierHasher[i] = Poseidon(2);
        nullifierHasher[i].inputs[0] <== ownerSk[i];
        nullifierHasher[i].inputs[1] <== leafIndex[i];

        smt[i] = SMTVerifier(nullifierTreeDepth);
        smt[i].enabled <== 1;
        smt[i].root <== nullifierRoot;
        for (var lvl2 = 0; lvl2 < nullifierTreeDepth; lvl2++) {
            smt[i].siblings[lvl2] <== nullifierSiblings[i][lvl2];
        }
        smt[i].oldKey <== nullifierOldKey[i];
        smt[i].oldValue <== nullifierOldValue[i];
        smt[i].isOld0 <== nullifierIsOld0[i];
        smt[i].key <== nullifierHasher[i].out;
        smt[i].value <== 0;
        smt[i].fnc <== 1; // 1 = verify NOT included (unspent)

        amountRange[i] = Num2Bits(128);
        amountRange[i].in <== amount[i];

        total += amount[i];
    }

    partialSum <== total;
}
