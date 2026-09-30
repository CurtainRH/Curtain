// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPpoiVerifier} from "./IPpoiVerifier.sol";
import {PpoiDevGroth16Verifier} from "./generated/PpoiDevGroth16Verifier.sol";

/// @notice Adapts the snarkjs-generated PPOI verifier (fixed uint[6]
/// public-signals array — 3 provider roots, noteCommit, shieldBlock,
/// originHash) to ScreeningGate's IPpoiVerifier interface. Dev-scale (SMT
/// depth 32, not spec's 160 — see circuits/ppoi_dev.circom).
contract PpoiDevVerifierAdapter is IPpoiVerifier {
    PpoiDevGroth16Verifier public immutable verifier;

    constructor(address verifierAddr) {
        verifier = PpoiDevGroth16Verifier(verifierAddr);
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool) {
        require(publicSignals.length == 6, "PpoiDevVerifierAdapter: expected 6 public signals");
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        uint256[6] memory signals;
        for (uint256 i = 0; i < 6; i++) signals[i] = publicSignals[i];

        return verifier.verifyProof(a, b, c, signals);
    }
}
