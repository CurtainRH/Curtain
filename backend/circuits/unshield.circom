pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/babyjub.circom";

// Closes a double-spend gap found while building M5 (see
// Curtain_Build.md §11): CurtainPool.unshieldToOrigin() and transact()
// used to track spent notes in two disjoint namespaces —
// nullifierUsed[commit] for the origin escape hatch vs.
// nullifierUsed[Poseidon(ownerSk, leafIndex)] for join-split — so a note
// spent via one path could still be spent again via the other. This
// circuit lets unshieldToOrigin mark the SAME nullifier a join-split
// spend of the same note would use, without revealing ownerSk on-chain
// (ownerSk is one long-term key shared by every note in a wallet per
// Curtain_Build.md §1 — leaking it anywhere would compromise the whole
// wallet, past and future notes alike, not just this one).
//
// Deliberately tiny: no Merkle tree, no range checks, no arity. The
// contract already re-derives and checks the note commitment itself
// (see CurtainPool.unshieldToOrigin); this circuit only has to prove
// "I know the spending key behind ownerPkX, and here is the nullifier
// that spending key produces for this leafIndex" — two Poseidon/BabyJub
// constraints, nothing more.
//
// `leafIndex` is PUBLIC and supplied by the contract from its own
// `leafIndexOf[commit]` storage (recorded once, at shield time) — never
// taken from the caller. If it were a private witness the caller could
// pick a fresh, never-before-used leafIndex on every call, minting an
// unlimited stream of distinct-but-valid-looking nullifiers for the same
// note and defeating the whole point of unifying this with join-split's
// nullifier set. Binding it to the contract's own record of the note's
// true position makes the nullifier this circuit outputs identical to
// the one a join-split spend of the same note would have produced.
template UnshieldNullifier() {
    // ---- public inputs ----
    signal input ownerPkX; // must match the note's own commitment opening
    signal input leafIndex; // supplied by the contract, not the caller — see header
    signal input nullifier; // Poseidon(ownerSk, leafIndex) — same formula as joinsplit.circom

    // ---- private inputs ----
    signal input ownerSk;

    component pk = BabyPbk();
    pk.in <== ownerSk;
    pk.Ax === ownerPkX;

    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== ownerSk;
    nullifierHasher.inputs[1] <== leafIndex;
    nullifierHasher.out === nullifier;
}

component main {public [ownerPkX, leafIndex, nullifier]} = UnshieldNullifier();
