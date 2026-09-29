// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IJoinSplitVerifier} from "./IJoinSplitVerifier.sol";
import {JoinSplit3x3Groth16Verifier} from "./generated/JoinSplit3x3Groth16Verifier.sol";

/// @notice Adapts the snarkjs-generated 3-in-3-out verifier (fixed uint[12]
/// public-signals array) to CurtainPool's arity-agnostic IJoinSplitVerifier
/// interface. See IJoinSplitVerifier.sol's header for why this indirection
/// exists instead of inlining the generated contract's ABI directly.
contract JoinSplit3x3VerifierAdapter is IJoinSplitVerifier {
    JoinSplit3x3Groth16Verifier public immutable verifier;

    constructor(address verifierAddr) {
        verifier = JoinSplit3x3Groth16Verifier(verifierAddr);
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool) {
        require(publicSignals.length == 12, "JoinSplit3x3VerifierAdapter: expected 12 public signals");
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        uint256[12] memory signals;
        for (uint256 i = 0; i < 12; i++) signals[i] = publicSignals[i];

        return verifier.verifyProof(a, b, c, signals);
    }
}
