pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/babyjub.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";
include "lib/merkleTree.circom";

// UTXO join-split, per Curtain_Build.md §2.1. Single token per proof;
// multi-token spends are multiple proofs in one tx via transactBatch.
//
// Note commitment: C = Poseidon(tokenId, rawAmount, ownerPk_x, blinding)
// Nullifier:        N = Poseidon(ownerSk, leafIndex)
//
// `feeAmount` is a public input (not hardcoded) so the fee bps can move
// within governance's allowed range [0.10%, 0.30%] without recompiling the
// circuit — the contract is responsible for checking feeAmount against the
// currently governed rate; this circuit only enforces conservation.
template JoinSplit(nIns, nOuts, merkleDepth) {
    // ---- public inputs ----
    signal input root;
    signal input nullifiers[nIns];
    signal input newCommitments[nOuts];
    signal input tokenId;
    signal input unshieldAmount;
    signal input unshieldTo;
    signal input feeAmount;
    signal input extDataHash; // binds unshieldTo/calls/broadcaster fee — see header note

    // ---- private inputs: spent notes ----
    signal input inAmount[nIns];
    signal input inBlinding[nIns];
    signal input inLeafIndex[nIns];
    signal input inOwnerSk[nIns];
    signal input inPathElements[nIns][merkleDepth];
    signal input inPathIndices[nIns][merkleDepth];

    // ---- private inputs: new notes ----
    signal input outAmount[nOuts];
    signal input outBlinding[nOuts];
    signal input outOwnerPkX[nOuts];

    // extDataHash is part of the public statement; no further constraint is
    // needed here beyond declaring it public (see header note) — the binding
    // comes from the verifier checking it against calldata, not from math
    // inside this circuit.

    // ---- input notes: derive pubkey, recompute commitment, verify membership, compute nullifier ----
    component inPubkey[nIns];
    component inCommitmentHasher[nIns];
    component inMerkle[nIns];
    component inNullifierHasher[nIns];
    component inAmountRange[nIns];

    var sumIn = 0;
    for (var i = 0; i < nIns; i++) {
        inPubkey[i] = BabyPbk();
        inPubkey[i].in <== inOwnerSk[i];

        inCommitmentHasher[i] = Poseidon(4);
        inCommitmentHasher[i].inputs[0] <== tokenId;
        inCommitmentHasher[i].inputs[1] <== inAmount[i];
        inCommitmentHasher[i].inputs[2] <== inPubkey[i].Ax;
        inCommitmentHasher[i].inputs[3] <== inBlinding[i];

        inMerkle[i] = MerkleTreeInclusionProof(merkleDepth);
        inMerkle[i].leaf <== inCommitmentHasher[i].out;
        for (var lvl = 0; lvl < merkleDepth; lvl++) {
            inMerkle[i].pathElements[lvl] <== inPathElements[i][lvl];
            inMerkle[i].pathIndices[lvl] <== inPathIndices[i][lvl];
        }
        inMerkle[i].root === root;

        inNullifierHasher[i] = Poseidon(2);
        inNullifierHasher[i].inputs[0] <== inOwnerSk[i];
        inNullifierHasher[i].inputs[1] <== inLeafIndex[i];
        inNullifierHasher[i].out === nullifiers[i];

        inAmountRange[i] = Num2Bits(128);
        inAmountRange[i].in <== inAmount[i];

        sumIn += inAmount[i];
    }

    // ---- output notes: recompute commitment ----
    component outCommitmentHasher[nOuts];
    component outAmountRange[nOuts];

    var sumOut = 0;
    for (var j = 0; j < nOuts; j++) {
        outCommitmentHasher[j] = Poseidon(4);
        outCommitmentHasher[j].inputs[0] <== tokenId;
        outCommitmentHasher[j].inputs[1] <== outAmount[j];
        outCommitmentHasher[j].inputs[2] <== outOwnerPkX[j];
        outCommitmentHasher[j].inputs[3] <== outBlinding[j];
        outCommitmentHasher[j].out === newCommitments[j];

        outAmountRange[j] = Num2Bits(128);
        outAmountRange[j].in <== outAmount[j];

        sumOut += outAmount[j];
    }

    component unshieldRange = Num2Bits(128);
    unshieldRange.in <== unshieldAmount;
    component feeRange = Num2Bits(128);
    feeRange.in <== feeAmount;

    // ---- conservation: sum(in) == sum(out) + unshield + fee ----
    sumIn === sumOut + unshieldAmount + feeAmount;
}
