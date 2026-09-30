// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IJoinSplitVerifier} from "../../src/pool/IJoinSplitVerifier.sol";

/// @notice Test-only verifier stub. The real Groth16 verifiers come from
/// M2's ceremony (circuits/build/*/Verifier.sol) and are wired in via
/// per-arity adapters — this mock lets CurtainPool's own mechanics (root
/// checks, nullifier bookkeeping, tree updates, fee/unshield transfers) be
/// tested independently of the ZK toolchain.
contract MockJoinSplitVerifier is IJoinSplitVerifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verifyProof(bytes calldata, uint256[] calldata) external view returns (bool) {
        return result;
    }
}
