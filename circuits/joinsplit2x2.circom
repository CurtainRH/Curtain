pragma circom 2.1.0;

include "joinsplit.circom";

// Production Merkle depth is 32 per Curtain_Build.md §1.
component main {public [root, nullifiers, newCommitments, tokenId, unshieldAmount, unshieldTo, feeAmount, extDataHash]} = JoinSplit(2, 2, 32);
