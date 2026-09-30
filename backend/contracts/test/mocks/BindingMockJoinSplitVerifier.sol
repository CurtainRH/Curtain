// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IJoinSplitVerifier} from "../../src/pool/IJoinSplitVerifier.sol";

/// @notice Stands in for a real Groth16 verifier where a test needs proof *binding*: a real
/// proof is only valid for the exact public signals it was generated against. In `recording`
/// mode it accepts anything and remembers the signals it saw (the honest user "proving");
/// after `lock()`, it accepts only those exact signals, the way a real proof would.
contract BindingMockJoinSplitVerifier is IJoinSplitVerifier {
    bool public recording = true;
    bytes32 public boundSignals;

    function lock(bytes32 signalsHash) external {
        recording = false;
        boundSignals = signalsHash;
    }

    function verifyProof(bytes calldata, uint256[] calldata publicSignals) external view returns (bool) {
        if (recording) return true;
        return keccak256(abi.encode(publicSignals)) == boundSignals;
    }

    /// @dev Helper so tests can compute what the honest proof was bound to.
    function hashSignals(uint256[] calldata publicSignals) external pure returns (bytes32) {
        return keccak256(abi.encode(publicSignals));
    }
}
