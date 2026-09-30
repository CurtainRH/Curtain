/**
 * Builds the router calldata for CurtainVault.executeSwap. The vault is always the swap's
 * recipient; the vault itself checks the output landed and meets `minOut`.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";

export interface SwapRequest {
  vault: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
}

export type RouteBuilder = (r: SwapRequest) => Hex;

const MOCK_ABI = parseAbi(["function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut) returns (uint256)"]);

/** contracts/test/mocks/MockDexRouter.sol — local chains only. */
export const mockRoute: RouteBuilder = (r) =>
  encodeFunctionData({ abi: MOCK_ABI, functionName: "swapExactIn", args: [r.tokenIn, r.tokenOut, r.amountIn, r.minOut] });

const V3_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/** Uniswap SwapRouter02 `exactInputSingle` with a fixed fee tier (e.g. 3000 = 0.30%). */
export function uniswapV3Route(feeTier: number): RouteBuilder {
  return (r) =>
    encodeFunctionData({
      abi: V3_ABI,
      functionName: "exactInputSingle",
      args: [{ tokenIn: r.tokenIn, tokenOut: r.tokenOut, fee: feeTier, recipient: r.vault, amountIn: r.amountIn, amountOutMinimum: r.minOut, sqrtPriceLimitX96: 0n }],
    });
}
