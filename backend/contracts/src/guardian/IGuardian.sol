// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IGuardian {
    function shieldPaused() external view returns (bool);
    function relayPaused() external view returns (bool);
}
