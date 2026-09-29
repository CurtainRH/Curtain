// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IJoinSplitVerifier} from "./IJoinSplitVerifier.sol";
import {JoinSplit2x2Groth16Verifier} from "./generated/JoinSplit2x2Groth16Verifier.sol";

/// @notice Adapts the snarkjs-generated 2-in-2-out verifier (fixed uint[10]
/// public-signals array) to CurtainPool's arity-agnostic IJoinSplitVerifier
/// interface. See IJoinSplitVerifier.sol's header for why this indirection
/// exists instead of inlining the generated contract's ABI directly.
contract JoinSplit2x2VerifierAdapter is IJoinSplitVerifier {
    JoinSplit2x2Groth16Verifier public immutable verifier;

    constructor(address verifierAddr) {
        verifier = JoinSplit2x2Groth16Verifier(verifierAddr);
    }

    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool) {
        require(publicSignals.length == 10, "JoinSplit2x2VerifierAdapter: expected 10 public signals");
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));

        uint256[10] memory signals;
        for (uint256 i = 0; i < 10; i++) signals[i] = publicSignals[i];

        return verifier.verifyProof(a, b, c, signals);
    }
}
