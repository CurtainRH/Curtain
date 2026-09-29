// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ISolvencyVerifier {
    function verifyProof(bytes calldata proof, uint256[] calldata publicSignals) external view returns (bool);
}
