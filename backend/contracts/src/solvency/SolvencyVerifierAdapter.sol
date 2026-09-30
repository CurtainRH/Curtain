// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ISolvencyVerifier} from "./ISolvencyVerifier.sol";
import {SolvencyGroth16Verifier} from "./generated/SolvencyGroth16Verifier.sol";

/// @notice Adapts snarkjs-generated SolvencyGroth16Verifier (fixed uint[4] public signals:
/// [partialSum, snapshotRoot, nullifierRoot, tokenId]) to ISolvencyVerifier interface.
contract SolvencyVerifierAdapter is ISolvencyVerifier {
    SolvencyGroth16Verifier public immutable verifier;

    constructor(address verifierAddr) {
        verifier = SolvencyGroth16Verifier(verifierAddr);
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool) {
        require(publicSignals.length == 4, "SolvencyVerifierAdapter: expected 4 public signals");
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        uint256[4] memory signals;
        for (uint256 i = 0; i < 4; i++) signals[i] = publicSignals[i];

        return verifier.verifyProof(a, b, c, signals);
    }
}
