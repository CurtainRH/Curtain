/**
 * Process entry point. Env: DATABASE_URL, RPC_HTTP, CHAIN_ID, POOL_ADDR, GATE_ADDR,
 * ASSET_GATE_ADDR, BOND_ADDR, SOLVENCY_ADDR, ADAPT_ADDR, INDEXER_POLL_MS (default 5000).
 */
import { bunSqlDb, migrate } from "@curtain/db";
import { createPublicClient, defineChain, http, type Address } from "viem";
import { Indexer } from "./indexer";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

const chain = defineChain({
  id: Number(env("CHAIN_ID", "4663")),
  name: "rhc",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env("RPC_HTTP")] } },
});
const db = await bunSqlDb();
await migrate(db);

const indexer = new Indexer(db, createPublicClient({ chain, transport: http() }), {
  pool: env("POOL_ADDR") as Address,
  gate: env("GATE_ADDR") as Address,
  assetGate: env("ASSET_GATE_ADDR") as Address,
  bond: env("BOND_ADDR") as Address,
  solvency: env("SOLVENCY_ADDR") as Address,
  relayAdapt: env("ADAPT_ADDR") as Address,
});

const pollMs = Number(env("INDEXER_POLL_MS", "5000"));
for (;;) {
  try {
    const at = await indexer.syncTo();
    console.log(`indexed through block ${at}`);
  } catch (e) {
    console.error("index pass failed:", e);
  }
  await Bun.sleep(pollMs);
}
