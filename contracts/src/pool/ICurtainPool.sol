// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal read-only interface ScreeningGate needs from CurtainPool
/// — just enough to look up a note's real origin and shield time itself,
/// rather than trusting a caller-supplied value (which would let anyone lie
/// about which address a PPOI proof is really for). One-directional:
/// ScreeningGate reads CurtainPool; CurtainPool never calls back into
/// ScreeningGate except via read-only `spendable()`/`standby()` calls.
interface ICurtainPool {
    function originOf(bytes32 commit) external view returns (address);
    function shieldedAt(bytes32 commit) external view returns (uint64);
}
