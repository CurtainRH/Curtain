/**
 * CurtainClient end to end on a real chain with a live operator: swap, escape-hatch refund,
 * and stake-to-earn with lock tiers.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { migrate } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { createApi, mockQuoter, mockRoute, Operator } from "@curtain/operator";
import { parseAbi, parseEther, type Address, type Hex } from "viem";
import { startDevnet, type Devnet } from "../../../scripts/devnet";
import { CurtainClient, ERC20_ABI, findDepositId, positionsOf, STAKING_ABI, type PendingTicket } from "../src/index";

setDefaultTimeout(180_000);
const MOCK = parseAbi(["function mint(address to, uint256 amount)", "function setRate(address tokenIn, address tokenOut, uint256 rateWad)"]);

let d: Devnet;
let server: ReturnType<typeof Bun.serve>;
let op: Operator;
let client: CurtainClient;
let chainNow = 0;
let tokens: Record<string, Address>;

const wait = async (hash: Hex) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
};
const bal = (token: Address, who: Address) => d.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [who] });
const warp = async (s: number) => {
  await d.testClient.increaseTime({ seconds: s });
  await d.testClient.mine({ blocks: 1 });
  chainNow = await d.now();
};

beforeAll(async () => {
  d = await startDevnet(8681);
  tokens = d.deployment.tokens;
  const dep = d.wallets.deployer;
  const mock = (address: Address, functionName: "mint" | "setRate", args: readonly unknown[]) =>
    dep.writeContract({ chain: d.chain, account: dep.account!, address, abi: MOCK, functionName, args: args as never }).then(wait);
  await mock(d.deployment.router, "setRate", [tokens["USDG"], tokens["SPY"], parseEther("0.002")]);
  await mock(tokens["SPY"]!, "mint", [d.deployment.router, parseEther("1000")]);
  await mock(tokens["USDG"]!, "mint", [d.wallets.user.account!.address, parseEther("10000")]);

  const db = await pgliteDb();
  await migrate(db);
  op = new Operator({
    db, publicClient: d.publicClient, walletClient: d.wallets.operator, chainId: 31337, vault: d.deployment.vault,
    router: d.deployment.router, route: mockRoute, quote: mockQuoter(d.publicClient, d.deployment.router), keeperFeeBps: 5, startBlock: await d.publicClient.getBlockNumber(),
  });
  chainNow = await d.now();
  server = Bun.serve({ port: 0, fetch: createApi({ db, operator: op, vault: d.deployment.vault, tokens, keeperFeeBps: 5, now: () => chainNow }) });
  client = new CurtainClient({
    apiUrl: `http://127.0.0.1:${server.port}`, publicClient: d.publicClient, walletClient: d.wallets.user, stakingAddress: d.deployment.staking,
  });
});

afterAll(() => {
  server?.stop();
  d?.stop();
});

async function operatorTick() {
  const now = await d.now();
  await op.syncChain();
  await op.processDue(now);
  await op.submitSettlements(now);
  await op.syncChain();
}

describe("CurtainClient (e2e)", () => {
  it("swaps privately: intent + deposit via the client, paid to a fresh address", async () => {
    const fresh = "0x00000000000000000000000000000000000Fe5E1" as Address;
    chainNow = await d.now();
    const s = await client.swap({ tokenIn: tokens["USDG"]!, amountIn: parseEther("500"), tokenOut: tokens["SPY"]!, recipient: fresh, minOut: parseEther("0.99"), delaySeconds: 0 });
    expect(s.ticket.depositId).toBe("1");
    // Poll like the app would: under load the node can serve an event a moment late.
    for (let i = 0; i < 50 && (await client.status(s.intentId)).status !== "paid"; i++) {
      await operatorTick();
      await Bun.sleep(200);
    }
    expect((await client.status(s.intentId)).status).toBe("paid");
    expect(await bal(tokens["SPY"]!, fresh)).toBeGreaterThanOrEqual(parseEther("0.99"));
  });

  it("saves the ticket before depositing, recovers the deposit id, and refuses a foreign vault", async () => {
    const me = d.wallets.user.account!.address;
    chainNow = await d.now();
    let pending: PendingTicket | undefined;
    const s = await client.swap(
      { tokenIn: tokens["USDG"]!, amountIn: parseEther("10"), tokenOut: tokens["SPY"]!, recipient: me, minOut: parseEther("0.01"), delaySeconds: 3600 },
      { onIntent: (p) => { pending = p; } },
    );
    expect(pending).toBeDefined();
    expect(pending!.salt).toBe(s.ticket.salt);
    expect(await findDepositId(d.publicClient, pending!, me)).toBe(BigInt(s.ticket.depositId));

    // A client pinned to the real vault refuses tickets (and API responses) naming another vault.
    const pinned = new CurtainClient({ apiUrl: `http://127.0.0.1:${server.port}`, publicClient: d.publicClient, walletClient: d.wallets.user, vaultAddress: d.deployment.vault });
    await expect(pinned.requestRefund({ ...s.ticket, vault: "0x000000000000000000000000000000000000dEaD" })).rejects.toThrow(/Refusing to use vault/);
    const wrongPin = new CurtainClient({ apiUrl: `http://127.0.0.1:${server.port}`, publicClient: d.publicClient, walletClient: d.wallets.user, vaultAddress: "0x000000000000000000000000000000000000dEaD" });
    const usdgBefore = await bal(tokens["USDG"]!, me);
    await expect(wrongPin.swap({ tokenIn: tokens["USDG"]!, amountIn: parseEther("1"), tokenOut: tokens["SPY"]!, recipient: me, minOut: 1n, delaySeconds: 0 })).rejects.toThrow(/Refusing to use vault/);
    expect(await bal(tokens["USDG"]!, me)).toBe(usdgBefore); // nothing approved or sent
  });

  it("refunds through the escape ticket when the operator never pays", async () => {
    const me = d.wallets.user.account!.address;
    chainNow = await d.now();
    const s = await client.swap({ tokenIn: tokens["USDG"]!, amountIn: parseEther("300"), tokenOut: tokens["SPY"]!, recipient: me, minOut: parseEther("0.5"), delaySeconds: 0 });
    const before = await bal(tokens["USDG"]!, me);

    await warp(client.refundAvailableAt(s.ticket) - (await d.now()));
    await client.requestRefund(s.ticket);
    await warp(601);
    await client.finalizeRefund(s.ticket);
    expect((await bal(tokens["USDG"]!, me)) - before).toBe(parseEther("300"));
  });

  it("stakes into a lock tier and earns plugged-in emissions", async () => {
    const hood = tokens["HOOD"]!; // stands in for $CRTN until it launches
    const admin = d.wallets.deployer;
    const me = d.wallets.user.account!.address;
    const tx = (address: Address, abi: typeof STAKING_ABI | typeof MOCK | typeof ERC20_ABI, functionName: string, args: readonly unknown[]) =>
      admin.writeContract({ chain: d.chain, account: admin.account!, address, abi: abi as never, functionName: functionName as never, args: args as never }).then(wait);

    await tx(hood, MOCK, "mint", [admin.account!.address, parseEther("1000000")]);
    await tx(hood, MOCK, "mint", [me, parseEther("1000")]);
    await tx(d.deployment.staking, STAKING_ABI, "setTokens", [hood, hood]);
    await tx(hood, ERC20_ABI, "approve", [d.deployment.staking, parseEther("18000")]);
    await tx(d.deployment.staking, STAKING_ABI, "notifyRewardAmount", [parseEther("18000"), 180n * 86400n]);

    const id = await client.stake(hood, parseEther("1000"), 2);
    const positions = await positionsOf(d.publicClient, d.deployment.staking, me, 0n);
    expect(positions.map((p) => p.id)).toEqual([id]);
    expect(positions[0]!.amount).toBe(parseEther("1000"));
    expect(positions[0]!.weighted).toBe(parseEther("2000")); // 180-day tier, 2x
    await warp(90 * 86400);
    expect(await client.earned(id)).toBeGreaterThan(parseEther("8900")); // ~half of 18k: the only staker
    await expect(client.withdraw(id)).rejects.toThrow(); // still locked
    await client.claim(id);

    await warp(91 * 86400);
    const before = await bal(hood, me);
    await client.withdraw(id);
    expect((await bal(hood, me)) - before).toBeGreaterThan(parseEther("1000") + parseEther("8900"));
  });
});
