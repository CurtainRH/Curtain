/**
 * Arcus perpetuals open/close recipes per Curtain_Build.md §4.4.
 */
import { encodeFunctionData, type Address } from "viem";
import type { Recipe, Step } from "./types";
import { approveCall } from "./erc20";

const ARCUS_ROUTER_ABI = [
  {
    type: "function",
    name: "openPosition",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "collateralToken" },
      { type: "uint256", name: "marginAmount" },
      { type: "address", name: "positionToken" },
      { type: "uint256", name: "minPositionOut" },
    ],
    outputs: [{ type: "uint256", name: "positionOut" }],
  },
  {
    type: "function",
    name: "closePosition",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "positionToken" },
      { type: "uint256", name: "sharesIn" },
      { type: "address", name: "collateralToken" },
      { type: "uint256", name: "minCollateralOut" },
    ],
    outputs: [{ type: "uint256", name: "collateralOut" }],
  },
] as const;

export interface ArcusOpenParams {
  router: Address;
  collateralToken: Address;
  marginAmount: bigint;
  positionToken: Address;
  minPositionOut: bigint;
}

export interface ArcusCloseParams {
  router: Address;
  positionToken: Address;
  sharesIn: bigint;
  collateralToken: Address;
  minCollateralOut: bigint;
}

export function arcusOpenStep(params: ArcusOpenParams): Step {
  const { router, collateralToken, marginAmount, positionToken, minPositionOut } = params;
  return {
    name: "arcusOpen",
    inputs: [{ token: collateralToken, amount: marginAmount }],
    outputs: [{ token: positionToken, minOut: minPositionOut }],
    call: () => [
      approveCall(collateralToken, router, marginAmount),
      {
        to: router,
        value: 0n,
        data: encodeFunctionData({
          abi: ARCUS_ROUTER_ABI,
          functionName: "openPosition",
          args: [collateralToken, marginAmount, positionToken, minPositionOut],
        }),
      },
    ],
  };
}

export function arcusCloseStep(params: ArcusCloseParams): Step {
  const { router, positionToken, sharesIn, collateralToken, minCollateralOut } = params;
  return {
    name: "arcusClose",
    inputs: [{ token: positionToken, amount: sharesIn }],
    outputs: [{ token: collateralToken, minOut: minCollateralOut }],
    call: () => [
      approveCall(positionToken, router, sharesIn),
      {
        to: router,
        value: 0n,
        data: encodeFunctionData({
          abi: ARCUS_ROUTER_ABI,
          functionName: "closePosition",
          args: [positionToken, sharesIn, collateralToken, minCollateralOut],
        }),
      },
    ],
  };
}

export function arcusOpen(params: ArcusOpenParams): Recipe {
  return {
    id: "arcus-open",
    version: "1.0.0",
    targets: [params.collateralToken, params.router],
    steps: [arcusOpenStep(params)],
  };
}

export function arcusClose(params: ArcusCloseParams): Recipe {
  return {
    id: "arcus-close",
    version: "1.0.0",
    targets: [params.positionToken, params.router],
    steps: [arcusCloseStep(params)],
  };
}
