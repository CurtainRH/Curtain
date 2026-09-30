import { describe, expect, it } from "bun:test";
import { encodeFunctionData, parseAbi, type Address, type PublicClient, type WalletClient } from "viem";
import { BroadcasterNode, FeeNotPaidToThisBroadcasterError, InsufficientFeeError, WrongBundleTargetError } from "../src/node";
import type { Bundle } from "../src/types";

const POOL = "0x00000000000000000000000000000000000000a1" as Address;
const ADAPT = "0x00000000000000000000000000000000000000a2" as Address;
const ME = "0x00000000000000000000000000000000000000b0" as Address;
const OTHER = "0x00000000000000000000000000000000000000b1" as Address;
const USDG = "0x00000000000000000000000000000000000000c0" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ZERO32 = `0x${"00".repeat(32)}` as const;

const ABI = parseAbi([
  "struct TransactArgs { bytes proof; address token; bytes32 root; bytes32 clearedRoot; bytes32[] nullifiers; bytes32[] newCommits; address unshieldTo; uint256 unshieldAmount; uint256 feeAmount; bytes[] ephemeralPks; bytes[] cts; address feeRecipient; bytes32 extData; }",
  "struct Call { address to; uint256 value; bytes data; }",
  "struct ReshieldOutput { address token; uint256 ownerPkX; uint256 blinding; bytes ephemeralPk; bytes ct; uint256 minOut; }",
  "function transact(TransactArgs a)",
  "function relay(TransactArgs unshield, Call[] calls, ReshieldOutput[] outputs, address origin)",
]);

function args(feeAmount: bigint, feeRecipient: Address, unshieldAmount = 100n * 10n ** 18n) {
  return {
    proof: "0x" as const, token: USDG, root: ZERO32, clearedRoot: ZERO32, nullifiers: [], newCommits: [],
    unshieldTo: ADAPT, unshieldAmount, feeAmount, ephemeralPks: [], cts: [], feeRecipient, extData: ZERO32,
  };
}

function bundle(kind: "transact" | "relay", to: Address, a: ReturnType<typeof args>): Bundle {
  const calldata = kind === "transact"
    ? encodeFunctionData({ abi: ABI, functionName: "transact", args: [a] })
    : encodeFunctionData({ abi: ABI, functionName: "relay", args: [a, [], [], ME] });
  // The bundle's self-declared fee fields are deliberately bogus: they must be ignored.
  return { chainId: 31337, kind, to, calldata, feeToken: USDG, feeAmount: 10n ** 30n, deadline: 0, extDataHash: ZERO32 };
}

// protocolFeeFor = 0.20% of unshieldAmount, like CurtainPool at its default fee
const publicClient = {
  readContract: async ({ args: [amount] }: { args: [bigint] }) => (amount * 20n) / 10000n,
} as unknown as PublicClient;

const node = new BroadcasterNode(
  { address: ME, feeSchedule: new Map([[USDG, 10n ** 18n]]), assignmentWindowMs: 600_000, poolAddress: POOL, relayAddress: ADAPT },
  publicClient,
  {} as WalletClient,
  async () => [ME],
);

describe("BroadcasterNode.checkFee (proof-bound fee)", () => {
  const protocolFee = (100n * 10n ** 18n * 20n) / 10000n;

  it("accepts a transact whose proof pays this broadcaster at least its minimum", async () => {
    expect(await node.checkFee(bundle("transact", POOL, args(protocolFee + 2n * 10n ** 18n, ME)))).toBe(2n * 10n ** 18n);
  });

  it("accepts a relay the same way", async () => {
    expect(await node.checkFee(bundle("relay", ADAPT, args(protocolFee + 10n ** 18n, ME)))).toBe(10n ** 18n);
  });

  it("rejects when the proof pays a different broadcaster", async () => {
    await expect(node.checkFee(bundle("transact", POOL, args(protocolFee + 5n * 10n ** 18n, OTHER)))).rejects.toThrow(FeeNotPaidToThisBroadcasterError);
  });

  it("rejects when only the protocol fee is paid, whatever the bundle claims", async () => {
    await expect(node.checkFee(bundle("transact", POOL, args(protocolFee, ME)))).rejects.toThrow(InsufficientFeeError);
  });

  it("rejects a transact bundle that doesn't target the pool", async () => {
    await expect(node.checkFee(bundle("transact", ADAPT, args(protocolFee + 10n ** 18n, ME)))).rejects.toThrow(WrongBundleTargetError);
  });

  it("rejects feeRecipient zero (whole fee goes to treasury)", async () => {
    await expect(node.checkFee(bundle("relay", ADAPT, args(protocolFee + 10n ** 18n, ZERO)))).rejects.toThrow(FeeNotPaidToThisBroadcasterError);
  });
});
