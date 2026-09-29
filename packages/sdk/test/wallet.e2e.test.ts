/**
 * M5 acceptance test: "E2E: shield -> send -> unshield-to-origin from the
 * UI." Automated version of apps/web/src/demo-wallet.ts — same flow, run
 * under bun:test with assertions instead of narrated console output, so it
 * runs in CI rather than only interactively.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { CurtainWallet, generateWalletKeys, type OwnedNote } from "../src";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const CIRCUITS_BUILD = join(import.meta.dir, "../../../circuits/build");
const ANVIL_PORT = 8650;
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

describe("CurtainWallet: shield -> send -> unshieldToOrigin (M5 acceptance)", () => {
  it(
    "moves value through the pool end to end using real join-split and unshield proofs",
    async () => {
      const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
      const [deployer, alice, bob] = (await publicClient.request({
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

      const poolArtifact = loadArtifact("CurtainPool");
      const poolAddr = await deploy(poolArtifact, [
        hasherT3, hasherT5, assetGateAddr, screeningGateAddr,
        joinSplit2x2AdapterAddr, joinSplit3x3MockAddr, unshieldAdapterAddr,
        deployer, 20, 20,
      ]);

      const erc20Artifact = loadArtifact("MockERC20");
      const tokenAddr = await deploy(erc20Artifact, ["USD Global", "USDG"]);
      await deployerClient.writeContract({ address: assetGateAddr, abi: loadArtifact("AssetGate").abi, functionName: "register", args: [tokenAddr, false, "0x0000000000000000000000000000000000000000"] });
      await deployerClient.writeContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "mint", args: [alice!, parseEther("1000")] });
      await aliceClient.writeContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "approve", args: [poolAddr, parseEther("1000")] });

      const { keys: aliceKeys } = await generateWalletKeys();
      const { keys: bobKeys } = await generateWalletKeys();

      const aliceWallet = new CurtainWallet({
        publicClient, walletClient: aliceClient, account: alice!,
        poolAddress: poolAddr, poolAbi: poolArtifact.abi as never, keys: aliceKeys,
        joinsplit2x2: { wasm: join(CIRCUITS_BUILD, "joinsplit2x2", "joinsplit2x2_js", "joinsplit2x2.wasm"), zkey: join(CIRCUITS_BUILD, "joinsplit2x2", "joinsplit2x2_final.zkey") },
        unshield: { wasm: join(CIRCUITS_BUILD, "unshield", "unshield_js", "unshield.wasm"), zkey: join(CIRCUITS_BUILD, "unshield", "unshield_final.zkey") },
      });

      // ---- shield ----
      const noteA = await aliceWallet.shield(tokenAddr, parseEther("6"));
      const noteB = await aliceWallet.shield(tokenAddr, parseEther("4"));
      expect(noteA.leafIndex).toBe(0);
      expect(noteB.leafIndex).toBe(1);
      await aliceWallet.markCleared(noteA.commit);
      await aliceWallet.markCleared(noteB.commit);

      const aliceNotes = await aliceWallet.sync();
      expect(aliceNotes.length).toBe(2);
      const totalIn = aliceNotes[0]!.rawAmount + aliceNotes[1]!.rawAmount;

      // ---- send (real 2-in-2-out join-split proof, real on-chain verifier) ----
      const changeAmount = parseEther("1");
      const amountToBob = totalIn - changeAmount;
      const [input1, input2] = aliceNotes as [OwnedNote, OwnedNote];
      await aliceWallet.send(tokenAddr, [input1, input2], [
        { toEkX: bobKeys.ekX, toEkY: bobKeys.ekY, toPkX: bobKeys.pkX, amount: amountToBob },
        { toEkX: aliceKeys.ekX, toEkY: aliceKeys.ekY, toPkX: aliceKeys.pkX, amount: changeAmount },
      ]);

      const bobWallet = new CurtainWallet({
        publicClient, walletClient: aliceClient, account: bob!,
        poolAddress: poolAddr, poolAbi: poolArtifact.abi as never, keys: bobKeys,
        joinsplit2x2: { wasm: "", zkey: "" }, unshield: { wasm: "", zkey: "" },
      });
      const bobNotes = await bobWallet.sync();
      expect(bobNotes.length).toBe(1);
      expect(bobNotes[0]!.rawAmount).toBe(amountToBob);

      const aliceChangeNotes = await aliceWallet.sync();
      expect(aliceChangeNotes.some((n) => n.rawAmount === changeAmount)).toBe(true);

      // ---- unshieldToOrigin (real tiny nullifier proof, real on-chain verifier) ----
      const aliceBalanceBeforeC = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [alice!] })) as bigint;
      const noteC = await aliceWallet.shield(tokenAddr, parseEther("2"));
      await aliceWallet.unshieldToOrigin(tokenAddr, noteC);

      const aliceBalanceAfterC = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [alice!] })) as bigint;
      const unshieldFee = (noteC.rawAmount * 20n) / 10000n;
      expect(aliceBalanceAfterC - aliceBalanceBeforeC).toBe(noteC.rawAmount - unshieldFee - parseEther("2"));
      // (shields 2, then gets back noteC's net amount minus the unshield fee)

      const poolBalance = (await publicClient.readContract({ address: tokenAddr, abi: erc20Artifact.abi, functionName: "balanceOf", args: [poolAddr] })) as bigint;
      expect(poolBalance).toBe(totalIn); // note C's shield+unshield net to zero; only Alice+Bob's original notes remain
    },
    120_000,
  );
});
