/**
 * Curtain keeper: fetches signed payouts from an operator's public API and submits them to
 * CurtainVault, earning each payout's `keeperFee`. The signature fixes recipient and amounts,
 * so a keeper can't redirect anything; the worst it can do is not submit.
 *
 * A keeper only submits payouts whose fee covers its gas (priced in the payout token by
 * `minFee`, per token), and skips ones already submitted by someone else.
 */
import { getAddress, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

const VAULT_ABI = parseAbi([
  "struct Payout { address recipient; address token; uint256 amount; uint256 protocolFee; uint256 keeperFee; uint256 deadline; uint256 nonce; bytes32 tag; }",
  "function payout(Payout p, bytes signature)",
  "function tagUsed(bytes32) view returns (bool)",
]);

export interface SignedPayout {
  recipient: Address;
  token: Address;
  amount: string;
  protocolFee: string;
  keeperFee: string;
  deadline: string;
  nonce: string;
  tag: Hex;
  signature: Hex;
}

export interface KeeperConfig {
  operatorApi: string;
  vault: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Minimum keeper fee worth submitting for, per token (raw units). Missing token = any fee. */
  minFee?: Record<string, bigint>;
  fetch?: typeof fetch;
}

export class Keeper {
  constructor(private cfg: KeeperConfig) {}

  async pending(): Promise<SignedPayout[]> {
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.operatorApi}/payouts/pending`);
    if (!res.ok) throw new Error(`operator API: HTTP ${res.status}`);
    return (await res.json()) as SignedPayout[];
  }

  /** One pass: submits every worthwhile, unexpired, not-yet-submitted payout. Returns tx hashes. */
  async tick(nowSec: number): Promise<Hex[]> {
    const { publicClient, walletClient, vault } = this.cfg;
    const sent: Hex[] = [];
    for (const p of await this.pending()) {
      if (BigInt(p.deadline) <= BigInt(nowSec)) continue;
      const floor = this.cfg.minFee?.[getAddress(p.token)];
      if (floor !== undefined && BigInt(p.keeperFee) < floor) continue;
      if (await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "tagUsed", args: [p.tag] })) continue;
      try {
        const hash = await walletClient.writeContract({
          chain: walletClient.chain, account: walletClient.account!, address: vault, abi: VAULT_ABI, functionName: "payout",
          args: [{
            recipient: p.recipient, token: p.token, amount: BigInt(p.amount), protocolFee: BigInt(p.protocolFee),
            keeperFee: BigInt(p.keeperFee), deadline: BigInt(p.deadline), nonce: BigInt(p.nonce), tag: p.tag,
          }, p.signature],
        });
        const r = await publicClient.waitForTransactionReceipt({ hash });
        if (r.status === "success") sent.push(hash);
      } catch (e) {
        // Usually another keeper won the race (TagUsed); nothing to do.
        console.error(`payout ${p.tag}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    }
    return sent;
  }
}
