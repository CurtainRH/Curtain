// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Where CurtainPool reads its governed fee from (CrtnStaking). The pool clamps the
/// answer to [MIN_FEE_BPS, MAX_FEE_BPS] and falls back to its default if the call fails, so a
/// broken or hostile fee source can never block exits or push the fee out of bounds.
interface IFeeSource {
    function currentFeeBps() external view returns (uint16);
}
