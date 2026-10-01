/**
 * Builds the router calldata for CurtainVault.executeSwap. The vault is always the swap's
 * recipient; the vault itself checks the output landed and meets `minOut`.
 */
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";

/**
 * Runs a quote call. A contract revert means "no such pool / no liquidity" and returns null.
 * Anything else (rate limit, timeout) is retried with backoff, then thrown: a flaky RPC must
 * make the operator skip a tick, not quietly settle through a worse venue.
 */
async function quoteCall<T>(fn: () => Promise<T>, attempts = 4): Promise<T | null> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const reverted = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
      if (reverted) return null;
      if (i + 1 >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
  }
}

export interface SwapRequest {
  vault: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  /** Pool fee tier picked by the quoter (Uniswap v3). */
  fee?: number;
  /** Uniswap v4 pool picked by the quoter; routes through the v4 adapter. */
  v4?: V4Pool;
}

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface V4Pool {
  key: V4PoolKey;
  zeroForOne: boolean;
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
  /** Router contract the settlement swaps through (overrides the operator default). */
  router?: Address;
  /** Pool fee tier to route through (Uniswap v3). */
  fee?: number;
  /** Uniswap v4 pool to route through instead. */
  v4?: V4Pool;
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
      const r = await quoteCall(() => client.simulateContract({
        address: quoter, abi: QUOTER_V2_ABI, functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
      }));
      return { amountOut: r ? r.result[0] : 0n, fee };
    }));
    return quotes.reduce((best, q) => (q.amountOut > best.amountOut ? q : best), { amountOut: 0n, fee: tiers[0] });
  };
}

// ---------------------------------------------------------------- Uniswap v4 + combined routing

const V4_ADAPTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function swapExactIn(PoolKey key, bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient) returns (uint256)",
]);

const V4_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** The standard hookless v4 pools (fee, tick spacing). Pools with hooks run arbitrary code during
 * a swap, so they're never routed through automatically. */
export const V4_STANDARD_POOLS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

const NO_HOOKS: Address = "0x0000000000000000000000000000000000000000";

export function v4PoolFor(tokenIn: Address, tokenOut: Address, fee: number, tickSpacing: number): V4Pool {
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  const [currency0, currency1] = zeroForOne ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
  return { key: { currency0, currency1, fee, tickSpacing, hooks: NO_HOOKS }, zeroForOne };
}

export interface UniswapConfig {
  client: PublicClient;
  v3Router: Address;
  v3Quoter: Address;
  /** Leave out to route v3 only. */
  v4Adapter?: Address;
  v4Quoter?: Address;
}

/**
 * Best of Uniswap v3 (every fee tier, via SwapRouter02) and v4 (standard hookless pools, via
 * UniswapV4Adapter). On Robinhood Chain most stock-token liquidity is on v4 for some pairs
 * and v3 for others, and the winner changes with trade size.
 */
export function uniswapQuoter(cfg: UniswapConfig): Quoter {
  const v3 = uniswapV3Quoter(cfg.client, cfg.v3Quoter);
  return async (tokenIn, tokenOut, amountIn) => {
    const candidates: Quote[] = [];
    const best3 = await v3(tokenIn, tokenOut, amountIn);
    if (best3.amountOut > 0n) candidates.push({ ...best3, router: cfg.v3Router });

    if (cfg.v4Adapter && cfg.v4Quoter && amountIn < 2n ** 127n) {
      const quotes = await Promise.all(V4_STANDARD_POOLS.map(async ({ fee, tickSpacing }) => {
        const pool = v4PoolFor(tokenIn, tokenOut, fee, tickSpacing);
        const r = await quoteCall(() => cfg.client.simulateContract({
          address: cfg.v4Quoter!, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
          args: [{ poolKey: pool.key, zeroForOne: pool.zeroForOne, exactAmount: amountIn, hookData: "0x" }],
        }));
        return r ? ({ amountOut: r.result[0], router: cfg.v4Adapter, v4: pool } satisfies Quote) : null;
      }));
      for (const q of quotes) if (q && q.amountOut > 0n) candidates.push(q);
    }
    return candidates.reduce((best, q) => (q.amountOut > best.amountOut ? q : best), { amountOut: 0n } as Quote);
  };
}

/** Builds calldata for whichever venue the quote picked. */
export function uniswapRoute(defaultV3FeeTier = 3000): RouteBuilder {
  const v3 = uniswapV3Route(defaultV3FeeTier);
  return (r) => {
    if (!r.v4) return v3(r);
    const k = r.v4.key;
    return encodeFunctionData({
      abi: V4_ADAPTER_ABI,
      functionName: "swapExactIn",
      args: [{ currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks }, r.v4.zeroForOne, r.amountIn, r.minOut, r.vault],
    });
  };
}
