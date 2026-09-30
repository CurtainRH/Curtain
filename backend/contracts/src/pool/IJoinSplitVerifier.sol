// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Common interface CurtainPool calls regardless of join-split arity
/// (2-in-2-out vs 3-in-3-out use different snarkjs-generated Groth16
/// verifiers with different fixed-size public-input arrays). A thin adapter
/// contract per arity decodes `proof`/`publicSignals` into that verifier's
/// concrete ABI — see PoseidonT3.sol's header for why generated artifacts
/// are wrapped rather than inlined directly into the pool.
interface IJoinSplitVerifier {
    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool);
}
