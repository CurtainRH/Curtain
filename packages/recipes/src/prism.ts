/**
 * Prism DEX swap recipe per Curtain_Build.md §4.4.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { Recipe, Step } from "./types";
import { approveCall } from "./erc20";

const PRISM_ROUTER_ABI = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "tokenIn" },
      { type: "address", name: "tokenOut" },
      { type: "uint256", name: "amountIn" },
      { type: "uint256", name: "minOut" },
    ],
    outputs: [{ type: "uint256", name: "amountOut" }],
  },
  {
    type: "function",
    name: "swapPrism",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "tokenIn" },
      { type: "address", name: "tokenOut" },
      { type: "uint256", name: "amountIn" },
      { type: "uint256", name: "minOut" },
      { type: "bytes", name: "routeData" },
    ],
    outputs: [{ type: "uint256", name: "amountOut" }],
  },
] as const;

export interface PrismDexSwapParams {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  routeData?: Hex;
}

export function prismDexSwapStep(params: PrismDexSwapParams): Step {
  const { router, tokenIn, tokenOut, amountIn, minOut, routeData } = params;
  return {
    name: "prismDexSwap",
    inputs: [{ token: tokenIn, amount: amountIn }],
    outputs: [{ token: tokenOut, minOut }],
    call: () => [
      approveCall(tokenIn, router, amountIn),
      {
        to: router,
        value: 0n,
        data: routeData
          ? encodeFunctionData({
              abi: PRISM_ROUTER_ABI,
              functionName: "swapPrism",
              args: [tokenIn, tokenOut, amountIn, minOut, routeData],
            })
          : encodeFunctionData({
              abi: PRISM_ROUTER_ABI,
              functionName: "swapExactIn",
              args: [tokenIn, tokenOut, amountIn, minOut],
            }),
      },
    ],
  };
}

export function prismDexSwap(params: PrismDexSwapParams): Recipe {
  return {
    id: "prism-dex-swap",
    version: "1.0.0",
    targets: [params.tokenIn, params.router],
    steps: [prismDexSwapStep(params)],
  };
}
