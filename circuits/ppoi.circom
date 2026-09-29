pragma circom 2.1.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/smt/smtverifier.circom";

// Blinded Private Proof of Innocence, per Curtain_Build.md §2.2. Proves that
// the shielder's origin address is absent from K independent provider
// sanctions/scam lists (sparse Merkle non-membership), without revealing the
// address beyond that non-membership — and ties the proof to one specific
// shielded note by re-deriving its commitment from a private opening.
//
// originHash binds to `pool.originOf[noteCommit]` on-chain: the pool stores
// originOf as an address, so the contract hashes it with Poseidon before
// comparing to this circuit's public `originHash` input (see the
// "underspecified" note in Curtain_Build.md §11 — this is that glue step,
// now made concrete: hash the on-chain address before the equality check).
template Ppoi(nProviders, nLevels) {
    // ---- public inputs ----
    signal input providerRoots[nProviders];
    signal input noteCommit;
    signal input shieldBlock;
    signal input originHash;

    // ---- private: note opening (ties this proof to one specific note) ----
    signal input tokenId;
    signal input rawAmount;
    signal input ownerPkX;
    signal input blinding;

    // ---- private: origin address + non-membership witness per provider ----
    signal input originAddr;
    signal input siblings[nProviders][nLevels];
    signal input oldKey[nProviders];
    signal input oldValue[nProviders];
    signal input isOld0[nProviders];

    // shieldBlock is part of the public statement (binds the proof to the
    // shield event it was generated for); no further constraint needed.
    signal shieldBlockUnused;
    shieldBlockUnused <== shieldBlock;

    // noteCommit opens correctly.
    component commitHasher = Poseidon(4);
    commitHasher.inputs[0] <== tokenId;
    commitHasher.inputs[1] <== rawAmount;
    commitHasher.inputs[2] <== ownerPkX;
    commitHasher.inputs[3] <== blinding;
    commitHasher.out === noteCommit;

    // originHash matches the public origin-address hash.
    component addrHasher = Poseidon(1);
    addrHasher.inputs[0] <== originAddr;
    addrHasher.out === originHash;

    // Non-membership of originAddr against every provider's root.
    component smt[nProviders];
    for (var k = 0; k < nProviders; k++) {
        smt[k] = SMTVerifier(nLevels);
        smt[k].enabled <== 1;
        smt[k].root <== providerRoots[k];
        for (var lvl = 0; lvl < nLevels; lvl++) {
            smt[k].siblings[lvl] <== siblings[k][lvl];
        }
        smt[k].oldKey <== oldKey[k];
        smt[k].oldValue <== oldValue[k];
        smt[k].isOld0 <== isOld0[k];
        smt[k].key <== addrHasher.out;
        smt[k].value <== 0;
        smt[k].fnc <== 1; // 1 = verify NOT included
    }
}
