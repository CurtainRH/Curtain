import { describe, expect, it } from "bun:test";
import { decodeFunctionData, parseAbi } from "viem";
import { buildRelay, morphoDeposit, morphoWithdraw, calculateMorphoNAV } from "../src/index";

const VAULT = "0x000000000000000000000000000000000000000A" as const;
const USDG = "0x000000000000000000000000000000000000000b" as const;
const RELAY_ADAPT = "0x000000000000000000000000000000000000000C" as const;

describe("Morpho recipes & NAV calculation", () => {
  it("morphoDeposit produces approve call followed by deposit call", () => {
    const recipe = morphoDeposit({
      vault: VAULT,
      underlyingToken: USDG,
      amountIn: 100n * 10n ** 18n,
      minSharesOut: 100n * 10n ** 18n,
      receiver: RELAY_ADAPT,
    });

    expect(recipe.targets).toEqual([USDG, VAULT]);

    const bundle = buildRelay(recipe);
    expect(bundle.calls).toHaveLength(2);
    expect(bundle.calls[0]!.to).toBe(USDG);
    expect(bundle.calls[1]!.to).toBe(VAULT);

    const approveAbi = parseAbi(["function approve(address, uint256)"]);
    const decodedApprove = decodeFunctionData({ abi: approveAbi, data: bundle.calls[0]!.data });
    expect(decodedApprove.args).toEqual([VAULT, 100n * 10n ** 18n]);

    const depositAbi = parseAbi(["function deposit(uint256, address)"]);
    const decodedDeposit = decodeFunctionData({ abi: depositAbi, data: bundle.calls[1]!.data });
    expect(decodedDeposit.args).toEqual([100n * 10n ** 18n, RELAY_ADAPT]);

    expect(bundle.outputs).toEqual([{ token: VAULT, minOut: 100n * 10n ** 18n }]);
  });

  it("morphoWithdraw produces redeem call", () => {
    const recipe = morphoWithdraw({
      vault: VAULT,
      underlyingToken: USDG,
      sharesIn: 100n * 10n ** 18n,
      minAssetsOut: 110n * 10n ** 18n,
      receiver: RELAY_ADAPT,
      owner: RELAY_ADAPT,
    });

    expect(recipe.targets).toEqual([VAULT]);

    const bundle = buildRelay(recipe);
    expect(bundle.calls).toHaveLength(1);
    expect(bundle.calls[0]!.to).toBe(VAULT);

    const redeemAbi = parseAbi(["function redeem(uint256, address, address)"]);
    const decodedRedeem = decodeFunctionData({ abi: redeemAbi, data: bundle.calls[0]!.data });
    expect(decodedRedeem.args).toEqual([100n * 10n ** 18n, RELAY_ADAPT, RELAY_ADAPT]);

    expect(bundle.outputs).toEqual([{ token: USDG, minOut: 110n * 10n ** 18n }]);
  });

  it("calculateMorphoNAV calculates exact Net Asset Value without marketing APY strings", () => {
    const shares = 100n * 10n ** 18n;
    const initialRate = 1n * 10n ** 18n;
    expect(calculateMorphoNAV(shares, initialRate)).toBe(100n * 10n ** 18n);

    const yieldRate = 11n * 10n ** 17n; // 1.1x rate
    expect(calculateMorphoNAV(shares, yieldRate)).toBe(110n * 10n ** 18n);
  });
});
