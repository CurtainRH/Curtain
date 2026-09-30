/**
 * Acceptance test for CurtainWallet.relay() (Curtain_Build.md §11 item 19, resolved
 * post-M12): shields a note, spends it through RelayAdapt.relay() into a DEX swap (the
 * BuyAndShield pattern), and confirms the swapped-into token lands as a real,
 * sync()-recoverable reshielded note — using a REAL 2x2 join-split Groth16 proof and
 * on-chain verifier (JoinSplit2x2Groth16Verifier), not a mock. Mirrors wallet.e2e.test.ts's
 * structure and level of rigor for send()/unshieldToOrigin().
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, getContractAddress, http, parseEther, type Address, type Hex } from "viem";
import { CurtainWallet, generateWalletKeys, type OwnedNote } from "../src";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const CIRCUITS_BUILD = join(import.meta.dir, "../../../circuits/build");
const ANVIL_PORT = 8652;
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
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
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

describe("CurtainWallet.relay(): BuyAndShield end to end (post-M12 acceptance)", () => {
  it(
    "shields USDG, relays it through a DEX swap into NVDA, and reshields the real proceeds",
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

      const joinSplit2x2VerifierAddr = await deploy(loadArtifact("JoinSplit2x2Groth16Verifier"));
      const joinSplit2x2AdapterAddr = await deploy(loadArtifact("JoinSplit2x2VerifierAdapter"), [joinSplit2x2VerifierAddr]);
      const joinSplit3x3MockAddr = await deploy(loadArtifact("MockJoinSplitVerifier"));

      const unshieldVerifierAddr = await deploy(loadArtifact("UnshieldGroth16Verifier"));
      const unshieldAdapterAddr = await deploy(loadArtifact("UnshieldVerifierAdapter"), [unshieldVerifierAddr]);

      // Predict RelayAdapt's address the same way Deploy.s.sol/LaunchGates.t.sol do, so it
      // can be baked into CurtainPool's constructor before RelayAdapt itself is deployed.
      const deployerNonce = await publicClient.getTransactionCount({ address: deployer! });
      const predictedRelayAdapt = getContractAddress({ from: deployer!, nonce: BigInt(deployerNonce + 1) });

      const poolArtifact = loadArtifact("CurtainPool");
      const poolAddr = await deploy(poolArtifact, [
        hasherT3, hasherT5, assetGateAddr, screeningGateAddr,
        joinSplit2x2AdapterAddr, joinSplit3x3MockAddr, unshieldAdapterAddr,
        predictedRelayAdapt,
        deployer, 20, 20,
        "0x0000000000000000000000000000000000000000", // no meta-tx forwarder in this test
      ]);

      const relayArtifact = loadArtifact("RelayAdapt");
      const relayAddr = await deploy(relayArtifact, [poolAddr, deployer]);
      expect(relayAddr.toLowerCase()).toBe(predictedRelayAdapt.toLowerCase());

      const erc20Artifact = loadArtifact("MockERC20");
      const usdgAddr = await deploy(erc20Artifact, ["USD Global", "USDG"]);
      const nvdaAddr = await deploy(erc20Artifact, ["NVIDIA Stock Token", "NVDA"]);
      await deployerClient.writeContract({ address: assetGateAddr, abi: loadArtifact("AssetGate").abi, functionName: "register", args: [usdgAddr, false, "0x0000000000000000000000000000000000000000"] });
      await deployerClient.writeContract({ address: assetGateAddr, abi: loadArtifact("AssetGate").abi, functionName: "register", args: [nvdaAddr, true, "0x0000000000000000000000000000000000000000"] });

      const dexArtifact = loadArtifact("MockDexRouter");
      const dexAddr = await deploy(dexArtifact);
      await deployerClient.writeContract({ address: dexAddr, abi: dexArtifact.abi, functionName: "setRate", args: [usdgAddr, nvdaAddr, parseEther("1")] }); // 1:1 for simplicity
      await deployerClient.writeContract({ address: nvdaAddr, abi: erc20Artifact.abi, functionName: "mint", args: [dexAddr, parseEther("1000000")] });

      await deployerClient.writeContract({ address: relayAddr, abi: relayArtifact.abi, functionName: "setAllowedTarget", args: [usdgAddr, true] });
      await deployerClient.writeContract({ address: relayAddr, abi: relayArtifact.abi, functionName: "setAllowedTarget", args: [dexAddr, true] });

      await deployerClient.writeContract({ address: usdgAddr, abi: erc20Artifact.abi, functionName: "mint", args: [alice!, parseEther("1000")] });
      await aliceClient.writeContract({ address: usdgAddr, abi: erc20Artifact.abi, functionName: "approve", args: [poolAddr, parseEther("1000")] });

      const { keys: aliceKeys } = await generateWalletKeys();
      const aliceWallet = new CurtainWallet({
        publicClient, walletClient: aliceClient, account: alice!,
        poolAddress: poolAddr, poolAbi: poolArtifact.abi as never, keys: aliceKeys,
        joinsplit2x2: { wasm: join(CIRCUITS_BUILD, "joinsplit2x2", "joinsplit2x2_js", "joinsplit2x2.wasm"), zkey: join(CIRCUITS_BUILD, "joinsplit2x2", "joinsplit2x2_final.zkey") },
        unshield: { wasm: "", zkey: "" },
        relayAddress: relayAddr,
        relayAbi: relayArtifact.abi as never,
      });

      // ---- shield 2 notes (2-in-2-out join-split arity needs exactly 2 inputs) ----
      const noteA = await aliceWallet.shield(usdgAddr, parseEther("60"));
      const noteB = await aliceWallet.shield(usdgAddr, parseEther("40"));
      await aliceWallet.markCleared(noteA.commit);
      await aliceWallet.markCleared(noteB.commit);

      const aliceNotes = await aliceWallet.sync();
      expect(aliceNotes.length).toBe(2);
      const [input1, input2] = aliceNotes as [OwnedNote, OwnedNote];
      const totalIn = input1.rawAmount + input2.rawAmount;

      // ---- relay: unshield full amount to RelayAdapt -> swap USDG->NVDA -> reshield NVDA ----
      const approveCall = {
        to: usdgAddr,
        value: 0n,
        data: (await import("viem")).encodeFunctionData({
          abi: erc20Artifact.abi,
          functionName: "approve",
          args: [dexAddr, totalIn],
        }),
      };
      const swapCall = {
        to: dexAddr,
        value: 0n,
        data: (await import("viem")).encodeFunctionData({
          abi: dexArtifact.abi,
          functionName: "swapExactIn",
          args: [usdgAddr, nvdaAddr, totalIn, totalIn],
        }),
      };

      await aliceWallet.relay(
        usdgAddr,
        [input1, input2],
        totalIn, // no change — full input relayed through
        [approveCall, swapCall],
        [{ token: nvdaAddr, expectedAmount: totalIn, minOut: totalIn, toEkX: aliceKeys.ekX, toEkY: aliceKeys.ekY, toPkX: aliceKeys.pkX }],
        alice!,
      );

      // ---- confirm the reshielded NVDA note is real and sync()-recoverable ----
      const aliceNotesAfter = await aliceWallet.sync();
      const nvdaTokenId = (await publicClient.readContract({ address: poolAddr, abi: poolArtifact.abi, functionName: "tokenIdOf", args: [nvdaAddr] })) as bigint;
      const reshielded = aliceNotesAfter.find((n) => n.tokenId === nvdaTokenId);
      expect(reshielded).toBeDefined();
      expect(reshielded!.rawAmount).toBe(totalIn);

      const relayAdaptNvdaBalance = (await publicClient.readContract({ address: nvdaAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [relayAddr] })) as bigint;
      const relayAdaptUsdgBalance = (await publicClient.readContract({ address: usdgAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [relayAddr] })) as bigint;
      expect(relayAdaptNvdaBalance).toBe(0n); // fully reshielded, zero residue
      expect(relayAdaptUsdgBalance).toBe(0n);

      const poolNvdaBalance = (await publicClient.readContract({ address: nvdaAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [poolAddr] })) as bigint;
      expect(poolNvdaBalance).toBe(totalIn);
    },
    120_000,
  );
});
