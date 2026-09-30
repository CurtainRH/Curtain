/**
 * Post-M12 acceptance for the browser-safe proving path (Curtain_Build.md §11): proves
 * `ProverAssistBackend` (prover-backend.ts) produces a real, on-chain-verifiable Groth16
 * proof via a real `services/prover-assist` server — no Node `child_process`/`fs` calls
 * anywhere in this path, matching what an actual browser bundle can run. Uses
 * `unshieldToOrigin` (the simpler single-circuit flow) against a live anvil deployment with
 * the REAL on-chain `UnshieldGroth16Verifier`, not a mock — the same rigor wallet.e2e.test.ts
 * already applies to the local-prover path.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { CurtainWallet, ProverAssistBackend, generateWalletKeys } from "../src";
import { createProverAssistServer } from "../../../services/prover-assist/src/server";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const ANVIL_PORT = 8654;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const anvilChain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

function loadArtifact(fileName: string, contractName: string = fileName): { abi: readonly unknown[]; bytecode: Hex } {
  const path = join(CONTRACTS_OUT, `${fileName}.sol`, `${contractName}.json`);
  const json = JSON.parse(readFileSync(path, "utf-8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

async function waitForAnvil(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("anvil did not become ready in time");
}

let anvil: ChildProcess;

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  await waitForAnvil();
});

afterAll(() => {
  anvil?.kill();
});

describe("ProverAssistBackend: browser-safe proving via a real prover-assist server", () => {
  it(
    "unshields a note using a proof generated entirely through prover-assist's HTTP API",
    async () => {
      const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
      const [deployer, alice] = (await publicClient.request({
        method: "eth_accounts",
      } as Parameters<typeof publicClient.request>[0])) as Address[];

      const deployerClient = createWalletClient({ account: deployer!, chain: anvilChain, transport: http() });
      const aliceClient = createWalletClient({ account: alice!, chain: anvilChain, transport: http() });

      async function deploy(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
        const hash = await deployerClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return receipt.contractAddress!;
      }

      const t3Deployer = loadArtifact("PoseidonT3", "PoseidonT3Deployer");
      const t5Deployer = loadArtifact("PoseidonT5", "PoseidonT5Deployer");
      const t3DeployerAddr = await deploy(t3Deployer);
      const t5DeployerAddr = await deploy(t5Deployer);
      const hasherT3 = (await publicClient.readContract({ address: t3DeployerAddr, abi: t3Deployer.abi, functionName: "hasher" })) as Address;
      const hasherT5 = (await publicClient.readContract({ address: t5DeployerAddr, abi: t5Deployer.abi, functionName: "hasher" })) as Address;

      const assetGateAddr = await deploy(loadArtifact("AssetGate"), [deployer]);
      const screeningGateAddr = await deploy(loadArtifact("MockScreeningGate"));
      const joinSplitMockAddr = await deploy(loadArtifact("MockJoinSplitVerifier"));

      const unshieldVerifierAddr = await deploy(loadArtifact("UnshieldGroth16Verifier"));
      const unshieldAdapterAddr = await deploy(loadArtifact("UnshieldVerifierAdapter"), [unshieldVerifierAddr]);

      const poolArtifact = loadArtifact("CurtainPool");
      const poolAddr = await deploy(poolArtifact, [
        hasherT3, hasherT5, assetGateAddr, screeningGateAddr,
        joinSplitMockAddr, joinSplitMockAddr, unshieldAdapterAddr,
        "0x0000000000000000000000000000000000000000",
        deployer, 20, 20,
        "0x0000000000000000000000000000000000000000",
      ]);

      const erc20Artifact = loadArtifact("MockERC20");
      const tokenAddr = await deploy(erc20Artifact, ["USD Global", "USDG"]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({ address: assetGateAddr, abi: loadArtifact("AssetGate").abi, functionName: "register", args: [tokenAddr, false, "0x0000000000000000000000000000000000000000"] }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "mint", args: [alice!, parseEther("100")] }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await aliceClient.writeContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "approve", args: [poolAddr, parseEther("100")] }),
      });

      // ---- real prover-assist server, no Node fs/child_process reachable from the client side ----
      const server = createProverAssistServer(0);
      const proverAssistUrl = `http://127.0.0.1:${server.port}`;

      const { keys: aliceKeys } = await generateWalletKeys();
      const aliceWallet = new CurtainWallet({
        publicClient, walletClient: aliceClient, account: alice!,
        poolAddress: poolAddr, poolAbi: poolArtifact.abi as never, keys: aliceKeys,
        joinsplit2x2: { wasm: "", zkey: "" }, // unused: proverBackend overrides both circuits
        unshield: { wasm: "", zkey: "" },
        proverBackend: new ProverAssistBackend(proverAssistUrl),
      });

      try {
        const note = await aliceWallet.shield(tokenAddr, parseEther("10"));

        const aliceBalanceBefore = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [alice!] })) as bigint;
        await aliceWallet.unshieldToOrigin(tokenAddr, note); // proof generated entirely via prover-assist's HTTP API
        const aliceBalanceAfter = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [alice!] })) as bigint;

        const unshieldFee = (note.rawAmount * 20n) / 10000n;
        expect(aliceBalanceAfter - aliceBalanceBefore).toBe(note.rawAmount - unshieldFee);
      } finally {
        server.stop(true);
      }
    },
    60_000,
  );
});
