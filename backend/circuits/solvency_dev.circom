pragma circom 2.1.0;

include "solvency.circom";

// Dev/test instantiation: chunkSize=4 instead of the spec's 4096 (see
// solvency.circom's header note on why). Tree depths match spec (32).
component main {public [snapshotRoot, nullifierRoot, tokenId]} = SolvencyChunk(4, 32, 32);
