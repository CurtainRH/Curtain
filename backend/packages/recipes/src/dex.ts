/**
 * Day-one swap recipe per Curtain_Build.md §4.4's list (UniswapV3ExactIn /
 * UniswapV4ExactIn / BuyAndShield). Targets a minimal `swapExactIn(tokenIn,
 * tokenOut, amountIn, minOut)` interface, matching
 * contracts/test/mocks/MockDexRouter.sol — the actual router this repo can
 * test against without a mainnet-fork RPC (see that mock's header and
 * Curtain_Build.md §11 for the deferral). Swapping in real Uniswap V3/V4
 * calldata encoding (`exactInputSingle`, tick math, pool keys, etc.) once a
 * forking RPC is available is an isolated change to `swapExactInCall`
 * below — the Step/Recipe shape around it doesn't need to change.
 */
import { encodeFunctionData, type Address } from "viem";
import type { Recipe, Step } from "./types";
import { approveCall } from "./erc20";

const SWAP_EXACT_IN_ABI = [
  {
    type: "function", name: "swapExactIn", stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface SwapExactInParams {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
}

function swapExactInStep(params: SwapExactInParams): Step {
  const { router, tokenIn, tokenOut, amountIn, minOut } = params;
  return {
    name: "swapExactIn",
    inputs: [{ token: tokenIn, amount: amountIn }],
    outputs: [{ token: tokenOut, minOut }],
    call: () => [
      approveCall(tokenIn, router, amountIn),
      {
        to: router,
        value: 0n,
        data: encodeFunctionData({ abi: SWAP_EXACT_IN_ABI, functionName: "swapExactIn", args: [tokenIn, tokenOut, amountIn, minOut] }),
      },
    ],
  };
}

/**
 * BuyAndShield(USDG -> StockToken): unshields USDG, swaps it for a stock
 * token, and (per RelayAdapt.relay()'s own contract, called by the wallet
 * with this bundle) reshields the proceeds — all in the one atomic relay
 * transaction M6's acceptance criterion asks for ("buy NVDA into shield in
 * one tx on testnet").
 */
export function buyAndShield(params: SwapExactInParams): Recipe {
  return {
    id: "buy-and-shield",
    version: "1.0.0",
    targets: [params.tokenIn, params.router],
    steps: [swapExactInStep(params)],
  };
}
