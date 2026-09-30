import { describe, expect, it } from "bun:test";
import { decodeFunctionData, parseAbi } from "viem";
import { buildRelay, buyAndShield } from "../src/index";

const ROUTER = "0x000000000000000000000000000000000000000A" as const;
const USDG = "0x000000000000000000000000000000000000000b" as const;
const NVDA = "0x000000000000000000000000000000000000000C" as const;

describe("buyAndShield recipe", () => {
  it("declares both the token and the router as targets (both need allowlisting on RelayAdapt)", () => {
    const recipe = buyAndShield({ router: ROUTER, tokenIn: USDG, tokenOut: NVDA, amountIn: 50n, minOut: 100n });
    expect(recipe.targets).toEqual([USDG, ROUTER]);
  });

  it("buildRelay produces an approve call followed by a swap call, in order", () => {
    const recipe = buyAndShield({ router: ROUTER, tokenIn: USDG, tokenOut: NVDA, amountIn: 50n, minOut: 100n });
    const bundle = buildRelay(recipe);

    expect(bundle.calls).toHaveLength(2);
    expect(bundle.calls[0]!.to).toBe(USDG);
    expect(bundle.calls[1]!.to).toBe(ROUTER);

    const approveAbi = parseAbi(["function approve(address, uint256)"]);
    const decodedApprove = decodeFunctionData({ abi: approveAbi, data: bundle.calls[0]!.data });
    expect(decodedApprove.args).toEqual([ROUTER, 50n]);

    const swapAbi = parseAbi(["function swapExactIn(address, address, uint256, uint256)"]);
    const decodedSwap = decodeFunctionData({ abi: swapAbi, data: bundle.calls[1]!.data });
    expect(decodedSwap.args).toEqual([USDG, NVDA, 50n, 100n]);
  });

  it("aggregates the expected output token and minOut", () => {
    const recipe = buyAndShield({ router: ROUTER, tokenIn: USDG, tokenOut: NVDA, amountIn: 50n, minOut: 100n });
    const bundle = buildRelay(recipe);
    expect(bundle.outputs).toEqual([{ token: NVDA, minOut: 100n }]);
  });
});
