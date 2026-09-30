// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnshieldVerifier} from "../../src/pool/IUnshieldVerifier.sol";

/// @notice Test-only verifier stub, same pattern and purpose as
/// MockJoinSplitVerifier: lets CurtainPool's own unshieldToOrigin
/// mechanics (origin/commit checks, shared nullifier bookkeeping, fee
/// transfers) be tested independently of the ZK toolchain. The real
/// circuit/verifier is exercised in UnshieldVerifierAdapter.t.sol against
/// a genuine generated proof fixture.
contract MockUnshieldVerifier is IUnshieldVerifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verifyProof(bytes calldata, uint256[] calldata) external view returns (bool) {
        return result;
    }
}
