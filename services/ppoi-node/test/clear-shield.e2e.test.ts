/**
 * M4 acceptance test: "node clears a shield in < 2 min on testnet."
 *
 * Spins up anvil, deploys the full M3/M4 contract stack (CurtainPool wired
 * to a real ScreeningGate + real PPOI Groth16 verifier), shields a note
 * from a live (non-fixture) account, then runs the actual ppoi-node logic
 * this service will run in production: fetch provider lists, build a
 * blinded non-membership proof, submit it, and time the whole thing from
 * the Shield event to ScreeningGate.cleared(commit) == true.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";

const CONTRACTS_OUT = join(import.meta.dir, "../../../contracts/out");
const CIRCUITS_BUILD = join(import.meta.dir, "../../../circuits/build");
const ANVIL_PORT = 8648;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const anvilChain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// Foundry's out/ layout is out/<SourceFile>.sol/<ContractName>.json — the
// two only coincide when a file declares exactly one contract of the same
// name (true for most of our files, but not e.g. PoseidonT2.sol, which
// declares PoseidonT2Deployer + IPoseidonT2).
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

describe("ppoi-node: clears a shield in < 2 min (M4 acceptance)", () => {
  it(
    "watches a Shield event, builds a real PPOI proof, and clears it on-chain",
    async () => {
      const publicClient = createPublicClient({ chain: anvilChain, transport: http() });
      const [deployer, sender] = (await publicClient.request({
        method: "eth_accounts",
      } as Parameters<typeof publicClient.request>[0])) as Address[];

      const deployerClient = createWalletClient({ account: deployer!, chain: anvilChain, transport: http() });
      const senderClient = createWalletClient({ account: sender!, chain: anvilChain, transport: http() });

      async function deploy(artifact: { abi: readonly unknown[]; bytecode: Hex }, args: unknown[] = []): Promise<Address> {
        const hash = await deployerClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (!receipt.contractAddress) throw new Error("deployment did not return a contract address");
        return receipt.contractAddress;
      }

      // ---- deploy the full M3/M4 stack ----
      const poseidonT2Deployer = loadArtifact("PoseidonT2", "PoseidonT2Deployer");
      const poseidonT3Deployer = loadArtifact("PoseidonT3", "PoseidonT3Deployer");
      const poseidonT5Deployer = loadArtifact("PoseidonT5", "PoseidonT5Deployer");
      const assetGateArtifact = loadArtifact("AssetGate");
      const screeningGateArtifact = loadArtifact("ScreeningGate");
      const ppoiVerifierArtifact = loadArtifact("PpoiDevGroth16Verifier");
      const ppoiAdapterArtifact = loadArtifact("PpoiDevVerifierAdapter");
      const mockVerifierArtifact = loadArtifact("MockJoinSplitVerifier");
      const mockUnshieldVerifierArtifact = loadArtifact("MockUnshieldVerifier");
      const curtainPoolArtifact = loadArtifact("CurtainPool");
      const erc20Artifact = loadArtifact("MockERC20");

      const t2DeployerAddr = await deploy(poseidonT2Deployer);
      const t3DeployerAddr = await deploy(poseidonT3Deployer);
      const t5DeployerAddr = await deploy(poseidonT5Deployer);
      const hasherT2 = (await publicClient.readContract({
        address: t2DeployerAddr, abi: poseidonT2Deployer.abi, functionName: "hasher",
      })) as Address;
      const hasherT3 = (await publicClient.readContract({
        address: t3DeployerAddr, abi: poseidonT3Deployer.abi, functionName: "hasher",
      })) as Address;
      const hasherT5 = (await publicClient.readContract({
        address: t5DeployerAddr, abi: poseidonT5Deployer.abi, functionName: "hasher",
      })) as Address;

      const assetGateAddr = await deploy(assetGateArtifact, [deployer]);
      const ppoiVerifierAddr = await deploy(ppoiVerifierArtifact);
      const ppoiAdapterAddr = await deploy(ppoiAdapterArtifact, [ppoiVerifierAddr]);
      const screeningGateAddr = await deploy(screeningGateArtifact, [hasherT2, hasherT3, ppoiAdapterAddr, deployer]);
      const mockVerifier2x2 = await deploy(mockVerifierArtifact);
      const mockVerifier3x3 = await deploy(mockVerifierArtifact);
      const mockUnshieldVerifier = await deploy(mockUnshieldVerifierArtifact);
      const poolAddr = await deploy(curtainPoolArtifact, [
        hasherT3, hasherT5, assetGateAddr, screeningGateAddr, mockVerifier2x2, mockVerifier3x3,
        mockUnshieldVerifier, "0x0000000000000000000000000000000000000000", deployer, 20, 20,
      ]);

      await deployerClient.writeContract({
        address: screeningGateAddr, abi: screeningGateArtifact.abi, functionName: "setPool", args: [poolAddr],
      });

      const tokenAddr = await deploy(erc20Artifact, ["USD Global", "USDG"]);
      await deployerClient.writeContract({
        address: assetGateAddr, abi: assetGateArtifact.abi, functionName: "register", args: [tokenAddr, false, "0x0000000000000000000000000000000000000000"],
      });
      await deployerClient.writeContract({
        address: tokenAddr, abi: erc20Artifact.abi, functionName: "mint", args: [sender!, parseEther("1000")],
      });
      await senderClient.writeContract({
        address: tokenAddr, abi: erc20Artifact.abi, functionName: "approve", args: [poolAddr, parseEther("1000")],
      });

      // ---- register 3 providers with real SMT roots (none listing `sender`) ----
      const { buildPoseidon, newMemEmptyTrie } = await import("circomlibjs");
      const poseidon = await buildPoseidon();
      const F = poseidon.F;
      const toField = (x: unknown) => F.toObject(x) as bigint;
      const hash = (...inputs: bigint[]) => toField(poseidon(inputs));

      // Provider lists store HASHED addresses — ppoi.circom's SMT check is
      // against Poseidon(originAddr), not the raw address ("blinded" PPOI:
      // the published list never contains plaintext addresses). See
      // ppoi.circom's header and circuits/scripts/debug-smt.cjs for how
      // this was found: checking the raw address instead of its hash
      // produces a witness that only accidentally verifies.
      async function buildProviderTree(listed: bigint[]) {
        const smt = await newMemEmptyTrie();
        for (const addr of listed) await smt.insert(hash(addr), 1n);
        return smt;
      }
      // Built sequentially, not via Promise.all — concurrent circomlibjs SMT
      // operations may interleave over shared WASM state.
      const providerTrees = [];
      for (const listed of [[111n, 222n], [333n, 444n], [555n, 666n]]) {
        providerTrees.push(await buildProviderTree(listed));
      }
      for (let i = 0; i < 3; i++) {
        const root = ("0x" + (toField(providerTrees[i]!.root) as bigint).toString(16).padStart(64, "0")) as Hex;
        await deployerClient.writeContract({
          address: screeningGateAddr, abi: screeningGateArtifact.abi, functionName: "addProvider",
          args: [i, deployer, root, "0x0000000000000000000000000000000000000000000000000000000000000000"],
        });
      }

      // ---- shield a note from a live account ----
      const shieldHash = await senderClient.writeContract({
        address: poolAddr, abi: curtainPoolArtifact.abi, functionName: "shield",
        args: [tokenAddr, parseEther("10"), 111n, 222n, "0x", "0x"],
      });
      const shieldReceipt = await publicClient.waitForTransactionReceipt({ hash: shieldHash });
      const shieldLog = shieldReceipt.logs.find((l) => l.address.toLowerCase() === poolAddr.toLowerCase());
      expect(shieldLog).toBeDefined();

      // Decode the Shield event for the real commit value.
      const shieldEvents = await publicClient.getContractEvents({
        address: poolAddr, abi: curtainPoolArtifact.abi, eventName: "Shield", fromBlock: 0n,
      });
      const realCommit = (shieldEvents[0] as unknown as { args: { commit: Hex } }).args.commit;

      // ==== START TIMER: this is the "ppoi-node clears a shield" measurement ====
      const t0 = performance.now();

      const originAddr = BigInt(sender!);
      const originHash = hash(originAddr);

      async function nonMembershipWitness(smt: Awaited<ReturnType<typeof newMemEmptyTrie>>, key: bigint) {
        const res = await smt.find(key);
        if (res.found) throw new Error("origin unexpectedly listed");
        const siblings = res.siblings.map((s: unknown) => toField(s));
        while (siblings.length < 32) siblings.push(0n);
        return {
          root: toField(smt.root),
          siblings,
          oldKey: res.isOld0 ? 0n : toField(res.notFoundKey),
          oldValue: res.isOld0 ? 0n : toField(res.notFoundValue),
          isOld0: res.isOld0 ? 1n : 0n,
        };
      }
      // Search for the HASHED origin, matching what the circuit checks.
      const witnesses = [];
      for (const t of providerTrees) {
        witnesses.push(await nonMembershipWitness(t, originHash));
      }

      // Re-derive tokenId and rawAmount(net) the same way CurtainPool did, so
      // the circuit's private note-opening constraint matches the real commit.
      const tokenIdHash = keccak256(`0x${tokenAddr.slice(2).padStart(40, "0")}` as Hex);
      const tokenId = BigInt(tokenIdHash) % FIELD_SIZE;
      const fee = (parseEther("10") * 20n) / 10000n;
      const netAmount = parseEther("10") - fee;

      const shieldEventBlock = shieldReceipt.blockNumber;
      const shieldedAtBlock = await publicClient.getBlock({ blockNumber: shieldEventBlock });

      const circuitInput = {
        providerRoots: witnesses.map((w) => w.root.toString()),
        noteCommit: BigInt(realCommit).toString(),
        shieldBlock: shieldedAtBlock.timestamp.toString(),
        originHash: originHash.toString(),
        tokenId: tokenId.toString(),
        rawAmount: netAmount.toString(),
        ownerPkX: "111",
        blinding: "222",
        originAddr: originAddr.toString(),
        siblings: witnesses.map((w) => w.siblings.map(String)),
        oldKey: witnesses.map((w) => w.oldKey.toString()),
        oldValue: witnesses.map((w) => w.oldValue.toString()),
        isOld0: witnesses.map((w) => w.isOld0.toString()),
      };

      // Proof generation runs in a Node subprocess, not inline under Bun —
      // see prove-ppoi-subprocess.cjs's header for why (a real Bun/
      // circom_runtime WASM incompatibility discovered while building this
      // test, not a design choice).
      const wasmPath = join(CIRCUITS_BUILD, "ppoi_dev", "ppoi_dev_js", "ppoi_dev.wasm");
      const zkeyPath = join(CIRCUITS_BUILD, "ppoi_dev", "ppoi_dev_final.zkey");
      const inputPath = join(import.meta.dir, ".tmp-ppoi-input.json");
      const outputPath = join(import.meta.dir, ".tmp-ppoi-output.json");
      writeFileSync(inputPath, JSON.stringify(circuitInput));

      const proveScript = join(import.meta.dir, "..", "src", "prove-ppoi-subprocess.cjs");
      // `stdio: "inherit"` hung indefinitely here — a Bun-parent/Node-child
      // inherited-fd interaction (confirmed via a CPU-flatlined child
      // process during debugging). Piping and explicitly draining both
      // streams avoids both the inherit deadlock and any pipe-backpressure
      // hang.
      await new Promise<void>((resolve, reject) => {
        const child = spawn("node", [proveScript, inputPath, outputPath, wasmPath, zkeyPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (d) => process.stdout.write(d));
        child.stderr?.on("data", (d) => process.stderr.write(d));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`prove subprocess exited ${code}`))));
      });

      const { a, b, c } = JSON.parse(readFileSync(outputPath, "utf-8")) as {
        a: string[]; b: string[][]; c: string[];
      };

      // Build proof bytes the way ScreeningGate's adapter expects: abi.encode(a,b,c).
      const { encodeAbiParameters, parseAbiParameters } = await import("viem");
      const proofBytes = encodeAbiParameters(
        parseAbiParameters("uint256[2], uint256[2][2], uint256[2]"),
        [a.map(BigInt) as [bigint, bigint], b.map((row) => row.map(BigInt)) as [[bigint, bigint], [bigint, bigint]], c.map(BigInt) as [bigint, bigint]],
      );

      const ppoiHash = await senderClient.writeContract({
        address: screeningGateAddr, abi: screeningGateArtifact.abi, functionName: "ppoiVerify",
        args: [realCommit, proofBytes],
      });
      await publicClient.waitForTransactionReceipt({ hash: ppoiHash });

      const cleared = (await publicClient.readContract({
        address: screeningGateAddr, abi: screeningGateArtifact.abi, functionName: "cleared", args: [realCommit],
      })) as boolean;

      const elapsedMs = performance.now() - t0;
      // ==== END TIMER ====

      console.log(`ppoi-node cleared the shield in ${(elapsedMs / 1000).toFixed(1)}s`);
      expect(cleared).toBe(true);
      expect(elapsedMs).toBeLessThan(120_000); // M4 acceptance: < 2 min

      // Bonus: confirm the pool-side cleared-tree wiring also works end to end.
      const markClearedHash = await senderClient.writeContract({
        address: poolAddr, abi: curtainPoolArtifact.abi, functionName: "markCleared", args: [realCommit],
      });
      await publicClient.waitForTransactionReceipt({ hash: markClearedHash });
      const isMember = (await publicClient.readContract({
        address: poolAddr, abi: curtainPoolArtifact.abi, functionName: "clearedTreeMember", args: [realCommit],
      })) as boolean;
      expect(isMember).toBe(true);

      // circuitInput above held plaintext owner/amount witness data (rawAmount,
      // ownerPkX, originAddr) on disk for the subprocess's duration — remove both
      // temp files now so nothing survives the test run (Curtain_Build.md §9's
      // Privacy CI gate: "broadcaster/ppoi/prover-assist store nothing post-request").
      rmSync(inputPath, { force: true });
      rmSync(outputPath, { force: true });
    },
    300_000, // test-framework timeout for the WHOLE test (deploy + shield + proving);
    // the actual M4 acceptance check is the internal `expect(elapsedMs).toBeLessThan(120_000)`
    // above, which only times the ppoi-node clearing step itself, not setup.
  );
});
