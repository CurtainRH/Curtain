/**
 * Chain -> Postgres indexer for the public aggregates the API serves (Curtain_Backend.md §3,
 * §3.1). Reads events from CurtainPool, ScreeningGate, AssetGate, BroadcasterBond and
 * SolvencyVerifier in block ranges and upserts:
 *   tokens (+ TVL = pool balance), commitments (standby/cleared/flagged), providers,
 *   broadcasters, solvency, activity (daily counts).
 * It never stores who shielded or who received anything: no origin, no unshield recipient,
 * no note-to-note links (the spec's privacy rule, and a §9 launch gate).
 */
import { parseAbi, type Address, type Hex, type Log, type PublicClient } from "viem";
import type { Db } from "@curtain/db";

export const INDEXER_ABI = parseAbi([
  // CurtainPool
  "event Shield(bytes32 indexed commit, uint32 leafIndex, address indexed token, uint256 rawAmount)",
  "event Transact(bytes32[] nullifiers, bytes32[] newCommits, bytes32 root, address unshieldTo)",
  "event UnshieldToOrigin(bytes32 indexed commit, address indexed origin, uint256 rawAmount)",
  // ScreeningGate
  "event Cleared(bytes32 indexed commit)",
  "event Flagged(bytes32 indexed commit, uint8 indexed providerId)",
  "event ProviderUpdated(uint8 indexed id, bytes32 listRoot, bytes32 flagRoot)",
  "event ProviderRemoved(uint8 indexed id)",
  // AssetGate
  "event TokenRegistered(address indexed token, bool is8056, address feed)",
  "event TokenDeregistered(address indexed token)",
  // BroadcasterBond
  "event Bonded(address indexed broadcaster, uint256 amount, uint256 totalBonded)",
  "event FeesSet(address indexed broadcaster, uint16 feeBps, uint16 gasMarkupBps)",
  "event Unbonded(address indexed broadcaster, uint256 amount)",
  "event Slashed(address indexed broadcaster, uint256 amount, bytes32 evidenceRoot)",
  // SolvencyVerifier
  "event EpochFinalized(uint256 indexed epoch, address indexed token, bool ok, uint256 totalLiveNotes, uint256 poolBalance)",
  // reads
  "function standby() view returns (uint64)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function uiMultiplier() view returns (uint256)",
]);

export interface IndexerAddresses {
  pool: Address;
  gate: Address;
  assetGate: Address;
  bond: Address;
  solvency: Address;
  relayAdapt: Address;
}

const WAD = 10n ** 18n;
type DecodedLog = Log<bigint, number, false, undefined, true, typeof INDEXER_ABI>;

export class Indexer {
  constructor(
    private db: Db,
    private client: PublicClient,
    private addrs: IndexerAddresses,
    private chunkSize = 2_000n,
  ) {}

  async cursor(): Promise<bigint> {
    const rows = await this.db.query<{ block: string }>("SELECT block FROM indexer_cursor WHERE id = 1");
    return rows[0] ? BigInt(rows[0].block) : -1n;
  }

  /** Indexes every block after the cursor up to `head` (default: latest). Returns the new cursor. */
  async syncTo(head?: bigint): Promise<bigint> {
    const target = head ?? (await this.client.getBlockNumber());
    let from = (await this.cursor()) + 1n;
    while (from <= target) {
      const to = from + this.chunkSize - 1n < target ? from + this.chunkSize - 1n : target;
      const logs = (await this.client.getLogs({
        address: Object.values(this.addrs).filter((a) => a !== this.addrs.relayAdapt),
        events: INDEXER_ABI.filter((x) => x.type === "event"),
        fromBlock: from,
        toBlock: to,
        strict: true,
      })) as DecodedLog[];
      const blockTimes = new Map<bigint, bigint>();
      for (const log of logs) {
        if (!blockTimes.has(log.blockNumber)) {
          blockTimes.set(log.blockNumber, (await this.client.getBlock({ blockNumber: log.blockNumber })).timestamp);
        }
      }
      const standby = logs.some((l) => l.eventName === "Shield")
        ? await this.client.readContract({ address: this.addrs.gate, abi: INDEXER_ABI, functionName: "standby" })
        : 0n;

      await this.db.transaction(async (tx: Db) => {
        for (const log of logs) await this.apply(tx, log, blockTimes.get(log.blockNumber)!, standby);
        await tx.query(
          "INSERT INTO indexer_cursor (id, block) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET block = EXCLUDED.block",
          [to.toString()],
        );
      });
      from = to + 1n;
    }
    await this.refreshTokenStats();
    return target;
  }

  private async apply(db: Db, log: DecodedLog, ts: bigint, standby: bigint): Promise<void> {
    const at = new Date(Number(ts) * 1000).toISOString();
    const bump = (kind: string) =>
      db.query(
        "INSERT INTO activity (day, kind, count) VALUES ($1::date, $2, 1) ON CONFLICT (day, kind) DO UPDATE SET count = activity.count + 1",
        [at, kind],
      );
    const from = (a: Address) => log.address.toLowerCase() === a.toLowerCase();

    switch (log.eventName) {
      case "Shield": {
        if (!from(this.addrs.pool)) return;
        const until = new Date(Number(ts + standby) * 1000).toISOString();
        await db.query(
          `INSERT INTO commitments (leaf_index, commit, block, shielded_at, standby_until)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (leaf_index) DO NOTHING`,
          [log.args.leafIndex, log.args.commit, log.blockNumber.toString(), at, until],
        );
        await bump("shield");
        return;
      }
      case "Transact": {
        if (!from(this.addrs.pool)) return;
        const to = log.args.unshieldTo.toLowerCase();
        await bump(to === this.addrs.relayAdapt.toLowerCase() ? "relay" : BigInt(to) === 0n ? "transact" : "unshield");
        return;
      }
      case "UnshieldToOrigin":
        if (from(this.addrs.pool)) await bump("unshield_to_origin");
        return;
      case "Cleared":
        if (from(this.addrs.gate)) await db.query("UPDATE commitments SET cleared = true WHERE commit = $1", [log.args.commit]);
        return;
      case "Flagged":
        if (from(this.addrs.gate)) await db.query("UPDATE commitments SET flagged = true WHERE commit = $1", [log.args.commit]);
        return;
      case "ProviderUpdated":
        if (!from(this.addrs.gate)) return;
        await db.query(
          `INSERT INTO providers (id, name, root, flag_root, updated_at, stale, active) VALUES ($1, '', $2, $3, $4, false, true)
           ON CONFLICT (id) DO UPDATE SET root = EXCLUDED.root, flag_root = EXCLUDED.flag_root,
             updated_at = EXCLUDED.updated_at, stale = false, active = true`,
          [log.args.id, log.args.listRoot, log.args.flagRoot, at],
        );
        return;
      case "ProviderRemoved":
        if (from(this.addrs.gate)) await db.query("UPDATE providers SET active = false WHERE id = $1", [log.args.id]);
        return;
      case "TokenRegistered": {
        if (!from(this.addrs.assetGate)) return;
        const token = log.args.token;
        const symbol = await this.client
          .readContract({ address: token, abi: INDEXER_ABI, functionName: "symbol" })
          .catch(() => "");
        await db.query(
          `INSERT INTO tokens (addr, symbol, is8056, multiplier) VALUES ($1, $2, $3, $4)
           ON CONFLICT (addr) DO UPDATE SET symbol = EXCLUDED.symbol, is8056 = EXCLUDED.is8056`,
          [token.toLowerCase(), symbol, log.args.is8056, WAD.toString()],
        );
        return;
      }
      case "TokenDeregistered":
        if (from(this.addrs.assetGate)) await db.query("DELETE FROM tokens WHERE addr = $1", [log.args.token.toLowerCase()]);
        return;
      case "Bonded":
        if (!from(this.addrs.bond)) return;
        await db.query(
          `INSERT INTO broadcasters (addr, bond, fee_bps) VALUES ($1, $2, 0)
           ON CONFLICT (addr) DO UPDATE SET bond = EXCLUDED.bond`,
          [log.args.broadcaster.toLowerCase(), log.args.totalBonded.toString()],
        );
        return;
      case "FeesSet":
        if (!from(this.addrs.bond)) return;
        await db.query("UPDATE broadcasters SET fee_bps = $2, gas_markup_bps = $3 WHERE addr = $1", [
          log.args.broadcaster.toLowerCase(), log.args.feeBps, log.args.gasMarkupBps,
        ]);
        return;
      case "Unbonded":
        if (from(this.addrs.bond)) await db.query("DELETE FROM broadcasters WHERE addr = $1", [log.args.broadcaster.toLowerCase()]);
        return;
      case "Slashed":
        if (!from(this.addrs.bond)) return;
        await db.query("UPDATE broadcasters SET bond = bond - $2, failed = failed + 1 WHERE addr = $1", [
          log.args.broadcaster.toLowerCase(), log.args.amount.toString(),
        ]);
        return;
      case "EpochFinalized":
        if (!from(this.addrs.solvency)) return;
        await db.query(
          `INSERT INTO solvency (epoch, ts, token, pool_balance, live_notes, tx) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (epoch, token) DO NOTHING`,
          [log.args.epoch.toString(), at, log.args.token.toLowerCase(), log.args.poolBalance.toString(),
            log.args.totalLiveNotes.toString(), log.transactionHash as Hex],
        );
        return;
    }
  }

  /** TVL = the pool's balance of each registered token; multiplier from uiMultiplier() for 8056 tokens. */
  private async refreshTokenStats(): Promise<void> {
    const tokens = await this.db.query<{ addr: Address; is8056: boolean }>("SELECT addr, is8056 FROM tokens");
    for (const t of tokens) {
      const tvl = await this.client.readContract({ address: t.addr, abi: INDEXER_ABI, functionName: "balanceOf", args: [this.addrs.pool] });
      const multiplier = t.is8056
        ? await this.client.readContract({ address: t.addr, abi: INDEXER_ABI, functionName: "uiMultiplier" }).catch(() => WAD)
        : WAD;
      await this.db.query("UPDATE tokens SET tvl = $2, multiplier = $3 WHERE addr = $1", [t.addr, tvl.toString(), multiplier.toString()]);
    }
  }
}
