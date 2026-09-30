import { describe, expect, it } from "bun:test";
import { decodeFunctionData, parseAbi } from "viem";
import { arcusClose, arcusOpen, buildRelay } from "../src/index";

const ROUTER = "0x000000000000000000000000000000000000000A" as const;
const USDG = "0x000000000000000000000000000000000000000b" as const;
const ARC_NVDA = "0x000000000000000000000000000000000000000C" as const;

describe("Arcus perps recipes", () => {
  it("arcusOpen produces approve followed by openPosition call", () => {
    const recipe = arcusOpen({
      router: ROUTER,
      collateralToken: USDG,
      marginAmount: 500n * 10n ** 18n,
      positionToken: ARC_NVDA,
      minPositionOut: 500n * 10n ** 18n,
    });

    expect(recipe.targets).toEqual([USDG, ROUTER]);

    const bundle = buildRelay(recipe);
    expect(bundle.calls).toHaveLength(2);
    expect(bundle.calls[0]!.to).toBe(USDG);
    expect(bundle.calls[1]!.to).toBe(ROUTER);

    const openAbi = parseAbi(["function openPosition(address, uint256, address, uint256)"]);
    const decodedOpen = decodeFunctionData({ abi: openAbi, data: bundle.calls[1]!.data });
    expect(decodedOpen.args).toEqual([USDG, 500n * 10n ** 18n, ARC_NVDA, 500n * 10n ** 18n]);

    expect(bundle.outputs).toEqual([{ token: ARC_NVDA, minOut: 500n * 10n ** 18n }]);
  });

  it("arcusClose produces approve followed by closePosition call", () => {
    const recipe = arcusClose({
      router: ROUTER,
      positionToken: ARC_NVDA,
      sharesIn: 500n * 10n ** 18n,
      collateralToken: USDG,
      minCollateralOut: 500n * 10n ** 18n,
    });

    expect(recipe.targets).toEqual([ARC_NVDA, ROUTER]);

    const bundle = buildRelay(recipe);
    expect(bundle.calls).toHaveLength(2);
    expect(bundle.calls[0]!.to).toBe(ARC_NVDA);
    expect(bundle.calls[1]!.to).toBe(ROUTER);

    const closeAbi = parseAbi(["function closePosition(address, uint256, address, uint256)"]);
    const decodedClose = decodeFunctionData({ abi: closeAbi, data: bundle.calls[1]!.data });
    expect(decodedClose.args).toEqual([ARC_NVDA, 500n * 10n ** 18n, USDG, 500n * 10n ** 18n]);

    expect(bundle.outputs).toEqual([{ token: USDG, minOut: 500n * 10n ** 18n }]);
  });
});
