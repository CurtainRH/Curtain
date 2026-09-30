// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only stand-in for Arcus perps router, exercising
/// RelayAdapt's private perps open/close recipes.
///
/// Labeled as a test mock following the established pattern from M6's
/// MockDexRouter.sol.
contract MockArcusRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public rateWad; // tokenIn => tokenOut => rate (1e18 = 1:1)

    function setRate(address tokenIn, address tokenOut, uint256 rateWad_) external {
        rateWad[tokenIn][tokenOut] = rateWad_;
    }

    function openPosition(
        address collateralToken,
        uint256 marginAmount,
        address positionToken,
        uint256 minPositionOut
    ) external returns (uint256 positionOut) {
        uint256 rate = rateWad[collateralToken][positionToken];
        if (rate == 0) rate = 1e18; // default 1:1
        positionOut = (marginAmount * rate) / 1e18;
        require(positionOut >= minPositionOut, "MockArcusRouter: slippage on open");

        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), marginAmount);
        IERC20(positionToken).safeTransfer(msg.sender, positionOut);
    }

    function closePosition(
        address positionToken,
        uint256 sharesIn,
        address collateralToken,
        uint256 minCollateralOut
    ) external returns (uint256 collateralOut) {
        uint256 rate = rateWad[positionToken][collateralToken];
        if (rate == 0) rate = 1e18; // default 1:1
        collateralOut = (sharesIn * rate) / 1e18;
        require(collateralOut >= minCollateralOut, "MockArcusRouter: slippage on close");

        IERC20(positionToken).safeTransferFrom(msg.sender, address(this), sharesIn);
        IERC20(collateralToken).safeTransfer(msg.sender, collateralOut);
    }
}
