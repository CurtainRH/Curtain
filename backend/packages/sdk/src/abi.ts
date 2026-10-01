/** CurtainVault / CurtainStaking ABIs (the parts off-chain code uses). */
import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";

export const VAULT_ABI = parseAbi([
  "struct Swap { address router; address tokenIn; uint256 amountIn; address tokenOut; uint256 minOut; bytes data; }",
  "struct Payout { address recipient; uint256 amount; uint256 protocolFee; uint256 keeperFee; bytes32 tag; }",
  "event Deposited(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, bytes32 deadlineHash)",
  "event Settled(uint256 indexed nonce, address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 amountOut, uint256 paid, address keeper)",
  "event PaidOut(bytes32 indexed tag, address indexed recipient, address indexed token, uint256 amount, uint256 protocolFee, uint256 keeperFee, address keeper)",
  "event RefundRequested(uint256 indexed depositId, uint256 deadline)",
  "event RefundChallenged(uint256 indexed depositId)",
  "event Refunded(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount)",
  "function deposit(address token, uint256 amount, bytes32 deadlineHash) returns (uint256)",
  "function settle(Swap s, Payout[] payouts, uint256 deadline, uint256 nonce, bytes signature)",
  "function settlementDigest(Swap s, Payout[] payouts, uint256 deadline, uint256 nonce) view returns (bytes32)",
  "function requestRefund(uint256 depositId, uint256 deadline, bytes32 salt)",
  "function challengeRefund(uint256 depositId, bytes32 secret)",
  "function finalizeRefund(uint256 depositId)",
  "function feeBps() view returns (uint16)",
  "function deposits(uint256) view returns (address depositor, address token, uint256 amount, bytes32 deadlineHash, uint64 refundRequestedAt, uint8 status)",
  "function allowedToken(address) view returns (bool)",
  "function operator() view returns (address)",
  "function tagUsed(bytes32) view returns (bool)",
  "function nonceUsed(uint256) view returns (bool)",
]);

export const STAKING_ABI = parseAbi([
  "event Staked(uint256 indexed positionId, address indexed owner, uint256 amount, uint8 tier, uint64 unlockAt)",
  "function setTokens(address stakeToken, address rewardToken)",
  "function notifyRewardAmount(uint256 amount, uint256 duration)",
  "function stake(uint256 amount, uint8 tier) returns (uint256)",
  "function claim(uint256 positionId) returns (uint256)",
  "function withdraw(uint256 positionId)",
  "function earned(uint256 positionId) view returns (uint256)",
  "function tier(uint8 t) view returns (uint64 lockSeconds, uint256 multiplierBps)",
  "function positions(uint256) view returns (address owner, uint256 amount, uint256 weighted, uint64 unlockAt, uint256 rewardPerWeightPaid, uint256 pending, bool closed)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** EIP-712 type for CurtainVault settlements (domain: name "CurtainVault", version "1"). */
export const SETTLEMENT_TYPES = {
  Settlement: [
    { name: "swapHash", type: "bytes32" },
    { name: "payoutsHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface SwapStruct {
  router: Address;
  tokenIn: Address;
  amountIn: bigint;
  tokenOut: Address;
  minOut: bigint;
  data: Hex;
}

export interface PayoutStruct {
  recipient: Address;
  amount: bigint;
  protocolFee: bigint;
  keeperFee: bigint;
  tag: Hex;
}

/** CurtainVault.hashSwap */
export function hashSwap(s: SwapStruct): Hex {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address, address, uint256, address, uint256, bytes32"),
    [s.router, s.tokenIn, s.amountIn, s.tokenOut, s.minOut, keccak256(s.data)],
  ));
}

/** CurtainVault.hashPayouts — keccak256(abi.encode(Payout[])) */
export function hashPayouts(payouts: PayoutStruct[]): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "tuple[]", components: [
      { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "protocolFee", type: "uint256" },
      { name: "keeperFee", type: "uint256" }, { name: "tag", type: "bytes32" },
    ] }],
    [payouts],
  ));
}
