// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IScreeningGate} from "../../src/gate/IScreeningGate.sol";

/// @notice Test-only stub. The real ScreeningGate (PPOI verification,
/// standby, flag) is exercised separately in test/gate/ — this mock lets
/// CurtainPool.t.sol test the pool's own bookkeeping (markCleared, tree
/// updates, transact gating) independently of ScreeningGate's internals.
contract MockScreeningGate is IScreeningGate {
    bool public spendableResult = true;

    function setSpendable(bool value) external {
        spendableResult = value;
    }

    function spendable(bytes32) external view returns (bool) {
        return spendableResult;
    }

    function standby() external pure returns (uint64) {
        return 15 minutes;
    }
}
