// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoseidonT3} from "./PoseidonT3.sol";

/// @notice Incremental Poseidon Merkle tree, depth 32, per Curtain_Build.md
/// §1 ("Incremental, depth 32, Poseidon; roots kept in a ring of last 128
/// roots"). Same structural pattern as Tornado Cash's MerkleTreeWithHistory,
/// swapped to Poseidon so on-chain roots match the circuits' MerkleTree
/// InclusionProof template exactly.
abstract contract IncrementalMerkleTree {
    uint32 public constant LEVELS = 32;
    uint32 public constant ROOT_HISTORY_SIZE = 128;

    IPoseidonT3 public immutable hasher;

    uint256[LEVELS] internal zeros;
    mapping(uint256 => uint256) internal filledSubtrees;
    mapping(uint256 => uint256) internal roots;

    uint32 public currentRootIndex;
    uint32 public nextLeafIndex;

    constructor(address hasherAddr) {
        hasher = IPoseidonT3(hasherAddr);

        uint256 currentZero = 0;
        for (uint32 i = 0; i < LEVELS; i++) {
            zeros[i] = currentZero;
            filledSubtrees[i] = currentZero;
            currentZero = hasher.poseidon([currentZero, currentZero]);
        }
        roots[0] = currentZero;
    }

    function _insert(uint256 leaf) internal returns (uint32 insertedIndex) {
        uint32 currentIndex = nextLeafIndex;
        // LEVELS == 32, so the capacity (2**32) doesn't fit back into a
        // uint32 — comparing in uint256 avoids the shift silently wrapping
        // to 0 (which would make every insert revert as "full").
        require(uint256(currentIndex) != (uint256(1) << LEVELS), "IncrementalMerkleTree: tree is full");

        uint256 currentLevelHash = leaf;
        uint256 left;
        uint256 right;

        for (uint32 i = 0; i < LEVELS; i++) {
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = zeros[i];
                filledSubtrees[i] = currentLevelHash;
            } else {
                left = filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hasher.poseidon([left, right]);
            currentIndex /= 2;
        }

        currentRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        roots[currentRootIndex] = currentLevelHash;

        insertedIndex = nextLeafIndex;
        nextLeafIndex += 1;
    }

    /// @notice True if `root` is the current root or one of the last
    /// ROOT_HISTORY_SIZE-1 previous roots. Bounds proof staleness to that
    /// window, per the security checklist in Curtain_Build.md §10.
    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;

        uint32 i = currentRootIndex;
        for (uint32 j = 0; j < ROOT_HISTORY_SIZE; j++) {
            if (roots[i] == root) return true;
            if (i == 0) {
                i = ROOT_HISTORY_SIZE - 1;
            } else {
                i -= 1;
            }
        }
        return false;
    }

    function currentRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }
}
