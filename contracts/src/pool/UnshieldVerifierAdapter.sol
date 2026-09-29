// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnshieldVerifier} from "./IUnshieldVerifier.sol";
import {UnshieldGroth16Verifier} from "./generated/UnshieldGroth16Verifier.sol";

/// @notice Adapts the snarkjs-generated unshield verifier (fixed uint[3]
/// public-signals array — ownerPkX, leafIndex, nullifier) to CurtainPool's
/// IUnshieldVerifier interface, same pattern as JoinSplitVerifierAdapter.
contract UnshieldVerifierAdapter is IUnshieldVerifier {
    UnshieldGroth16Verifier public immutable verifier;

    constructor(address verifierAddr) {
        verifier = UnshieldGroth16Verifier(verifierAddr);
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool) {
        require(publicSignals.length == 3, "UnshieldVerifierAdapter: expected 3 public signals");
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        uint256[3] memory signals;
        for (uint256 i = 0; i < 3; i++) signals[i] = publicSignals[i];

        return verifier.verifyProof(a, b, c, signals);
    }
}
