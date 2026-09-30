/**
 * Test helper: a local Anvil chain with the full Curtain stack deployed by the real
 * contracts/script/Deploy.s.sol (the same path a production deploy takes), for e2e tests.
 * Requires `anvil` and `forge` on PATH (Foundry).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CONTRACTS_DIR = join(import.meta.dir, "../contracts");
export const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex; // Anvil #0
export const USER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex; // Anvil #1

export interface Deployment {
  contracts: Record<string, { address: Address; codehash: Hex }>;
  usdg: Address;
  stockTokens: Address[];
}

export interface Devnet {
  rpcUrl: string;
  chain: ReturnType<typeof defineChain>;
  deployment: Deployment;
  addr(name: string): Address;
  publicClient: ReturnType<typeof createPublicClient>;
  deployer: ReturnType<typeof createWalletClient>;
  user: ReturnType<typeof createWalletClient>;
  testClient: ReturnType<typeof createTestClient>;
  stop(): void;
}

export async function startDevnet(port: number): Promise<Devnet> {
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn("anvil", ["--port", String(port), "--silent", "--gas-limit", "1000000000"], { stdio: "ignore" });
  const chain = defineChain({
    id: 31337, name: "anvil", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http() });
  for (let i = 0; ; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await Bun.sleep(100);
    }
  }

  const out = spawnSync("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--silent"], {
    cwd: CONTRACTS_DIR, encoding: "utf-8", env: { ...process.env, PRIVATE_KEY: BigInt(DEV_KEY).toString() },
  });
  if (out.status !== 0) {
    anvil.kill();
    throw new Error(`Deploy.s.sol failed:\n${out.stdout}\n${out.stderr}`);
  }
  const file = join(CONTRACTS_DIR, "deployments", "31337.json");
  const deployment = JSON.parse(readFileSync(file, "utf-8")) as Deployment;
  rmSync(join(CONTRACTS_DIR, "broadcast", "Deploy.s.sol", "31337"), { recursive: true, force: true });

  return {
    rpcUrl,
    chain,
    deployment,
    addr: (name) => deployment.contracts[name]!.address,
    publicClient,
    deployer: createWalletClient({ account: privateKeyToAccount(DEV_KEY), chain, transport: http() }),
    user: createWalletClient({ account: privateKeyToAccount(USER_KEY), chain, transport: http() }),
    testClient: createTestClient({ chain, mode: "anvil", transport: http() }),
    stop: () => anvil.kill(),
  };
}

export const TIMELOCK_ABI = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function getMinDelay() view returns (uint256)",
]);

/**
 * Runs each `{ target, data }` through the 24h timelock as the dev multisig (the deployer on
 * local chains): schedules them all, waits out the delay once, then executes them in order.
 */
export async function viaTimelock(d: Devnet, ops: { target: Address; data: Hex }[], saltPrefix = "op"): Promise<void> {
  const timelock = d.addr("TimelockController");
  const zero = `0x${"00".repeat(32)}` as Hex;
  const salt = (i: number) => keccak256(toHex(`${saltPrefix}-${i}`));
  const delay = await d.publicClient.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getMinDelay" });
  const wait = async (hash: Hex) => {
    const r = await d.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`timelock tx reverted: ${hash}`);
  };
  for (const [i, op] of ops.entries()) {
    await wait(await d.deployer.writeContract({
      chain: d.chain, account: d.deployer.account!, address: timelock, abi: TIMELOCK_ABI, functionName: "schedule",
      args: [op.target, 0n, op.data, zero, salt(i), delay],
    }));
  }
  await d.testClient.increaseTime({ seconds: Number(delay) + 1 });
  await d.testClient.mine({ blocks: 1 });
  for (const [i, op] of ops.entries()) {
    await wait(await d.deployer.writeContract({
      chain: d.chain, account: d.deployer.account!, address: timelock, abi: TIMELOCK_ABI, functionName: "execute",
      args: [op.target, 0n, op.data, zero, salt(i)],
    }));
  }
}
