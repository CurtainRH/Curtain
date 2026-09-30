/**
 * Swap intents: the off-chain half of a private swap. The operator picks the payout time and
 * the hidden deadline; the user deposits with `deadlineHash` and keeps (deadline, salt) for
 * the escape hatch.
 */
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import type { Db } from "@curtain/db";

export const MAX_DELAY_SECONDS = 180 * 24 * 3600; // 180 days
/** Instant swaps are paid as soon as the deposit lands; this bounds how long the user has to
 * deposit and the operator has to pay before the escape hatch opens (deadline + 3 min). */
export const INSTANT_DEADLINE_SECONDS = 600;
/** Delayed swaps: time after the latest scheduled payout before the deadline. */
export const DELAYED_GRACE_SECONDS = 600;

export interface IntentRequest {
  tokenIn: string;
  amountIn: string | bigint;
  tokenOut: string;
  recipient: string;
  minOut: string | bigint;
  /** 0 = instant; otherwise the maximum random delay in seconds (up to 180 days). */
  delaySeconds: number;
}

export interface Intent {
  id: string;
  deadline: bigint;
  salt: Hex;
  deadlineHash: Hex;
  payAt: bigint;
}

export class IntentError extends Error {}

const hex32 = () => `0x${randomBytes(32).toString("hex")}` as Hex;

export function deadlineHashOf(deadline: bigint, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [deadline, salt]));
}

/** Uniform random integer in [0, max]. */
function randomUpTo(max: number): number {
  if (max <= 0) return 0;
  return Number(BigInt(`0x${randomBytes(8).toString("hex")}`) % BigInt(max + 1));
}

export async function createIntent(db: Db, req: IntentRequest, allowedTokens: Set<string>, nowSec: number): Promise<Intent> {
  for (const [k, v] of [["tokenIn", req.tokenIn], ["tokenOut", req.tokenOut], ["recipient", req.recipient]] as const) {
    if (!isAddress(v)) throw new IntentError(`${k} is not an address`);
  }
  const tokenIn = getAddress(req.tokenIn);
  const tokenOut = getAddress(req.tokenOut);
  if (!allowedTokens.has(tokenIn) || !allowedTokens.has(tokenOut)) throw new IntentError("token not supported");
  const amountIn = BigInt(req.amountIn);
  const minOut = BigInt(req.minOut);
  if (amountIn <= 0n) throw new IntentError("amountIn must be positive");
  if (minOut <= 0n) throw new IntentError("minOut must be positive");
  const delay = Math.floor(req.delaySeconds);
  if (!(delay >= 0 && delay <= MAX_DELAY_SECONDS)) throw new IntentError(`delaySeconds must be 0..${MAX_DELAY_SECONDS}`);

  const instant = delay === 0;
  const payAt = BigInt(nowSec + (instant ? 0 : randomUpTo(delay)));
  const deadline = BigInt(nowSec + (instant ? INSTANT_DEADLINE_SECONDS : delay + DELAYED_GRACE_SECONDS));
  const salt = hex32();
  const deadlineHash = deadlineHashOf(deadline, salt);
  const id = randomBytes(16).toString("hex");

  await db.query(
    `INSERT INTO intents (id, deadline_hash, deadline, salt, pay_at, mode, token_in, amount_in, token_out, recipient, min_out, secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, deadlineHash, deadline.toString(), salt, payAt.toString(), instant ? "instant" : "delayed", tokenIn, amountIn.toString(),
      tokenOut, getAddress(req.recipient), minOut.toString(), hex32()],
  );
  return { id, deadline, salt, deadlineHash, payAt };
}
