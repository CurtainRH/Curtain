/**
 * Indexer against a real chain: Anvil + the stack deployed by Deploy.s.sol, indexed into
 * PGlite (real Postgres in WASM). Shields a note and checks tokens, TVL, commitments and
 * activity, and that the depositor's address appears nowhere in the database.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { migrate, type Db } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { parseAbi, parseEther } from "viem";
import { startDevnet, type Devnet } from "../../../scripts/devnet";
import { Indexer } from "../src/indexer";

setDefaultTimeout(120_000);

const ERC20 = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
const POOL = parseAbi(["function shield(address token, uint256 rawAmount, uint256 ownerPkX, uint256 blinding, bytes ephemeralPk, bytes ct)"]);

let d: Devnet;
let db: Db;
let indexer: Indexer;

beforeAll(async () => {
  d = await startDevnet(8651);
  db = await pgliteDb();
  await migrate(db);
  indexer = new Indexer(db, d.publicClient as never, {
    pool: d.addr("CurtainPool"), gate: d.addr("ScreeningGate"), assetGate: d.addr("AssetGate"),
    bond: d.addr("BroadcasterBond"), solvency: d.addr("SolvencyVerifier"), relayAdapt: d.addr("RelayAdapt"),
  });
});

afterAll(() => d?.stop());

describe("indexer (e2e)", () => {
  it("indexes registered tokens, a shield, TVL and activity — and nothing that identifies the user", async () => {
    const usdg = d.deployment.usdg;
    const user = d.user.account!.address;
    const tx = async (hash: `0x${string}`) => d.publicClient.waitForTransactionReceipt({ hash });
    await tx(await d.deployer.writeContract({ chain: d.chain, account: d.deployer.account!, address: usdg, abi: ERC20, functionName: "mint", args: [user, parseEther("100")] }));
    await tx(await d.user.writeContract({ chain: d.chain, account: d.user.account!, address: usdg, abi: ERC20, functionName: "approve", args: [d.addr("CurtainPool"), parseEther("100")] }));
    await tx(await d.user.writeContract({
      chain: d.chain, account: d.user.account!, address: d.addr("CurtainPool"), abi: POOL, functionName: "shield",
      args: [usdg, parseEther("100"), 7n, 9n, "0x", "0x"],
    }));

    await indexer.syncTo();

    const tokens = await db.query<{ symbol: string; tvl: string; is8056: boolean }>("SELECT symbol, tvl::text, is8056 FROM tokens ORDER BY symbol");
    expect(tokens.map((t) => t.symbol)).toEqual(["HOOD", "NVDA", "QQQ", "SPY", "TSLA", "USDG"]);
    expect(tokens.find((t) => t.symbol === "USDG")!.tvl).toBe((parseEther("100") - parseEther("0.2")).toString());
    expect(tokens.find((t) => t.symbol === "NVDA")!.is8056).toBe(true);

    const commits = await db.query<{ leaf_index: number; cleared: boolean; flagged: boolean; shielded_at: Date; standby_until: Date }>("SELECT * FROM commitments");
    expect(commits.length).toBe(1);
    expect(new Date(commits[0]!.standby_until).getTime() - new Date(commits[0]!.shielded_at).getTime()).toBe(60 * 60 * 1000); // no fresh providers yet -> 60 min

    const activity = await db.query<{ kind: string; count: string }>("SELECT kind, count::text FROM activity");
    expect(activity).toEqual([{ kind: "shield", count: "1" }]);

    // Idempotent: a second pass over the same blocks changes nothing.
    await indexer.syncTo();
    expect((await db.query("SELECT * FROM commitments")).length).toBe(1);

    // Privacy launch gate: the depositor's address is stored nowhere.
    const dump = JSON.stringify(await Promise.all(
      ["tokens", "commitments", "providers", "broadcasters", "solvency", "activity", "indexer_cursor"].map((t) => db.query(`SELECT * FROM ${t}`)),
    ));
    expect(dump.toLowerCase()).not.toContain(user.slice(2).toLowerCase());
  });
});
