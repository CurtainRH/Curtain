// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoseidonT3} from "./PoseidonT3.sol";

/// @notice Incremental Poseidon Merkle tree, depth 32, per Curtain_Build.md
/// §1 ("Incremental, depth 32, Poseidon; roots kept in a ring of last 128
/// roots"). Same structural pattern as Tornado Cash's MerkleTreeWithHistory,
/// swapped to Poseidon so on-chain roots match the circuits' MerkleTree
/// InclusionProof template exactly.
///
/// A library (not a base contract) so a single contract can hold more than
/// one independent tree — CurtainPool needs exactly this for the main
/// deposit tree and the PPOI-cleared tree added in M4 (see
/// Curtain_Build.md §11 item 6).
library IncrementalMerkleTree {
    uint32 internal constant LEVELS = 32;
    uint32 internal constant ROOT_HISTORY_SIZE = 128;

    struct Tree {
        uint256[LEVELS] zeros;
        mapping(uint256 => uint256) filledSubtrees;
        mapping(uint256 => uint256) roots;
        uint32 currentRootIndex;
        uint32 nextLeafIndex;
        bool initialized;
    }

    function init(Tree storage self, IPoseidonT3 hasher) internal {
        require(!self.initialized, "IncrementalMerkleTree: already initialized");
        self.initialized = true;

        uint256 currentZero = 0;
        for (uint32 i = 0; i < LEVELS; i++) {
            self.zeros[i] = currentZero;
            self.filledSubtrees[i] = currentZero;
            currentZero = hasher.poseidon([currentZero, currentZero]);
        }
        self.roots[0] = currentZero;
    }

    function insert(Tree storage self, IPoseidonT3 hasher, uint256 leaf) internal returns (uint32 insertedIndex) {
        uint32 currentIndex = self.nextLeafIndex;
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
                right = self.zeros[i];
                self.filledSubtrees[i] = currentLevelHash;
            } else {
                left = self.filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = hasher.poseidon([left, right]);
            currentIndex /= 2;
        }

        self.currentRootIndex = (self.currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        self.roots[self.currentRootIndex] = currentLevelHash;

        insertedIndex = self.nextLeafIndex;
        self.nextLeafIndex += 1;
    }

    /// @notice True if `root` is the current root or one of the last
    /// ROOT_HISTORY_SIZE-1 previous roots. Bounds proof staleness to that
    /// window, per the security checklist in Curtain_Build.md §10.
    function isKnownRoot(Tree storage self, uint256 root) internal view returns (bool) {
        if (root == 0) return false;

        uint32 i = self.currentRootIndex;
        for (uint32 j = 0; j < ROOT_HISTORY_SIZE; j++) {
            if (self.roots[i] == root) return true;
            if (i == 0) {
                i = ROOT_HISTORY_SIZE - 1;
            } else {
                i -= 1;
            }
        }
        return false;
    }

    function currentRoot(Tree storage self) internal view returns (uint256) {
        return self.roots[self.currentRootIndex];
    }
}
