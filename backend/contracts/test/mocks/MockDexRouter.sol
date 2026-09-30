// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only stand-in for a Uniswap V3/V4 router, exercising
/// RelayAdapt's generic `Call` mechanism without vendoring the real Uniswap
/// contracts (a real fork-test integration needs a mainnet-fork RPC this
/// environment doesn't have — see Curtain_Build.md §11 for the deferral).
/// Swaps at a caller-configurable fixed rate (scaled by 1e18) rather than
/// real AMM pricing; that's irrelevant to what RelayAdapt.t.sol actually
/// tests, which is atomicity (unshield -> swap -> reshield in one tx, no
/// residue, disallowed targets revert), not swap economics.
contract MockDexRouter {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint256)) public rateWad; // tokenIn => tokenOut => rate (1e18 = 1:1)

    function setRate(address tokenIn, address tokenOut, uint256 rateWad_) external {
        rateWad[tokenIn][tokenOut] = rateWad_;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        uint256 rate = rateWad[tokenIn][tokenOut];
        require(rate > 0, "MockDexRouter: no rate set");
        amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= minOut, "MockDexRouter: slippage");

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
