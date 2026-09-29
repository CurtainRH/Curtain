/**
 * M5 acceptance demo: "shield → send → unshield-to-origin from the UI",
 * narrated against a local anvil devnet it spins up itself — same pattern
 * as demo-stealth.ts (no frontend framework chosen yet; M5's actual
 * deliverable is the wallet SDK in @curtain/sdk, exercised here the way a
 * real UI would). Run with `bun run demo:wallet` from apps/web.
 *
 * Story: Alice shields two notes, sends part of their combined value to
 * Bob (a real 2-in-2-out join-split proof, verified by the real Groth16
 * verifier — not mocked), then separately shields a third note and
 * immediately withdraws it via the origin escape hatch. unshieldToOrigin
 * can only ever target a note's OWN original shield-time commitment (see
 * CurtainPool.sol's header) — never a note received via send() — so this
 * demo exercises it on its own fresh deposit rather than chaining it onto
 * the send, which is not something the contract's design permits.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, parseEther, type Address, type Hex } from "viem";
import { CurtainWallet, generateWalletKeys } from "@curtain/sdk";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const CIRCUITS_BUILD = join(import.meta.dir, "../../../circuits/build");
const ANVIL_PORT = 8649;
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

function log(step: string, detail?: unknown) {
  const rendered = detail !== undefined ? ` ${JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : "";
  console.log(`\n\x1b[36m▸ ${step}\x1b[0m${rendered}`);
}

async function main() {
  log("Starting local anvil devnet…");
  const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  process.on("exit", () => anvil.kill());
  await waitForAnvil();

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

  log("Deploying the pool stack (poseidon hashers, gate, verifiers, CurtainPool)…");
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
  const joinSplit3x3MockAddr = await deploy(loadArtifact("MockJoinSplitVerifier")); // 3x3 arity unused by this demo — see @curtain/sdk's send() scope note

  const unshieldVerifierAddr = await deploy(loadArtifact("UnshieldGroth16Verifier"));
  const unshieldAdapterAddr = await deploy(loadArtifact("UnshieldVerifierAdapter"), [unshieldVerifierAddr]);

  const poolAddr = await deploy(loadArtifact("CurtainPool"), [
    hasherT3, hasherT5, assetGateAddr, screeningGateAddr,
    joinSplit2x2AdapterAddr, joinSplit3x3MockAddr, unshieldAdapterAddr,
    "0x0000000000000000000000000000000000000000", // no RelayAdapt in this demo
    deployer, 20, 20,
  ]);
  const poolArtifact = loadArtifact("CurtainPool");
  log("CurtainPool deployed.", { poolAddr });

  const tokenAddr = await deploy(loadArtifact("MockERC20"), ["USD Global", "USDG"]);
  await deployerClient.writeContract({ address: assetGateAddr, abi: loadArtifact("AssetGate").abi, functionName: "register", args: [tokenAddr, false, "0x0000000000000000000000000000000000000000"] });
  await deployerClient.writeContract({ address: tokenAddr, abi: loadArtifact("MockERC20").abi, functionName: "mint", args: [alice!, parseEther("1000")] });
  await aliceClient.writeContract({ address: tokenAddr, abi: loadArtifact("MockERC20").abi, functionName: "approve", args: [poolAddr, parseEther("1000")] });
  log("USDG registered and minted to Alice.", { tokenAddr });

  log("Alice and Bob generate wallet keys (Baby Jubjub spending/viewing keys)…");
  const { keys: aliceKeys } = await generateWalletKeys();
  const { keys: bobKeys } = await generateWalletKeys();

  const aliceWallet = new CurtainWallet({
    publicClient, walletClient: aliceClient, account: alice!,
    poolAddress: poolAddr, poolAbi: poolArtifact.abi as never, keys: aliceKeys,
    joinsplit2x2: { wasm: join(CIRCUITS_BUILD, "joinsplit2x2", "joinsplit2x2_js", "joinsplit2x2.wasm"), zkey: join(CIRCUITS_BUILD, "joinsplit2x2", "joinsplit2x2_final.zkey") },
    unshield: { wasm: join(CIRCUITS_BUILD, "unshield", "unshield_js", "unshield.wasm"), zkey: join(CIRCUITS_BUILD, "unshield", "unshield_final.zkey") },
  });

  log("Alice shields two deposits (6 USDG + 4 USDG)…");
  const noteA = await aliceWallet.shield(tokenAddr, parseEther("6"));
  const noteB = await aliceWallet.shield(tokenAddr, parseEther("4"));
  log("Shielded.", { noteA_leafIndex: noteA.leafIndex, noteB_leafIndex: noteB.leafIndex });

  log("Both notes clear PPOI screening (mocked gate, instant here — ppoi-node does this for real in M4)…");
  await aliceWallet.markCleared(noteA.commit);
  await aliceWallet.markCleared(noteB.commit);

  log("Alice syncs her wallet (scans NoteCiphertext events, trial-decrypts with her viewing key)…");
  const aliceNotes = await aliceWallet.sync();
  log(`Recovered ${aliceNotes.length} note(s).`, aliceNotes.map((n) => ({ amount: n.rawAmount, leafIndex: n.leafIndex, clearedLeafIndex: n.clearedLeafIndex })));

  const [input1, input2] = aliceNotes as [typeof aliceNotes[0], typeof aliceNotes[0]];
  const totalIn = input1.rawAmount + input2.rawAmount;
  const changeAmount = parseEther("1"); // arbitrary; conservation just needs sumIn === sumOut
  const amountToBob = totalIn - changeAmount;
  log(`Alice sends ${amountToBob} to Bob, keeps ${changeAmount} as change (real 2-in-2-out join-split proof, real on-chain verifier)…`);
  await aliceWallet.send(tokenAddr, [input1, input2], [
    { toEkX: bobKeys.ekX, toEkY: bobKeys.ekY, toPkX: bobKeys.pkX, amount: amountToBob },
    { toEkX: aliceKeys.ekX, toEkY: aliceKeys.ekY, toPkX: aliceKeys.pkX, amount: changeAmount },
  ]);
  log("Sent.");

  const bobWallet = new CurtainWallet({
    publicClient, walletClient: aliceClient /* Bob never signs a tx in this demo */, account: bob!,
    poolAddress: poolAddr, poolAbi: poolArtifact.abi as never, keys: bobKeys,
    joinsplit2x2: { wasm: "", zkey: "" }, unshield: { wasm: "", zkey: "" },
  });
  log("Bob syncs his wallet…");
  const bobNotes = await bobWallet.sync();
  log(`Bob recovered ${bobNotes.length} note(s).`, bobNotes.map((n) => ({ amount: n.rawAmount })));
  if (bobNotes.length !== 1 || bobNotes[0]!.rawAmount !== amountToBob) {
    throw new Error(`Bob did not recover the expected ${amountToBob} USDG note`);
  }

  log("Alice shields a third deposit (2 USDG) and immediately unshields it via the origin escape hatch…");
  const treasuryBefore = await publicClient.readContract({ address: tokenAddr, abi: loadArtifact("MockERC20").abi, functionName: "balanceOf", args: [deployer!] }) as bigint;
  const noteC = await aliceWallet.shield(tokenAddr, parseEther("2"));
  await aliceWallet.unshieldToOrigin(tokenAddr, noteC);

  const aliceBalance = await publicClient.readContract({ address: tokenAddr, abi: loadArtifact("MockERC20").abi, functionName: "balanceOf", args: [alice!] }) as bigint;
  const poolBalance = await publicClient.readContract({ address: tokenAddr, abi: loadArtifact("MockERC20").abi, functionName: "balanceOf", args: [poolAddr] }) as bigint;
  log("Final balances.", { alice: aliceBalance, pool: poolBalance, treasuryDelta: (await publicClient.readContract({ address: tokenAddr, abi: loadArtifact("MockERC20").abi, functionName: "balanceOf", args: [deployer!] }) as bigint) - treasuryBefore });

  console.log("\n\x1b[32m✓ Done — shield → send → unshield-to-origin all verified on-chain.\x1b[0m\n");
  anvil.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
