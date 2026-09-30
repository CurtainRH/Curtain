/**
 * Post-M12 acceptance: a broadcaster relays a real `shieldMeta` bundle (a signed
 * ERC2771Forwarder request wrapping `CurtainPool.shield()`) through the exact same generic
 * `submitBundle` path used for every other bundle kind — see node.ts's header on why no
 * special-casing was needed once the forwarder existed. Confirms the shield actually lands
 * on-chain, `originOf` binds to the real signer (not the broadcaster paying gas), and the
 * broadcaster's own address never receives or spends the signer's tokens.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, defineChain, encodeFunctionData, http,
  keccak256, parseEther, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BroadcasterNode } from "../src/node";
import type { Bundle } from "../src/types";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const ANVIL_PORT = 8653;
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

describe("broadcaster: shieldMeta (gasless shield via ERC2771Forwarder)", () => {
  it(
    "relays a signed shield request without the signer ever sending a transaction",
    async () => {
      const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
      const [deployer, broadcasterAddr] = (await publicClient.request({
        method: "eth_accounts",
      } as Parameters<typeof publicClient.request>[0])) as Address[];

      const deployerClient = createWalletClient({ account: deployer!, chain: anvilChain, transport: http() });
      const broadcasterClient = createWalletClient({ account: broadcasterAddr!, chain: anvilChain, transport: http() });

      async function deploy(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
        const hash = await deployerClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 10_000 });
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
      const unshieldMockAddr = await deploy(loadArtifact("MockUnshieldVerifier"));
      const forwarderArtifact = loadArtifact("ERC2771Forwarder");
      const forwarderAddr = await deploy(forwarderArtifact, ["Curtain"]);

      const poolArtifact = loadArtifact("CurtainPool");
      const poolAddr = await deploy(poolArtifact, [
        hasherT3, hasherT5, assetGateAddr, screeningGateAddr,
        joinSplitMockAddr, joinSplitMockAddr, unshieldMockAddr,
        "0x0000000000000000000000000000000000000000",
        deployer, 20, 20,
        forwarderAddr,
      ]);

      const erc20Artifact = loadArtifact("MockERC20");
      const tokenAddr = await deploy(erc20Artifact, ["USD Global", "USDG"]);
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({ address: assetGateAddr, abi: loadArtifact("AssetGate").abi, functionName: "register", args: [tokenAddr, false, "0x0000000000000000000000000000000000000000"] }),
      });

      // ---- Alice never sends a transaction: mint + approve are done via her signing key
      // for setup convenience only (approve still has to be a real on-chain tx from her
      // account in this test, since MockERC20 has no permit(); shield itself is the part
      // that's gasless). ----
      // Alice's key is generated fresh here (she is not one of anvil's pre-funded default
      // accounts) — she is funded via mint() below, and never sends a transaction herself.
      const alicePk = generatePrivateKey();
      const aliceAccount = privateKeyToAccount(alicePk);
      const aliceClient = createWalletClient({ account: aliceAccount, chain: anvilChain, transport: http() });

      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.writeContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "mint", args: [aliceAccount.address, parseEther("1000")] }),
      });
      // Alice needs a little ETH for this one setup approve() tx (MockERC20 has no
      // permit()) — the shield() call itself afterward is what's actually gasless for her.
      await publicClient.waitForTransactionReceipt({
        hash: await deployerClient.sendTransaction({ account: deployer!, chain: anvilChain, to: aliceAccount.address, value: parseEther("1") }),
      });
      await publicClient.waitForTransactionReceipt({
        hash: await aliceClient.writeContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "approve", args: [poolAddr, parseEther("1000")] }),
      });

      // ---- Alice signs a shieldMeta request off-chain (no gas, no tx from her) ----
      const shieldCalldata = encodeFunctionData({
        abi: poolArtifact.abi,
        functionName: "shield",
        args: [tokenAddr, parseEther("100"), 111n, 222n, "0x", "0x"],
      });

      const nonce = (await publicClient.readContract({ address: forwarderAddr, abi: forwarderArtifact.abi, functionName: "nonces", args: [aliceAccount.address] })) as bigint;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const gas = 3_000_000n;

      const domain = { name: "Curtain", version: "1", chainId: anvilChain.id, verifyingContract: forwarderAddr } as const;
      const types = {
        ForwardRequest: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "gas", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "data", type: "bytes" },
        ],
      } as const;
      const message = {
        from: aliceAccount.address,
        to: poolAddr,
        value: 0n,
        gas,
        nonce,
        deadline,
        data: shieldCalldata,
      };

      const signature = await aliceAccount.signTypedData({ domain, types, primaryType: "ForwardRequest", message });

      const executeCalldata = encodeFunctionData({
        abi: forwarderArtifact.abi,
        functionName: "execute",
        args: [{ ...message, signature }],
      });

      // ---- wrap as a Bundle and hand it to a BroadcasterNode, exactly like any other kind ----
      const bundle: Bundle = {
        chainId: anvilChain.id,
        kind: "shieldMeta",
        to: forwarderAddr,
        calldata: executeCalldata,
        feeToken: tokenAddr,
        feeAmount: 0n, // no proof-bound broadcaster fee for shieldMeta — see node.ts's header
        deadline,
        extDataHash: keccak256("0x00"),
      };

      const broadcasterNode = new BroadcasterNode(
        { address: broadcasterAddr!, feeSchedule: new Map(), assignmentWindowMs: 10 * 60 * 1000 },
        publicClient,
        broadcasterClient,
        async () => [broadcasterAddr!],
      );

      const aliceBalanceBefore = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [aliceAccount.address] })) as bigint;
      const broadcasterBalanceBefore = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [broadcasterAddr!] })) as bigint;

      const txHash = await broadcasterNode.submitBundle(bundle);
      expect(txHash).toBeDefined();
      expect(broadcasterNode.isMined(bundle)).toBe(true);

      // Tokens moved from Alice, not the broadcaster — the broadcaster only paid gas.
      const fee = (parseEther("100") * 20n) / 10000n;
      const aliceBalanceAfter = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [aliceAccount.address] })) as bigint;
      const broadcasterBalanceAfter = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [broadcasterAddr!] })) as bigint;
      expect(aliceBalanceBefore - aliceBalanceAfter).toBe(parseEther("100"));
      expect(broadcasterBalanceAfter).toBe(broadcasterBalanceBefore); // broadcaster's own token balance untouched

      // originOf must resolve to Alice, the real signer — not the forwarder or the broadcaster.
      const netAmount = parseEther("100") - fee;
      const commitHasherAddr = (await publicClient.readContract({ address: poolAddr, abi: poolArtifact.abi, functionName: "commitHasher" })) as Address;
      const tokenId = (await publicClient.readContract({ address: poolAddr, abi: poolArtifact.abi, functionName: "tokenIdOf", args: [tokenAddr] })) as bigint;
      const commit = (await publicClient.readContract({
        address: commitHasherAddr,
        abi: [{ type: "function", name: "poseidon", inputs: [{ type: "uint256[4]" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const,
        functionName: "poseidon",
        args: [[tokenId, netAmount, 111n, 222n]],
      })) as bigint;
      const origin = (await publicClient.readContract({ address: poolAddr, abi: poolArtifact.abi, functionName: "originOf", args: [`0x${commit.toString(16).padStart(64, "0")}` as Hex] })) as Address;
      expect(origin.toLowerCase()).toBe(aliceAccount.address.toLowerCase());
      expect(origin.toLowerCase()).not.toBe(broadcasterAddr!.toLowerCase());
      expect(origin.toLowerCase()).not.toBe(forwarderAddr.toLowerCase());
    },
    60_000,
  );
});
