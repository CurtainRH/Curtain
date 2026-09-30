// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Interface per Curtain_Build.md §3.2. The concrete ScreeningGate
/// (multi-provider PPOI, 15/60-min standby, flag/ragequit) is M4's
/// deliverable; CurtainPool only depends on this interface so M3 can be
/// built, tested, and deployed against a real gate address independently
/// of M4's internal logic.
interface IScreeningGate {
    function spendable(bytes32 commit) external view returns (bool);
    function standby() external view returns (uint64);
}
