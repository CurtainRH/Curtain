/**
 * Core broadcaster node logic, per Curtain_Build.md §4.1: simulate ->
 * check fee -> submit -> return txHash, plus assignment tracking and the
 * censorship fallback (any broadcaster may submit past the 10-minute
 * assignment window). Deliberately separate from the HTTP transport
 * (index.ts) so this logic is directly testable without spinning up real
 * servers — see test/broadcaster.e2e.test.ts.
 */
import { decodeFunctionData, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { computeAssignee, assignmentWindowElapsed } from "./assignment";
import { bundleId, type Bundle, type BroadcasterConfig } from "./types";

export class InsufficientFeeError extends Error {
  constructor(token: Address, offered: bigint, required: bigint) {
    super(`fee ${offered} for ${token} is below this broadcaster's published minimum ${required}`);
  }
}

export class UnknownFeeTokenError extends Error {
  constructor(token: Address) {
    super(`no published fee schedule for token ${token}`);
  }
}

export class FeeNotPaidToThisBroadcasterError extends Error {
  constructor(recipient: Address) {
    super(`bundle's proof pays its broadcaster fee to ${recipient}, not this broadcaster`);
  }
}

export class WrongBundleTargetError extends Error {
  constructor(kind: string, to: Address) {
    super(`${kind} bundle targets ${to}, not the configured contract`);
  }
}

/** Only the pieces of the CurtainPool / RelayAdapt ABIs the fee check needs. */
const FEE_ABI = parseAbi([
  "struct TransactArgs { bytes proof; address token; bytes32 root; bytes32 clearedRoot; bytes32[] nullifiers; bytes32[] newCommits; address unshieldTo; uint256 unshieldAmount; uint256 feeAmount; bytes[] ephemeralPks; bytes[] cts; address feeRecipient; bytes32 extData; }",
  "struct Call { address to; uint256 value; bytes data; }",
  "struct ReshieldOutput { address token; uint256 ownerPkX; uint256 blinding; bytes ephemeralPk; bytes ct; uint256 minOut; }",
  "function transact(TransactArgs a)",
  "function relay(TransactArgs unshield, Call[] calls, ReshieldOutput[] outputs, address origin)",
  "function protocolFeeFor(uint256 unshieldAmount) view returns (uint256)",
]);

type ProvenArgs = { token: Address; unshieldAmount: bigint; feeAmount: bigint; feeRecipient: Address };

export class NotYetAssignableError extends Error {
  constructor(assignee: Address, availableAt: number) {
    super(`bundle is assigned to ${assignee} until ${new Date(availableAt).toISOString()}`);
  }
}

interface TrackedBundle {
  bundle: Bundle;
  assignee: Address | undefined;
  assignedAtMs: number;
  minedTxHash?: Hex;
}

export class BroadcasterNode {
  private tracked = new Map<Hex, TrackedBundle>();

  constructor(
    private config: BroadcasterConfig,
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private getBondedSet: () => Promise<readonly Address[]>,
  ) {}

  /** Records a bundle this node has observed (via gossip or the HTTPS fallback) and computes its assignee. */
  async trackBundle(bundle: Bundle, nowMs: number = Date.now()): Promise<void> {
    const id = bundleId(bundle);
    if (this.tracked.has(id)) return;
    const bondedSet = await this.getBondedSet();
    this.tracked.set(id, { bundle, assignee: computeAssignee(bundle, bondedSet), assignedAtMs: nowMs });
  }

  markMined(bundle: Bundle, txHash: Hex): void {
    const tracked = this.tracked.get(bundleId(bundle));
    if (tracked) tracked.minedTxHash = txHash;
  }

  isMined(bundle: Bundle): boolean {
    return this.tracked.get(bundleId(bundle))?.minedTxHash !== undefined;
  }

  /**
   * Checks the fee the bundle's PROOF actually pays this broadcaster against the published
   * schedule. The bundle's own `feeToken`/`feeAmount` fields are just claims, so they're
   * ignored: the calldata is decoded, `feeRecipient` must be this broadcaster, and its share
   * is `feeAmount - pool.protocolFeeFor(unshieldAmount)` (what CurtainPool pays out), in the
   * note's token. Both values are bound into the proof's extDataHash, so they can't change
   * after this check.
   */
  async checkFee(bundle: Bundle): Promise<bigint> {
    const a = this.decodeProvenArgs(bundle);
    if (a.feeRecipient.toLowerCase() !== this.config.address.toLowerCase()) {
      throw new FeeNotPaidToThisBroadcasterError(a.feeRecipient);
    }
    const required = [...this.config.feeSchedule].find(([t]) => t.toLowerCase() === a.token.toLowerCase())?.[1];
    if (required === undefined) throw new UnknownFeeTokenError(a.token);
    const protocolFee = (await this.publicClient.readContract({
      address: this.config.poolAddress, abi: FEE_ABI, functionName: "protocolFeeFor", args: [a.unshieldAmount],
    })) as bigint;
    const paid = a.feeAmount > protocolFee ? a.feeAmount - protocolFee : 0n;
    if (paid < required) throw new InsufficientFeeError(a.token, paid, required);
    return paid;
  }

  private decodeProvenArgs(bundle: Bundle): ProvenArgs {
    const same = (x: Address, y: Address) => x.toLowerCase() === y.toLowerCase();
    if (bundle.kind === "transact") {
      if (!same(bundle.to, this.config.poolAddress)) throw new WrongBundleTargetError(bundle.kind, bundle.to);
      const { functionName, args } = decodeFunctionData({ abi: FEE_ABI, data: bundle.calldata });
      if (functionName !== "transact") throw new Error("transact bundle calldata is not transact()");
      return args[0] as ProvenArgs;
    }
    if (bundle.kind === "relay") {
      if (!same(bundle.to, this.config.relayAddress)) throw new WrongBundleTargetError(bundle.kind, bundle.to);
      const { functionName, args } = decodeFunctionData({ abi: FEE_ABI, data: bundle.calldata });
      if (functionName !== "relay") throw new Error("relay bundle calldata is not relay()");
      return args[0] as ProvenArgs;
    }
    throw new Error(`${bundle.kind} bundles carry no proof-bound broadcaster fee`);
  }

  /**
   * Submits `bundle` if this node is either the current assignee or the
   * assignment window has elapsed (the censorship-fallback path). Simulates
   * first (an `eth_call` against the exact calldata) so a doomed
   * transaction never gets broadcast and burns real gas.
   *
   * `unshieldToOrigin` has no fee field on-chain either (the exit must always work, and the
   * user can always submit it themselves), so it follows the same sponsored path.
   *
   * `shieldMeta` bundles (`to` = the deployed ERC2771Forwarder, `calldata` = an encoded
   * `execute(ForwardRequestData)` call — see CurtainPool.sol's header and
   * CurtainPoolMetaTx.t.sol) submit through this exact same generic path with no special
   * handling needed: the forwarder itself verifies the signer's EIP-712 signature on-chain,
   * so there's nothing meta-tx-specific left for the broadcaster to check. They also skip
   * `checkFee()` — unlike `transact`/`relay`/`unshieldToOrigin`, a shieldMeta's fee isn't
   * bound into any proof's public signals (there is no proof; it just forwards a plain
   * `shield()` call), so there is no proof-enforced broadcaster fee to require. Per
   * ERC2771Forwarder's own header, gasless relaying like this is expected to run on an
   * out-of-band incentive (e.g. an app sponsoring its users' first shield as a user-
   * acquisition cost), not a per-bundle fee schedule.
   */
  async submitBundle(bundle: Bundle, nowMs: number = Date.now()): Promise<Hex> {
    await this.trackBundle(bundle, nowMs);
    const tracked = this.tracked.get(bundleId(bundle))!;

    const isAssignee = tracked.assignee === undefined || tracked.assignee.toLowerCase() === this.config.address.toLowerCase();
    if (!isAssignee) {
      const windowElapsed = assignmentWindowElapsed(tracked.assignedAtMs, nowMs, this.config.assignmentWindowMs);
      if (!windowElapsed) throw new NotYetAssignableError(tracked.assignee!, tracked.assignedAtMs + this.config.assignmentWindowMs);
    }

    // transact/relay: the proof must pay this broadcaster. shieldMeta and unshieldToOrigin have
    // no proof-bound fee (see above), so relaying them is sponsored by the operator.
    if (bundle.kind === "transact" || bundle.kind === "relay") await this.checkFee(bundle);

    await this.publicClient.call({ account: this.config.address, to: bundle.to, data: bundle.calldata });

    const hash = await this.walletClient.sendTransaction({
      chain: this.walletClient.chain,
      account: this.config.address,
      to: bundle.to,
      data: bundle.calldata,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
    if (receipt.status !== "success") throw new Error(`submitted bundle reverted on-chain: ${hash}`);

    this.markMined(bundle, hash);
    return hash;
  }

  /**
   * True if this bundle was assigned to someone other than `nowMs`'s caller
   * (i.e. not this node), that assignee's window has elapsed, and the
   * bundle still isn't mined — the precondition for filing censorship
   * evidence against the assignee. Gathering the attestor signatures a real
   * `BroadcasterBond.slash()` call needs is a separate, off-chain
   * governance process this method does not perform — see
   * Curtain_Build.md §11.
   */
  detectCensorship(bundle: Bundle, nowMs: number = Date.now()): { censored: boolean; assignee?: Address } {
    const tracked = this.tracked.get(bundleId(bundle));
    if (!tracked || !tracked.assignee || tracked.minedTxHash) return { censored: false };
    const windowElapsed = assignmentWindowElapsed(tracked.assignedAtMs, nowMs, this.config.assignmentWindowMs);
    return { censored: windowElapsed, assignee: tracked.assignee };
  }

  publishFeeSchedule(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [token, amount] of this.config.feeSchedule) out[token] = amount.toString();
    return out;
  }
}
