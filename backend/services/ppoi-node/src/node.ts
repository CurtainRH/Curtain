/**
 * The PPOI node, per Curtain_Build.md §4.2, minus the part that can't work as specced.
 *
 * What it does on its own:
 * - `refreshLists()`: fetches every provider's list URL and rebuilds its trees.
 * - `publishRoots()`: for providers this node publishes, calls `updateRoot` when the list
 *   changed (the gate rate-limits this to once an hour).
 * - `scanShields()`: for each new Shield event, checks the note's origin against every
 *   provider list and files `flag()` while the note is still in standby. A positive hit
 *   needs no secret, so any node can do this for everyone.
 * - `witnessFor()`: per-provider non-membership witnesses for an origin, against exactly the
 *   roots the gate will check (0 for excluded providers). Wallets use this to prove locally.
 *
 * What it does on request (`proveAndClear()`): builds and submits the PPOI proof. That proof
 * opens the note commitment (ppoi.circom), so it needs the note's ownerPkX and blinding,
 * which only the owner has. The spec's "node proves every shield within ~2 min" is therefore
 * only possible for owners who hand the opening over (e.g. mobile wallets); desktop wallets
 * should prove locally with `witnessFor()` and keep the opening private.
 *
 * Proofs run in a Node subprocess (prove-ppoi-subprocess.cjs): snarkjs' witness calculator
 * misbehaves under Bun.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, parseAbi, parseAbiParameters, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { ProviderTree, getHasher, parseList, toBytes32, type NonMembershipWitness } from "./trees";

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const PROVIDER_COUNT = 3;

type Fixed32<T> = readonly [T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T];

export const GATE_ABI = parseAbi([
  "function ppoiRoots(uint8 usePrevMask) view returns (bytes32[3])",
  "function providers(uint8) view returns (bytes32 listRoot, bytes32 flagRoot, uint64 updatedAt, address publisher, bool active, bytes32 prevListRoot, bytes32 prevFlagRoot, bool hasPrev)",
  "function standby() view returns (uint64)",
  "function cleared(bytes32) view returns (bool)",
  "function flagged(bytes32) view returns (bool)",
  "function updateRoot(uint8 id, bytes32 newListRoot, bytes32 newFlagRoot)",
  "function flag(bytes32 commit, uint8 providerId, uint256[32] pathElements, uint8[32] pathIndices)",
  "function ppoiVerify(bytes32 commit, bytes proof)",
]);

export const POOL_ABI = parseAbi([
  "event Shield(bytes32 indexed commit, uint32 leafIndex, address indexed token, uint256 rawAmount)",
  "function originOf(bytes32) view returns (address)",
  "function shieldedAt(bytes32) view returns (uint64)",
]);

export interface ProviderSource {
  id: number;
  url: string;
}

export interface PpoiNodeConfig {
  publicClient: PublicClient;
  walletClient?: WalletClient; // needed to flag, publish roots or submit proofs
  gateAddress: Address;
  poolAddress: Address;
  providers: ProviderSource[];
  /** Provider ids whose publisher key is `walletClient`'s account. */
  publishes?: number[];
  wasmPath: string;
  zkeyPath: string;
  proveScript?: string;
  fetchList?: (url: string) => Promise<string>;
}

export interface FlagAction {
  commit: Hex;
  providerId: number;
  origin: Address;
  txHash?: Hex;
}

export interface NoteOpening {
  commit: Hex;
  token: Address;
  rawAmount: bigint; // net of shield fee, as committed
  ownerPkX: bigint;
  blinding: bigint;
}

export class PpoiNode {
  readonly trees = new Map<number, ProviderTree>();

  constructor(private cfg: PpoiNodeConfig) {}

  async refreshLists(): Promise<void> {
    const fetchList = this.cfg.fetchList ?? (async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`provider list ${url}: HTTP ${res.status}`);
      return res.text();
    });
    for (const p of this.cfg.providers) {
      this.trees.set(p.id, await ProviderTree.build(parseList(await fetchList(p.url))));
    }
  }

  /** Pushes changed roots for the providers this node publishes. Returns ids updated. */
  async publishRoots(): Promise<number[]> {
    const wallet = this.requireWallet();
    const updated: number[] = [];
    for (const id of this.cfg.publishes ?? []) {
      const tree = this.trees.get(id);
      if (!tree) continue;
      const p = await this.cfg.publicClient.readContract({ address: this.cfg.gateAddress, abi: GATE_ABI, functionName: "providers", args: [id] });
      if (BigInt(p[0]) === tree.listRoot && BigInt(p[1]) === tree.flagRoot) continue;
      const hash = await wallet.writeContract({
        chain: wallet.chain, account: wallet.account!, address: this.cfg.gateAddress, abi: GATE_ABI,
        functionName: "updateRoot", args: [id, toBytes32(tree.listRoot), toBytes32(tree.flagRoot)],
      });
      await this.cfg.publicClient.waitForTransactionReceipt({ hash });
      updated.push(id);
    }
    return updated;
  }

  /** Flags every shield in [fromBlock, toBlock] whose origin a provider lists, while flaggable. */
  async scanShields(fromBlock: bigint, toBlock: bigint, submit = true): Promise<FlagAction[]> {
    const { publicClient, poolAddress, gateAddress } = this.cfg;
    const logs = await publicClient.getContractEvents({ address: poolAddress, abi: POOL_ABI, eventName: "Shield", fromBlock, toBlock });
    const standby = await publicClient.readContract({ address: gateAddress, abi: GATE_ABI, functionName: "standby" });
    const now = (await publicClient.getBlock()).timestamp;
    const actions: FlagAction[] = [];

    for (const log of logs) {
      const commit = log.args.commit as Hex;
      const [origin, shieldedAt, cleared, flagged] = await Promise.all([
        publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "originOf", args: [commit] }),
        publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "shieldedAt", args: [commit] }),
        publicClient.readContract({ address: gateAddress, abi: GATE_ABI, functionName: "cleared", args: [commit] }),
        publicClient.readContract({ address: gateAddress, abi: GATE_ABI, functionName: "flagged", args: [commit] }),
      ]);
      if (cleared || flagged || now > shieldedAt + standby) continue;

      for (const [providerId, tree] of this.trees) {
        const path = tree.flagPath(origin);
        if (!path) continue;
        const action: FlagAction = { commit, providerId, origin };
        if (submit) {
          const wallet = this.requireWallet();
          const hash = await wallet.writeContract({
            chain: wallet.chain, account: wallet.account!, address: gateAddress, abi: GATE_ABI, functionName: "flag",
            args: [commit, providerId, path.pathElements as unknown as Fixed32<bigint>, path.pathIndices as unknown as Fixed32<number>],
          });
          await publicClient.waitForTransactionReceipt({ hash });
          action.txHash = hash;
        }
        actions.push(action);
        break; // one flag is enough
      }
    }
    return actions;
  }

  /** Non-membership witnesses for `origin` against the roots the gate checks right now. */
  async witnessFor(origin: Address): Promise<{ roots: bigint[]; witnesses: NonMembershipWitness[] }> {
    const onChain = await this.cfg.publicClient.readContract({ address: this.cfg.gateAddress, abi: GATE_ABI, functionName: "ppoiRoots", args: [0] });
    const empty = await ProviderTree.empty();
    const witnesses: NonMembershipWitness[] = [];
    for (let i = 0; i < PROVIDER_COUNT; i++) {
      const root = BigInt(onChain[i]!);
      const tree = root === 0n ? empty : this.trees.get(i);
      if (!tree || tree.listRoot !== root) {
        throw new Error(`provider ${i}: local list root does not match the gate's (${toBytes32(root)}); refresh lists`);
      }
      witnesses.push(await tree.nonMembership(origin));
    }
    return { roots: onChain.map((r) => BigInt(r)), witnesses };
  }

  /** Builds the ppoi.circom input for a note whose opening the owner supplied. */
  async buildInput(n: NoteOpening): Promise<Record<string, unknown>> {
    const { publicClient, poolAddress } = this.cfg;
    const [origin, shieldedAt] = await Promise.all([
      publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "originOf", args: [n.commit] }),
      publicClient.readContract({ address: poolAddress, abi: POOL_ABI, functionName: "shieldedAt", args: [n.commit] }),
    ]);
    if (shieldedAt === 0n) throw new Error(`commit ${n.commit} was never shielded`);
    const hasher = await getHasher();
    const tokenId = BigInt(keccak256(n.token)) % FIELD_SIZE;
    if (hasher.hash(tokenId, n.rawAmount, n.ownerPkX, n.blinding) !== BigInt(n.commit)) {
      throw new Error("note opening does not match the commitment");
    }
    const { witnesses } = await this.witnessFor(origin);
    return {
      providerRoots: witnesses.map((w) => w.root.toString()),
      noteCommit: BigInt(n.commit).toString(),
      shieldBlock: shieldedAt.toString(),
      originHash: hasher.hash(BigInt(origin)).toString(),
      tokenId: tokenId.toString(),
      rawAmount: n.rawAmount.toString(),
      ownerPkX: n.ownerPkX.toString(),
      blinding: n.blinding.toString(),
      originAddr: BigInt(origin).toString(),
      siblings: witnesses.map((w) => w.siblings.map(String)),
      oldKey: witnesses.map((w) => w.oldKey.toString()),
      oldValue: witnesses.map((w) => w.oldValue.toString()),
      isOld0: witnesses.map((w) => w.isOld0.toString()),
    };
  }

  /** Proves and submits `ppoiVerify` for a note, on the owner's request. Returns the tx hash. */
  async proveAndClear(n: NoteOpening): Promise<Hex> {
    const input = await this.buildInput(n);
    const proof = await this.prove(input);
    const wallet = this.requireWallet();
    const hash = await wallet.writeContract({
      chain: wallet.chain, account: wallet.account!, address: this.cfg.gateAddress, abi: GATE_ABI,
      functionName: "ppoiVerify", args: [n.commit, proof],
    });
    const receipt = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`ppoiVerify reverted: ${hash}`);
    return hash;
  }

  private async prove(input: Record<string, unknown>): Promise<Hex> {
    const dir = mkdtempSync(join(tmpdir(), "ppoi-"));
    const inputPath = join(dir, "input.json");
    const outputPath = join(dir, "output.json");
    try {
      writeFileSync(inputPath, JSON.stringify(input));
      const script = this.cfg.proveScript ?? join(import.meta.dir, "prove-ppoi-subprocess.cjs");
      await new Promise<void>((resolve, reject) => {
        // Piped (not inherited) stdio: inheriting hangs a Bun parent with a Node child.
        const child = spawn("node", [script, inputPath, outputPath, this.cfg.wasmPath, this.cfg.zkeyPath], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stdout?.resume();
        child.stderr?.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ppoi prover exited ${code}: ${stderr}`))));
      });
      const { a, b, c } = JSON.parse(readFileSync(outputPath, "utf-8")) as { a: string[]; b: string[][]; c: string[] };
      return encodeAbiParameters(parseAbiParameters("uint256[2], uint256[2][2], uint256[2]"), [
        a.map(BigInt) as [bigint, bigint],
        b.map((r) => r.map(BigInt)) as [[bigint, bigint], [bigint, bigint]],
        c.map(BigInt) as [bigint, bigint],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private requireWallet(): WalletClient {
    if (!this.cfg.walletClient) throw new Error("this action needs a walletClient");
    return this.cfg.walletClient;
  }
}
