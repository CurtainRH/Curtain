pragma circom 2.1.0;

include "ppoi.circom";

// Dev/test instantiation: SMT depth 32 instead of the spec's 160 (see
// ppoi_main.circom / this file's note). K=3 providers, matching spec
// minimum. At depth 160 the circuit needs ~264k total constraints, which
// requires a 2^20 Powers of Tau — several more hours on this machine to
// generate. Depth 32 keeps the same cryptographic structure (blinded SMT
// non-membership, note-commitment binding) at a size that fits the 2^18
// ptau already generated for the other circuits. Scaling to depth 160 is a
// ceremony-infrastructure concern for a properly resourced M12 setup, not a
// circuit-logic change — ppoi_main.circom (depth 160) remains the
// documented production target.
component main {public [providerRoots, noteCommit, shieldBlock, originHash]} = Ppoi(3, 32);
