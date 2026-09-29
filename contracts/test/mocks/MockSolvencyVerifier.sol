// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISolvencyVerifier} from "../../src/solvency/ISolvencyVerifier.sol";

/// @notice Test-only mock for ISolvencyVerifier.
contract MockSolvencyVerifier is ISolvencyVerifier {
    bool public shouldPass = true;

    function setShouldPass(bool pass) external {
        shouldPass = pass;
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool) {
        if (proof.length > 0 && proof[0] == 0xff) {
            return false;
        }
        return shouldPass && publicSignals.length == 4;
    }
}
