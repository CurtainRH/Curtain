/**
 * Mainnet-fork test: Robinhood Chain (4663) forked with anvil, the stack deployed through
 * Deploy.s.sol's PRODUCTION path (real tokens, real Uniswap router), real USDG (6 decimals)
 * swapped to real NVDA/TSLA through Uniswap v3 by the operator + a keeper.
 *
 * Opt-in: needs an ARCHIVE RPC for Robinhood Chain (the public endpoint prunes old state within
 * minutes, which breaks a fork mid-test). FORK_RPC=<archive url> bun test test/fork.e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { migrate, type Db } from "@curtain/db";
import { pgliteDb } from "@curtain/db/pglite";
import { createPublicClient, createTestClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Address, type Hex, type PublicClient, type TestClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACTS_DIR, KEYS } from "../../../scripts/devnet";
import { ERC20_ABI, VAULT_ABI } from "../src/abi";
import { createIntent } from "../src/intents";
import { Operator, settleArgs } from "../src/operator";
import { uniswapV3Quoter, uniswapV3Route } from "../src/routes";

setDefaultTimeout(600_000);
const FORK_RPC = process.env["FORK_RPC"];
const PORT = 8701;

const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
const TSLA = getAddress("0x322F0929c4625eD5bAd873c95208D54E1c003b2d");
const SPY = getAddress("0x117cc2133c37B721F49dE2A7a74833232B3B4C0C");
const QQQ = getAddress("0xD5f3879160bc7c32ebb4dC785F8a4F505888de68");
const ROUTER = getAddress("0xcaf681a66d020601342297493863e78c959e5cb2");
const QUOTER = getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
const USDG_WHALE = getAddress("0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3"); // USDG/NVDA 0.05% pool
const DEPLOYMENT_FILE = join(CONTRACTS_DIR, "deployments", "fork-4663.json");

let anvil: ChildProcess;
let publicClient: PublicClient;
let testClient: TestClient;
let user: WalletClient;
let keeper: WalletClient;
let operatorWallet: WalletClient;
let vault: Address;
let db: Db;
let op: Operator;
const chain = defineChain({ id: 4663, name: "rhc-fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } } });

const wait = async (hash: Hex) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted ${hash}`);
  return r;
};
const now = async () => Number((await publicClient.getBlock()).timestamp);

describe.skipIf(!FORK_RPC)("Robinhood Chain mainnet fork", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--fork-url", FORK_RPC!, "--port", String(PORT), "--silent", "--gas-limit", "1000000000"], { stdio: "ignore" });
    publicClient = createPublicClient({ chain, transport: http(undefined, { timeout: 60_000 }) }) as PublicClient;
    for (let i = 0; ; i++) {
      try {
        if ((await publicClient.getChainId()) === 4663) break;
      } catch {
        if (i > 300) throw new Error("fork did not start");
      }
      await Bun.sleep(200);
    }
    testClient = createTestClient({ chain, mode: "anvil", transport: http() }) as TestClient;
    const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http() });
    user = wallet(KEYS.user);
    keeper = wallet(KEYS.keeper);
    operatorWallet = wallet(KEYS.operator);
    for (const w of [user, keeper, operatorWallet]) await testClient.setBalance({ address: w.account!.address, value: 10n ** 18n });

    // Production deploy path (chain id 4663): real tokens and router, no mocks.
    const out = spawnSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", `http://127.0.0.1:${PORT}`, "--broadcast", "--slow", "--silent"], {
      cwd: CONTRACTS_DIR, encoding: "utf-8",
      env: {
        ...process.env, PRIVATE_KEY: KEYS.deployer, ADMIN_ADDR: privateKeyToAccount(KEYS.deployer).address,
        OPERATOR_ADDR: operatorWallet.account!.address, TREASURY_ADDR: privateKeyToAccount(KEYS.treasury).address,
        DEX_ROUTER_ADDR: ROUTER, TOKEN_ADDRS: [USDG, NVDA, TSLA, SPY, QQQ].join(","), DEPLOYMENT_FILE,
      },
    });
    if (out.status !== 0) throw new Error(`Deploy.s.sol (production path) failed:\n${out.stdout}\n${out.stderr}`);
    const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf-8"));
    vault = deployment.vault;
    expect(deployment.production).toBe(true);
    expect(Object.keys(deployment.tokens).sort()).toEqual(["NVDA", "QQQ", "SPY", "TSLA", "USDG"]);
    rmSync(join(CONTRACTS_DIR, "broadcast", "Deploy.s.sol", "4663"), { recursive: true, force: true });

    // Real USDG for the user, from a pool that holds millions.
    await testClient.impersonateAccount({ address: USDG_WHALE });
    await testClient.setBalance({ address: USDG_WHALE, value: 10n ** 18n });
    const whale = createWalletClient({ account: USDG_WHALE, chain, transport: http() });
    await wait(await whale.writeContract({ chain, account: USDG_WHALE, address: USDG, abi: parseAbi(["function transfer(address,uint256) returns (bool)"]), functionName: "transfer", args: [user.account!.address, 5_000n * 10n ** 6n] }));
    await testClient.stopImpersonatingAccount({ address: USDG_WHALE });

    db = await pgliteDb();
    await migrate(db);
    op = new Operator({
      db, publicClient, walletClient: operatorWallet, chainId: 4663, vault, router: ROUTER,
      route: uniswapV3Route(3000), quote: uniswapV3Quoter(publicClient, QUOTER), keeperFeeBps: 5, slippageBps: 100,
      startBlock: await publicClient.getBlockNumber(),
    });
  });

  afterAll(() => {
    anvil?.kill();
    rmSync(DEPLOYMENT_FILE, { force: true });
  });

  async function privateSwap(tokenOut: Address, amountIn: bigint, recipient: Address) {
    const q = await uniswapV3Quoter(publicClient, QUOTER)(USDG, tokenOut, amountIn);
    const minOut = (q.amountOut * 97n) / 100n; // the user accepts up to 3% less than the quote, after fees
    const intent = await createIntent(db, { tokenIn: USDG, amountIn, tokenOut, recipient, depositor: user.account!.address, minOut, delaySeconds: 0 },
      new Set([USDG, NVDA, TSLA, SPY, QQQ]), vault, await now());
    await wait(await user.writeContract({ chain, account: user.account!, address: USDG, abi: ERC20_ABI, functionName: "approve", args: [vault, amountIn] }));
    await wait(await user.writeContract({ chain, account: user.account!, address: vault, abi: VAULT_ABI, functionName: "deposit", args: [USDG, amountIn, intent.deadlineHash] }));
    for (let i = 0; i < 30; i++) {
      await op.syncChain();
      const [row] = await db.query<{ status: string }>("SELECT status FROM intents WHERE id = $1", [intent.id]);
      if (row!.status === "deposited") break;
      await Bun.sleep(200);
    }
    expect(await op.processDue(await now())).toHaveLength(1);

    // A third-party keeper lands it through the real Uniswap router.
    const [pending] = await op.pendingSettlements(await now());
    await wait(await keeper.writeContract({ chain, account: keeper.account!, address: vault, abi: VAULT_ABI, functionName: "settle", args: settleArgs(pending!) }));
    await op.syncChain();
    const [row] = await db.query<{ status: string }>("SELECT status FROM intents WHERE id = $1", [intent.id]);
    expect(row!.status).toBe("paid");
    const got = await publicClient.readContract({ address: tokenOut, abi: ERC20_ABI, functionName: "balanceOf", args: [recipient] });
    return { quote: q, minOut, got };
  }

  it("quotes the deep pool for each pair (0.05% for NVDA, 0.30% for TSLA)", async () => {
    const quote = uniswapV3Quoter(publicClient, QUOTER);
    expect((await quote(USDG, NVDA, 1_000n * 10n ** 6n)).fee).toBe(500);
    expect((await quote(USDG, TSLA, 1_000n * 10n ** 6n)).fee).toBe(3000);
  });

  it("swaps 1,000 real USDG to real NVDA privately through Uniswap", async () => {
    const recipient = getAddress("0x00000000000000000000000000000000000fE5e1");
    const { quote, minOut, got } = await privateSwap(NVDA, 1_000n * 10n ** 6n, recipient);
    expect(got).toBeGreaterThanOrEqual(minOut);
    expect(got).toBeLessThanOrEqual(quote.amountOut);
    // The vault keeps nothing but rounding dust of the input.
    expect(await publicClient.readContract({ address: USDG, abi: ERC20_ABI, functionName: "balanceOf", args: [vault] })).toBe(0n);
  });

  it("swaps real USDG to real TSLA through the 0.30% pool", async () => {
    const recipient = getAddress("0x00000000000000000000000000000000000fE5e2");
    const { minOut, got } = await privateSwap(TSLA, 500n * 10n ** 6n, recipient);
    expect(got).toBeGreaterThanOrEqual(minOut);
  });
});
