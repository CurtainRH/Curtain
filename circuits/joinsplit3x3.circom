pragma circom 2.1.0;

include "joinsplit.circom";

component main {public [root, nullifiers, newCommitments, tokenId, unshieldAmount, unshieldTo, feeAmount, extDataHash]} = JoinSplit(3, 3, 32);
