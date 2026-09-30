/**
 * Operator process. Env:
 *   DATABASE_URL, RPC_HTTP, CHAIN_ID
 *   OPERATOR_PRIVATE_KEY   the vault's operator key (signs payouts, runs swaps)
 *   VAULT_ADDR, DEX_ROUTER_ADDR
 *   TOKENS                 JSON {"USDG":"0x...","NVDA":"0x...",...}
 *   ROUTE                  "uniswap-v3" (default) or "mock" (local chains)
 *   UNISWAP_FEE_TIER       default 3000
 *   KEEPER_FEE_BPS         default 5
 *   OPERATOR_PORT          default 3100
 *   TICK_MS                default 5000
 *   START_BLOCK            first block to index (default: current head on first run)
 */
import { bunSqlDb, migrate } from "@curtain/db";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "./api";
import { Operator } from "./operator";
import { mockRoute, uniswapV3Route } from "./routes";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

const chainId = Number(env("CHAIN_ID", "4663"));
const chain = defineChain({
  id: chainId, name: "rhc", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env("RPC_HTTP")] } },
});
const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account: privateKeyToAccount(env("OPERATOR_PRIVATE_KEY") as Hex), chain, transport: http() });
const db = await bunSqlDb();
await migrate(db);

const vault = env("VAULT_ADDR") as Address;
const keeperFeeBps = Number(env("KEEPER_FEE_BPS", "5"));
const operator = new Operator({
  db, publicClient, walletClient, chainId, vault,
  router: env("DEX_ROUTER_ADDR") as Address,
  route: env("ROUTE", "uniswap-v3") === "mock" ? mockRoute : uniswapV3Route(Number(env("UNISWAP_FEE_TIER", "3000"))),
  keeperFeeBps,
  startBlock: process.env["START_BLOCK"] ? BigInt(process.env["START_BLOCK"]) : await publicClient.getBlockNumber(),
});
await operator.reconcile();

const server = Bun.serve({
  port: Number(env("OPERATOR_PORT", "3100")),
  fetch: createApi({ db, operator, vault, tokens: JSON.parse(env("TOKENS")), keeperFeeBps }),
});
console.log(`@curtain/operator listening on :${server.port}`);

const tickMs = Number(env("TICK_MS", "5000"));
for (;;) {
  const started = Date.now();
  const now = Math.floor(started / 1000);
  try {
    await operator.syncChain();
    await operator.processDue(now);
    await operator.submitPayouts(now);
    await operator.syncChain();
  } catch (e) {
    console.error("operator tick failed:", e);
  }
  await Bun.sleep(Math.max(0, tickMs - (Date.now() - started)));
}
