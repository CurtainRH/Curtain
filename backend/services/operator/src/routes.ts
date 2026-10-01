/**
 * Builds the router calldata for CurtainVault.executeSwap. The vault is always the swap's
 * recipient; the vault itself checks the output landed and meets `minOut`.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";

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

/** Expected output for `amountIn` right now (before slippage tolerance). */
export type Quoter = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<bigint>;

const MOCK_RATE_ABI = parseAbi(["function rateWad(address tokenIn, address tokenOut) view returns (uint256)"]);

/** contracts/test/mocks/MockDexRouter.sol — local chains only. */
export function mockQuoter(client: PublicClient, router: Address): Quoter {
  return async (tokenIn, tokenOut, amountIn) => {
    const rate = await client.readContract({ address: router, abi: MOCK_RATE_ABI, functionName: "rateWad", args: [tokenIn, tokenOut] });
    return (amountIn * rate) / 10n ** 18n;
  };
}

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** Uniswap QuoterV2 `quoteExactInputSingle` (simulated, never sent). */
export function uniswapV3Quoter(client: PublicClient, quoter: Address, feeTier: number): Quoter {
  return async (tokenIn, tokenOut, amountIn) => {
    const { result } = await client.simulateContract({
      address: quoter, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  };
}
