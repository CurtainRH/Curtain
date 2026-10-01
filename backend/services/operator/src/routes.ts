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
  /** Pool fee tier picked by the quoter (Uniswap). */
  fee?: number;
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

/** Uniswap SwapRouter02 `exactInputSingle` through the fee tier the quoter picked. */
export function uniswapV3Route(defaultFeeTier: number): RouteBuilder {
  return (r) =>
    encodeFunctionData({
      abi: V3_ABI,
      functionName: "exactInputSingle",
      args: [{ tokenIn: r.tokenIn, tokenOut: r.tokenOut, fee: r.fee ?? defaultFeeTier, recipient: r.vault, amountIn: r.amountIn, amountOutMinimum: r.minOut, sqrtPriceLimitX96: 0n }],
    });
}

export interface Quote {
  /** Expected output for `amountIn` right now (before slippage tolerance). */
  amountOut: bigint;
  /** Pool fee tier to route through (Uniswap). */
  fee?: number;
}

export type Quoter = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<Quote>;

const MOCK_RATE_ABI = parseAbi(["function rateWad(address tokenIn, address tokenOut) view returns (uint256)"]);

/** contracts/test/mocks/MockDexRouter.sol — local chains only. */
export function mockQuoter(client: PublicClient, router: Address): Quoter {
  return async (tokenIn, tokenOut, amountIn) => {
    const rate = await client.readContract({ address: router, abi: MOCK_RATE_ABI, functionName: "rateWad", args: [tokenIn, tokenOut] });
    return { amountOut: (amountIn * rate) / 10n ** 18n };
  };
}

const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000];

/**
 * Uniswap QuoterV2 `quoteExactInputSingle` across every fee tier (simulated, never sent);
 * returns the tier with the best output for this size. Pairs live in different tiers (on
 * Robinhood Chain USDG/NVDA's deep pool is 0.05%, USDG/TSLA's is 0.30%), and the best tier
 * can change with trade size. Tiers with no pool or no liquidity revert and are skipped.
 */
export function uniswapV3Quoter(client: PublicClient, quoter: Address, tiers: number[] = UNISWAP_FEE_TIERS): Quoter {
  return async (tokenIn, tokenOut, amountIn) => {
    const quotes = await Promise.all(tiers.map(async (fee) => {
      try {
        const { result } = await client.simulateContract({
          address: quoter, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return { amountOut: result[0], fee };
      } catch {
        return { amountOut: 0n, fee };
      }
    }));
    return quotes.reduce((best, q) => (q.amountOut > best.amountOut ? q : best), { amountOut: 0n, fee: tiers[0] });
  };
}
