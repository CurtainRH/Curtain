// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoseidonT3} from "./PoseidonT3.sol";

/// @notice Stateless depth-32 Poseidon Merkle inclusion proof verification —
/// the same algorithm as circuits/lib/merkleTree.circom's
/// MerkleTreeInclusionProof, but as a plain (non-ZK) on-chain check against
/// an already-published root. Used by ScreeningGate.flag() to verify a
/// provider's plain inclusion proof of a listed address: a *positive* hit
/// doesn't need privacy, so no ZK circuit is needed for it (see
/// Curtain_Build.md §11 item 2).
library MerkleProof32 {
    uint256 internal constant LEVELS = 32;

    function verify(
        IPoseidonT3 hasher,
        uint256 leaf,
        uint256[LEVELS] memory pathElements,
        uint8[LEVELS] memory pathIndices,
        uint256 root
    ) internal pure returns (bool) {
        uint256 current = leaf;
        for (uint256 i = 0; i < LEVELS; i++) {
            if (pathIndices[i] == 0) {
                current = hasher.poseidon([current, pathElements[i]]);
            } else {
                current = hasher.poseidon([pathElements[i], current]);
            }
        }
        return current == root;
    }
}
