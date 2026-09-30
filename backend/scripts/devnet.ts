/**
 * Test helper: a local Anvil chain with Curtain v2 deployed by the real
 * contracts/script/Deploy.s.sol. Requires `anvil` and `forge` (Foundry) on PATH.
 *
 * Roles (Anvil's public dev keys): deployer/admin #0, operator #2, treasury #3.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex, type PublicClient, type TestClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CONTRACTS_DIR = join(import.meta.dir, "../contracts");
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  user: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  operator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  treasury: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  keeper: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

export interface Deployment {
  vault: Address;
  staking: Address;
  router: Address;
  admin: Address;
  operator: Address;
  treasury: Address;
  tokens: Record<string, Address>;
}

export interface Devnet {
  rpcUrl: string;
  chain: Chain;
  deployment: Deployment;
  publicClient: PublicClient;
  wallets: Record<"deployer" | "user" | "operator" | "keeper", WalletClient>;
  testClient: TestClient;
  /** Latest block timestamp — the clock the contracts use. */
  now(): Promise<number>;
  stop(): void;
}

export async function startDevnet(port: number): Promise<Devnet> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  // High block gas limit: otherwise a large creation can wait for a block that never comes
  // while forge waits on its receipt.
  const anvil: ChildProcess = spawn("anvil", ["--port", String(port), "--silent", "--gas-limit", "1000000000"], { stdio: "ignore" });
  const chain = defineChain({
    id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http() }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      if (i > 100) {
        anvil.kill();
        throw new Error("anvil did not start");
      }
      await Bun.sleep(100);
    }
  }

  const addr = (k: Hex) => privateKeyToAccount(k).address;
  // --slow: one tx at a time; parallel broadcasting occasionally drops one on anvil.
  const out = spawnSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--silent"], {
    cwd: CONTRACTS_DIR, encoding: "utf-8",
    env: { ...process.env, OPERATOR_ADDR: addr(KEYS.operator), TREASURY_ADDR: addr(KEYS.treasury) },
  });
  if (out.status !== 0) {
    anvil.kill();
    throw new Error(`Deploy.s.sol failed:\n${out.stdout}\n${out.stderr}`);
  }
  const deployment = JSON.parse(readFileSync(join(CONTRACTS_DIR, "deployments", "31337.json"), "utf-8")) as Deployment;
  rmSync(join(CONTRACTS_DIR, "broadcast", "Deploy.s.sol", "31337"), { recursive: true, force: true });

  const wallet = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http() });
  return {
    rpcUrl,
    chain,
    deployment,
    publicClient,
    wallets: {
      deployer: wallet(KEYS.deployer),
      user: wallet(KEYS.user),
      operator: wallet(KEYS.operator),
      keeper: wallet(KEYS.keeper),
    },
    testClient: createTestClient({ chain, mode: "anvil", transport: http() }) as TestClient,
    now: async () => Number((await publicClient.getBlock()).timestamp),
    stop: () => anvil.kill(),
  };
}

