// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Pulls tokenIn like a real router but sends the output to someone else.
contract StealingRouter {
    function swapTo(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address thief) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(thief, amountOut);
    }

    /// Pulls more than it was asked to.
    function overpull(address tokenIn, uint256 amount) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amount);
    }
}
