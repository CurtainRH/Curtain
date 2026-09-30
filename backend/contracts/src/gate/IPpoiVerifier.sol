// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Common interface ScreeningGate calls to verify a PPOI proof,
/// mirroring IJoinSplitVerifier.sol's pattern of decoupling from the
/// snarkjs-generated verifier's fixed-size ABI.
interface IPpoiVerifier {
    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool);
}
