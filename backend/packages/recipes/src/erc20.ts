import { encodeFunctionData, type Address } from "viem";
import type { Call } from "./types";

const APPROVE_ABI = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
] as const;

/** A plain ERC-20 `approve(spender, amount)` call — the token itself must be allowlisted on RelayAdapt as a target. */
export function approveCall(token: Address, spender: Address, amount: bigint): Call {
  return {
    to: token,
    value: 0n,
    data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [spender, amount] }),
  };
}
