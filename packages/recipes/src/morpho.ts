/**
 * Morpho Vault deposit/withdraw recipes per Curtain_Build.md §4.4 ("yield-in-shield").
 *
 * Compliance note on NAV display ("NAV shown; no APY strings"):
 * Spec §4.4 & Backend §0 mandate that yield inside the shield displays net
 * asset value (NAV) accrual based on vault share conversion rates, rather than
 * displaying speculative or fixed "APY: 12%" marketing strings.
 */
import { encodeFunctionData, type Address } from "viem";
import type { Recipe, Step } from "./types";
import { approveCall } from "./erc20";

const MORPHO_VAULT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint256", name: "assets" }, { type: "address", name: "receiver" }],
    outputs: [{ type: "uint256", name: "shares" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint256", name: "shares" },
      { type: "address", name: "receiver" },
      { type: "address", name: "owner" },
    ],
    outputs: [{ type: "uint256", name: "assets" }],
  },
] as const;

export interface MorphoDepositParams {
  vault: Address;
  underlyingToken: Address;
  amountIn: bigint;
  minSharesOut: bigint;
  /** Address to receive vault shares during relay call (typically RelayAdapt address). */
  receiver: Address;
}

export interface MorphoWithdrawParams {
  vault: Address;
  underlyingToken: Address;
  sharesIn: bigint;
  minAssetsOut: bigint;
  /** Address receiving redeemed underlying assets (typically RelayAdapt address). */
  receiver: Address;
  /** Owner of vault shares (typically RelayAdapt address during relay call). */
  owner: Address;
}

export function morphoDepositStep(params: MorphoDepositParams): Step {
  const { vault, underlyingToken, amountIn, minSharesOut, receiver } = params;
  return {
    name: "morphoDeposit",
    inputs: [{ token: underlyingToken, amount: amountIn }],
    outputs: [{ token: vault, minOut: minSharesOut }],
    call: () => [
      approveCall(underlyingToken, vault, amountIn),
      {
        to: vault,
        value: 0n,
        data: encodeFunctionData({
          abi: MORPHO_VAULT_ABI,
          functionName: "deposit",
          args: [amountIn, receiver],
        }),
      },
    ],
  };
}

export function morphoWithdrawStep(params: MorphoWithdrawParams): Step {
  const { vault, underlyingToken, sharesIn, minAssetsOut, receiver, owner } = params;
  return {
    name: "morphoWithdraw",
    inputs: [{ token: vault, amount: sharesIn }],
    outputs: [{ token: underlyingToken, minOut: minAssetsOut }],
    call: () => [
      {
        to: vault,
        value: 0n,
        data: encodeFunctionData({
          abi: MORPHO_VAULT_ABI,
          functionName: "redeem",
          args: [sharesIn, receiver, owner],
        }),
      },
    ],
  };
}

/** Deposit USDG or another token into Morpho Vault from shield. */
export function morphoDeposit(params: MorphoDepositParams): Recipe {
  return {
    id: "morpho-deposit",
    version: "1.0.0",
    targets: [params.underlyingToken, params.vault],
    steps: [morphoDepositStep(params)],
  };
}

/** Withdraw vault shares back to underlying USDG or another token into shield. */
export function morphoWithdraw(params: MorphoWithdrawParams): Recipe {
  return {
    id: "morpho-withdraw",
    version: "1.0.0",
    targets: [params.vault],
    steps: [morphoWithdrawStep(params)],
  };
}

/**
 * Calculates Net Asset Value (NAV) for a given vault share balance.
 * Enforces spec constraint: NAV = (shares * rateWad) / 1e18 without APY marketing strings.
 */
export function calculateMorphoNAV(shares: bigint, rateWad: bigint): bigint {
  return (shares * rateWad) / 10n ** 18n;
}
