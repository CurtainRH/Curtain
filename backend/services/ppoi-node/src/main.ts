/**
 * Process entry point. Env:
 *   RPC_HTTP, CHAIN_ID, GATE_ADDR, POOL_ADDR
 *   PPOI_PROVIDERS   JSON [{ "id": 0, "url": "https://..." }, ...]
 *   PPOI_PUBLISHES   JSON [0] — provider ids this node's key publishes (optional)
 *   PPOI_PRIVATE_KEY key used to flag / publish / submit proofs (optional; read-only without)
 *   PPOI_WASM, PPOI_ZKEY  circuit artifacts (default: circuits/build/ppoi_dev)
 *   PPOI_PORT (default 3003), PPOI_POLL_MS (default 15000)
 */
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PpoiNode } from "./node";
import { createPpoiHandler } from "./server";

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
const publicClient = createPublicClient({ chain, transport: http() });
const key = process.env["PPOI_PRIVATE_KEY"] as Hex | undefined;
const walletClient = key ? createWalletClient({ account: privateKeyToAccount(key), chain, transport: http() }) : undefined;
const build = join(import.meta.dir, "../../../circuits/build/ppoi_dev");

const node = new PpoiNode({
  publicClient,
  walletClient,
  gateAddress: env("GATE_ADDR") as Address,
  poolAddress: env("POOL_ADDR") as Address,
  providers: JSON.parse(env("PPOI_PROVIDERS")),
  publishes: JSON.parse(process.env["PPOI_PUBLISHES"] ?? "[]"),
  wasmPath: env("PPOI_WASM", join(build, "ppoi_dev_js/ppoi_dev.wasm")),
  zkeyPath: env("PPOI_ZKEY", join(build, "ppoi_dev_final.zkey")),
});

await node.refreshLists();
let cursor = await publicClient.getBlockNumber();
const pollMs = Number(env("PPOI_POLL_MS", "15000"));

setInterval(async () => {
  try {
    const head = await publicClient.getBlockNumber();
    if (head > cursor) {
      const flagged = await node.scanShields(cursor + 1n, head, walletClient !== undefined);
      for (const f of flagged) console.log(`flagged ${f.commit} (provider ${f.providerId}) ${f.txHash ?? "(dry run)"}`);
      cursor = head;
    }
  } catch (e) {
    console.error("shield scan failed:", e);
  }
}, pollMs);

setInterval(async () => {
  try {
    await node.refreshLists();
    if (walletClient) for (const id of await node.publishRoots()) console.log(`published new roots for provider ${id}`);
  } catch (e) {
    console.error("list refresh failed:", e);
  }
}, 60 * 60 * 1000);

const server = Bun.serve({ port: Number(env("PPOI_PORT", "3003")), fetch: createPpoiHandler(node) });
console.log(`@curtain/ppoi-node listening on :${server.port}`);
