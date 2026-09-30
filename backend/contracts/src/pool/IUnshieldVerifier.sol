// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Verifies the tiny UnshieldNullifier proof (see
/// circuits/unshield.circom) that lets CurtainPool.unshieldToOrigin close
/// its note against the same nullifier a join-split spend would use,
/// without either path learning about the other's state.
interface IUnshieldVerifier {
    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool);
}
