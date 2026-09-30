// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only stand-in for Prism DEX router, exercising RelayAdapt's
/// Prism DEX swap recipe.
///
/// Labeled as a test mock following the established pattern from M6's
/// MockDexRouter.sol.
contract MockPrismRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public rateWad; // tokenIn => tokenOut => rate (1e18 = 1:1)

    function setRate(address tokenIn, address tokenOut, uint256 rateWad_) external {
        rateWad[tokenIn][tokenOut] = rateWad_;
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) external returns (uint256 amountOut) {
        uint256 rate = rateWad[tokenIn][tokenOut];
        if (rate == 0) rate = 1e18; // default 1:1
        amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= minOut, "MockPrismRouter: slippage");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    function swapPrism(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata /* routeData */
    ) external returns (uint256 amountOut) {
        return this.swapExactIn(tokenIn, tokenOut, amountIn, minOut);
    }
}
