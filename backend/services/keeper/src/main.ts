/**
 * Keeper process. Env: RPC_HTTP, CHAIN_ID, KEEPER_PRIVATE_KEY, VAULT_ADDR, OPERATOR_API,
 * KEEPER_MIN_FEE (JSON {"0xToken": "rawAmount"}, optional), KEEPER_TICK_MS (default 5000).
 */
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Keeper } from "./index";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};
const chain = defineChain({
  id: Number(env("CHAIN_ID", "4663")), name: "rhc", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env("RPC_HTTP")] } },
});
const minFee = Object.fromEntries(Object.entries(JSON.parse(process.env["KEEPER_MIN_FEE"] ?? "{}") as Record<string, string>).map(([k, v]) => [k, BigInt(v)]));
const keeper = new Keeper({
  operatorApi: env("OPERATOR_API"),
  vault: env("VAULT_ADDR") as Address,
  publicClient: createPublicClient({ chain, transport: http() }),
  walletClient: createWalletClient({ account: privateKeyToAccount(env("KEEPER_PRIVATE_KEY") as Hex), chain, transport: http() }),
  minFee,
});
const tickMs = Number(env("KEEPER_TICK_MS", "5000"));
console.log("@curtain/keeper running");
for (;;) {
  try {
    const sent = await keeper.tick(Math.floor(Date.now() / 1000));
    for (const h of sent) console.log(`submitted payout ${h}`);
  } catch (e) {
    console.error("keeper tick failed:", e);
  }
  await Bun.sleep(tickMs);
}
