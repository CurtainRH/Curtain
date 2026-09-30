import { describe, expect, it } from "bun:test";
import { decodeFunctionData, parseAbi } from "viem";
import { buildRelay, prismDexSwap } from "../src/index";

const ROUTER = "0x000000000000000000000000000000000000000A" as const;
const USDG = "0x000000000000000000000000000000000000000b" as const;
const NVDA = "0x000000000000000000000000000000000000000C" as const;

describe("Prism DEX swap recipe", () => {
  it("prismDexSwap without routeData produces swapExactIn call", () => {
    const recipe = prismDexSwap({
      router: ROUTER,
      tokenIn: USDG,
      tokenOut: NVDA,
      amountIn: 200n * 10n ** 18n,
      minOut: 200n * 10n ** 18n,
    });

    expect(recipe.targets).toEqual([USDG, ROUTER]);

    const bundle = buildRelay(recipe);
    expect(bundle.calls).toHaveLength(2);
    expect(bundle.calls[0]!.to).toBe(USDG);
    expect(bundle.calls[1]!.to).toBe(ROUTER);

    const swapAbi = parseAbi(["function swapExactIn(address, address, uint256, uint256)"]);
    const decodedSwap = decodeFunctionData({ abi: swapAbi, data: bundle.calls[1]!.data });
    expect(decodedSwap.args).toEqual([USDG, NVDA, 200n * 10n ** 18n, 200n * 10n ** 18n]);

    expect(bundle.outputs).toEqual([{ token: NVDA, minOut: 200n * 10n ** 18n }]);
  });

  it("prismDexSwap with routeData produces swapPrism call", () => {
    const routeData = "0x12345678" as const;
    const recipe = prismDexSwap({
      router: ROUTER,
      tokenIn: USDG,
      tokenOut: NVDA,
      amountIn: 200n * 10n ** 18n,
      minOut: 200n * 10n ** 18n,
      routeData,
    });

    const bundle = buildRelay(recipe);
    expect(bundle.calls).toHaveLength(2);

    const prismAbi = parseAbi(["function swapPrism(address, address, uint256, uint256, bytes)"]);
    const decodedSwap = decodeFunctionData({ abi: prismAbi, data: bundle.calls[1]!.data });
    expect(decodedSwap.args).toEqual([USDG, NVDA, 200n * 10n ** 18n, 200n * 10n ** 18n, routeData]);
  });
});
