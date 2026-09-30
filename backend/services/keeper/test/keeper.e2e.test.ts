/**
 * A third-party keeper against a live operator API (served over HTTP) on a real chain.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { migrate } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { createApi, ERC20_ABI, mockRoute, Operator, VAULT_ABI } from "@curtain/operator";
import { getAddress, parseAbi, parseEther, type Address, type Hex } from "viem";
import { startDevnet, type Devnet } from "../../../scripts/devnet";
import { Keeper } from "../src/index";

setDefaultTimeout(180_000);

const MOCK = parseAbi(["function mint(address to, uint256 amount)", "function setRate(address tokenIn, address tokenOut, uint256 rateWad)"]);
const recipient = "0x000000000000000000000000000000000000cafE" as Address;

let d: Devnet;
let server: ReturnType<typeof Bun.serve>;
let op: Operator;
let chainNow = 0;

const wait = async (hash: Hex) => {
  const r = await d.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
};

beforeAll(async () => {
  d = await startDevnet(8671);
  const { vault, router, tokens } = d.deployment;
  const dep = d.wallets.deployer;
  const mock = (address: Address, functionName: "mint" | "setRate", args: readonly unknown[]) =>
    dep.writeContract({ chain: d.chain, account: dep.account!, address, abi: MOCK, functionName, args: args as never }).then(wait);
  await mock(router, "setRate", [tokens["USDG"], tokens["TSLA"], parseEther("0.004")]);
  await mock(tokens["TSLA"]!, "mint", [router, parseEther("1000")]);
  await mock(tokens["USDG"]!, "mint", [d.wallets.user.account!.address, parseEther("10000")]);

  const db = await pgliteDb();
  await migrate(db);
  op = new Operator({
    db, publicClient: d.publicClient, walletClient: d.wallets.operator, chainId: 31337, vault, router, route: mockRoute,
    keeperFeeBps: 5, startBlock: await d.publicClient.getBlockNumber(),
  });
  server = Bun.serve({ port: 0, fetch: createApi({ db, operator: op, vault, tokens, keeperFeeBps: 5, now: () => chainNow }) });

  // One user swap, deposited and signed, waiting for a keeper.
  chainNow = await d.now();
  const res = await fetch(`http://127.0.0.1:${server.port}/intents`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tokenIn: tokens["USDG"], amountIn: parseEther("1000").toString(), tokenOut: tokens["TSLA"], recipient, minOut: parseEther("3.9").toString(), delaySeconds: 0 }),
  });
  const intent = (await res.json()) as { deadlineHash: Hex };
  const user = d.wallets.user;
  await wait(await user.writeContract({ chain: d.chain, account: user.account!, address: tokens["USDG"]!, abi: ERC20_ABI, functionName: "approve", args: [vault, parseEther("1000")] }));
  await wait(await user.writeContract({ chain: d.chain, account: user.account!, address: vault, abi: VAULT_ABI, functionName: "deposit", args: [tokens["USDG"]!, parseEther("1000"), intent.deadlineHash] }));
  for (let i = 0; i < 20; i++) {
    await op.syncChain();
    await op.processDue(await d.now());
    if ((await op.pendingPayouts(await d.now())).length > 0) break;
    await Bun.sleep(100);
  }
});

afterAll(() => {
  server?.stop();
  d?.stop();
});

describe("keeper (e2e)", () => {
  it("skips payouts below its minimum fee", async () => {
    const tsla = getAddress(d.deployment.tokens["TSLA"]!);
    const picky = new Keeper({
      operatorApi: `http://127.0.0.1:${server.port}`, vault: d.deployment.vault, publicClient: d.publicClient, walletClient: d.wallets.keeper,
      minFee: { [tsla]: parseEther("1") },
    });
    expect(await picky.tick(await d.now())).toEqual([]);
  });

  it("submits the signed payout, earns the fee, and doesn't double-submit", async () => {
    const tsla = d.deployment.tokens["TSLA"]!;
    const keeper = new Keeper({ operatorApi: `http://127.0.0.1:${server.port}`, vault: d.deployment.vault, publicClient: d.publicClient, walletClient: d.wallets.keeper });
    const k = d.wallets.keeper.account!.address;
    const before = await d.publicClient.readContract({ address: tsla, abi: ERC20_ABI, functionName: "balanceOf", args: [k] });

    const sent = await keeper.tick(await d.now());
    expect(sent.length).toBe(1);

    const out = parseEther("4"); // 1000 USDG at 250/TSLA
    const fee = (out * 5n) / 10000n;
    expect(await d.publicClient.readContract({ address: tsla, abi: ERC20_ABI, functionName: "balanceOf", args: [k] })).toBe(before + fee);
    expect(await d.publicClient.readContract({ address: tsla, abi: ERC20_ABI, functionName: "balanceOf", args: [recipient] }))
      .toBe(out - (out * 20n) / 10000n - fee);

    expect(await keeper.tick(await d.now())).toEqual([]); // tag already used on-chain
    await op.syncChain();
    expect((await op.pendingPayouts(await d.now())).length).toBe(0);
  });
});
