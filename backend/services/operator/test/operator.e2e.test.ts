/**
 * Full private-swap lifecycle on a real chain: Anvil + Deploy.s.sol, operator DB on PGlite
 * (real Postgres in WASM), the API the frontend calls, and a third-party keeper.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { migrate, type Db } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { parseAbi, parseEther, type Address, type Hex } from "viem";
import { startDevnet, type Devnet } from "../../../scripts/devnet";
import { ERC20_ABI, VAULT_ABI } from "../src/abi";
import { createApi } from "../src/api";
import { Operator, settleArgs } from "../src/operator";
import { mockQuoter, mockRoute } from "../src/routes";

setDefaultTimeout(180_000);

const MOCK = parseAbi([
  "function mint(address to, uint256 amount)",
  "function setRate(address tokenIn, address tokenOut, uint256 rateWad)",
]);

let d: Devnet;
let db: Db;
let op: Operator;
let api: (req: Request) => Promise<Response>;
let chainNow = 0; // the API's clock follows chain time, which these tests fast-forward
let usdg: Address;
let nvda: Address;
const recipient = "0x000000000000000000000000000000000000bEEF" as Address;

async function wait(hash: Hex) {
  const r = await d.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return r;
}

async function call(path: string, body?: unknown) {
  chainNow = await d.now();
  const res = await api(new Request(`http://op${path}`, body
    ? { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }
    : undefined));
  return { status: res.status, body: (await res.json()) as any };
}

/** User side of a swap: create the intent via the API, then deposit into the vault. */
async function swap(amountIn: bigint, minOut: bigint, delaySeconds = 0) {
  const { status, body } = await call("/intents", {
    tokenIn: usdg, amountIn: amountIn.toString(), tokenOut: nvda, recipient, minOut: minOut.toString(), delaySeconds,
    depositor: d.wallets.user.account!.address,
  });
  expect(status).toBe(201);
  const user = d.wallets.user;
  await wait(await user.writeContract({ chain: d.chain, account: user.account!, address: usdg, abi: ERC20_ABI, functionName: "approve", args: [d.deployment.vault, amountIn] }));
  const r = await wait(await user.writeContract({
    chain: d.chain, account: user.account!, address: d.deployment.vault, abi: VAULT_ABI, functionName: "deposit", args: [usdg, amountIn, body.deadlineHash],
  }));
  // Poll like a real client: the node's log index can trail its block number by a moment;
  // the operator's rescan picks the deposit up on the next sync.
  let intent: any;
  for (let i = 0; i < 100; i++) {
    await op.syncChain();
    intent = (await call(`/intents/${body.id}`)).body;
    if (intent.depositId) break;
    await Bun.sleep(100);
  }
  expect(intent.depositId).toBeTruthy();
  return { id: body.id as string, deadline: BigInt(body.deadline), salt: body.salt as Hex, depositId: BigInt(intent.depositId), block: r.blockNumber };
}

/** Syncs until `done()` holds, like a client polling: under load the node can serve an event a
 * moment after its receipt. */
async function syncUntil(done: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    await op.syncChain();
    if (await done()) return;
    await Bun.sleep(100);
  }
  throw new Error("condition never reached");
}
const statusIs = (id: string, want: string) => async () => (await call(`/intents/${id}`)).body.status === want;

async function balance(token: Address, who: Address) {
  return d.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] });
}

async function warp(seconds: number) {
  await d.testClient.increaseTime({ seconds });
  await d.testClient.mine({ blocks: 1 });
}

beforeAll(async () => {
  d = await startDevnet(8661);
  usdg = d.deployment.tokens["USDG"]!;
  nvda = d.deployment.tokens["NVDA"]!;
  const deployer = d.wallets.deployer;
  const tx = (address: Address, functionName: "mint" | "setRate", args: readonly unknown[]) =>
    deployer.writeContract({ chain: d.chain, account: deployer.account!, address, abi: MOCK, functionName, args: args as never }).then(wait);
  await tx(d.deployment.router, "setRate", [usdg, nvda, parseEther("0.005")]); // 200 USDG per NVDA
  await tx(nvda, "mint", [d.deployment.router, parseEther("1000")]);
  await tx(usdg, "mint", [d.wallets.user.account!.address, parseEther("100000")]);

  db = await pgliteDb();
  await migrate(db);
  op = new Operator({
    db, publicClient: d.publicClient as never, walletClient: d.wallets.operator as never, chainId: 31337,
    vault: d.deployment.vault, router: d.deployment.router, route: mockRoute, quote: mockQuoter(d.publicClient, d.deployment.router), keeperFeeBps: 5,
    startBlock: await d.publicClient.getBlockNumber(),
  });
  api = createApi({ db, operator: op, vault: d.deployment.vault, tokens: d.deployment.tokens, keeperFeeBps: 5, now: () => chainNow });
});

afterAll(() => d?.stop());

describe("private swap lifecycle (e2e)", () => {
  it("instant swap: deposit -> signed settlement (swap + payout) landed atomically by a third-party keeper", async () => {
    const s = await swap(parseEther("1000"), parseEther("4.9"));
    expect((await call(`/intents/${s.id}`)).body.status).toBe("deposited");

    await op.processDue(await d.now());
    expect((await call(`/intents/${s.id}`)).body.status).toBe("settling");
    // Nothing is swapped until the settlement lands: the USDG is still in the vault.
    expect(await balance(usdg, d.deployment.vault)).toBeGreaterThanOrEqual(parseEther("1000"));

    // A keeper that isn't the operator picks the settlement up from the public API and lands it.
    const pending = (await call("/settlements/pending")).body as any[];
    expect(pending.length).toBe(1);
    const keeper = d.wallets.keeper;
    const keeperBefore = await balance(nvda, keeper.account!.address);
    await wait(await keeper.writeContract({
      chain: d.chain, account: keeper.account!, address: d.deployment.vault, abi: VAULT_ABI, functionName: "settle",
      args: settleArgs(pending[0]),
    }));
    await syncUntil(statusIs(s.id, "paid"));

    const gross = (parseEther("5") * 9950n) / 10000n; // 1000 USDG at 200/NVDA, minus 0.5% slippage tolerance
    const fee = (gross * 20n) / 10000n;
    const keeperFee = (gross * 5n) / 10000n;
    expect(await balance(nvda, recipient)).toBe(gross - fee - keeperFee);
    expect(await balance(nvda, d.deployment.treasury)).toBe(fee);
    expect((await balance(nvda, keeper.account!.address)) - keeperBefore).toBe(keeperFee);
    const status = (await call(`/intents/${s.id}`)).body;
    expect(status.status).toBe("paid");
    expect(status.payoutTx).toMatch(/^0x/);
    expect(((await call("/settlements/pending")).body as any[]).length).toBe(0);

    // The user tries to double-dip with the escape hatch after being paid: the operator challenges.
    await warp(Number(s.deadline) - (await d.now()) + 180);
    await wait(await d.wallets.user.writeContract({
      chain: d.chain, account: d.wallets.user.account!, address: d.deployment.vault, abi: VAULT_ABI,
      functionName: "requestRefund", args: [s.depositId, s.deadline, s.salt],
    }));
    // Collect what every sync challenged (syncUntil would drop its own sync's result).
    const challenged: bigint[] = [];
    for (let i = 0; i < 100 && challenged.length === 0; i++) {
      challenged.push(...(await op.syncChain()).challenged);
      if (challenged.length === 0) await Bun.sleep(100);
    }
    expect(challenged).toEqual([s.depositId]);
    await warp(11 * 60);
    await expect(d.wallets.user.writeContract({
      chain: d.chain, account: d.wallets.user.account!, address: d.deployment.vault, abi: VAULT_ABI, functionName: "finalizeRefund", args: [s.depositId],
    }).then(wait)).rejects.toThrow();
    await syncUntil(statusIs(s.id, "challenged"));
  });

  it("escape hatch: an unpaid deposit is refunded after deadline + 3 min + 10 min challenge window", async () => {
    const s = await swap(parseEther("500"), parseEther("2"));
    const userAddr = d.wallets.user.account!.address;
    const before = await balance(usdg, userAddr);

    // Operator is "down": never processes it.
    await warp(Number(s.deadline) - (await d.now()) + 180);
    await wait(await d.wallets.user.writeContract({
      chain: d.chain, account: d.wallets.user.account!, address: d.deployment.vault, abi: VAULT_ABI,
      functionName: "requestRefund", args: [s.depositId, s.deadline, s.salt],
    }));
    await syncUntil(statusIs(s.id, "refund_requested"));
    // Once a refund is requested the operator must not settle it.
    await op.processDue(await d.now());
    expect((await call(`/intents/${s.id}`)).body.status).toBe("refund_requested");

    await warp(10 * 60 + 1);
    await wait(await d.wallets.user.writeContract({
      chain: d.chain, account: d.wallets.user.account!, address: d.deployment.vault, abi: VAULT_ABI, functionName: "finalizeRefund", args: [s.depositId],
    }));
    await syncUntil(statusIs(s.id, "refunded"));
    expect((await balance(usdg, userAddr)) - before).toBe(parseEther("500"));
  });

  it("delayed swap waits for its random payout time; slippage failures retry instead of paying badly", async () => {
    const s = await swap(parseEther("200"), parseEther("0.9"), 3600);
    const [row] = await db.query<{ pay_at: string }>("SELECT pay_at::text FROM intents WHERE id = $1", [s.id]);
    const payAt = Number(row!.pay_at);
    expect(payAt).toBeGreaterThanOrEqual((await d.now()) - 60);

    if (payAt > (await d.now())) {
      await op.processDue((await d.now()) - 1);
      expect((await call(`/intents/${s.id}`)).body.status).toBe("deposited");
    }

    // Price crashes 10x: the intent's minimum can't be met, so nothing is signed and it stays queued.
    const deployer = d.wallets.deployer;
    await wait(await deployer.writeContract({ chain: d.chain, account: deployer.account!, address: d.deployment.router, abi: MOCK, functionName: "setRate", args: [usdg, nvda, parseEther("0.0005")] }));
    await warp(Math.max(0, payAt - (await d.now())) + 1);
    expect(await op.processDue(await d.now())).toEqual([]);
    expect((await call(`/intents/${s.id}`)).body.status).toBe("deposited");

    // Price recovers: next tick pays, with the operator's own keeper this time.
    await wait(await deployer.writeContract({ chain: d.chain, account: deployer.account!, address: d.deployment.router, abi: MOCK, functionName: "setRate", args: [usdg, nvda, parseEther("0.005")] }));
    const before = await balance(nvda, recipient);
    await op.processDue(await d.now());
    await op.submitSettlements(await d.now());
    await syncUntil(statusIs(s.id, "paid"));
    expect((await balance(nvda, recipient)) - before).toBeGreaterThanOrEqual(parseEther("0.9"));
  });

  it("an unlanded settlement expires and its deposit is re-settled at the next price", async () => {
    const s = await swap(parseEther("400"), parseEther("1.9"));
    const [first] = await op.processDue(await d.now());
    expect(first).toBeDefined();
    // Nobody lands it; its TTL (5 min) passes but the intent's own deadline hasn't.
    await warp(301);
    const [second] = await op.processDue(await d.now());
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    const [row] = await db.query<{ status: string }>("SELECT status FROM settlements WHERE id = $1", [first]);
    expect(row!.status).toBe("expired");
    await op.submitSettlements(await d.now());
    await syncUntil(statusIs(s.id, "paid"));
  });

  it("re-reading old blocks is harmless: statuses unchanged, no duplicate challenges", async () => {
    const before = await db.query("SELECT id, status FROM intents ORDER BY id");
    await db.query("UPDATE chain_cursor SET block = 0 WHERE id = 1");
    const { challenged } = await op.syncChain();
    expect(challenged).toEqual([]);
    expect(await db.query("SELECT id, status FROM intents ORDER BY id")).toEqual(before);
  });

  it("accepts token addresses in any casing from config", async () => {
    const lower = Object.fromEntries(Object.entries(d.deployment.tokens).map(([k, v]) => [k, v.toLowerCase() as Address]));
    const api2 = createApi({ db, operator: op, vault: d.deployment.vault, tokens: lower, keeperFeeBps: 5, now: () => chainNow });
    const res = await api2(new Request("http://op/intents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenIn: usdg, amountIn: "1", tokenOut: nvda, recipient, depositor: d.wallets.user.account!.address, minOut: "1", delaySeconds: 0 }),
    }));
    expect(res.status).toBe(201);
  });

  it("/status flags a stalled loop and recovers once it ticks", async () => {
    const before = await call("/status");
    expect(before.status).toBe(503);
    expect(before.body.problems).toContain("operator loop is not ticking");
    op.markTick();
    const after = await call("/status");
    expect(after.body.problems).not.toContain("operator loop is not ticking");
    expect(BigInt(after.body.operatorBalanceWei)).toBeGreaterThan(0n);
  });

  it("rejects bad intents", async () => {
    const depositor = d.wallets.user.account!.address;
    const base = { tokenIn: usdg, amountIn: "1", tokenOut: nvda, recipient, depositor, minOut: "1", delaySeconds: 0 };
    expect((await call("/intents", { ...base, tokenOut: "0x0000000000000000000000000000000000000001" })).status).toBe(400);
    expect((await call("/intents", { ...base, delaySeconds: 181 * 24 * 3600 })).status).toBe(400);
    expect((await call("/intents", { ...base, amountIn: "0" })).status).toBe(400);
    expect((await call("/intents", { ...base, recipient: "0x0000000000000000000000000000000000000000" })).status).toBe(400);
    expect((await call("/intents", { ...base, recipient: d.deployment.vault })).status).toBe(400);
    expect((await call("/intents", { ...base, depositor: undefined })).status).toBe(400);
  });
});
