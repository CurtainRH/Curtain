/**
 * Provider list trees, per Curtain_Build.md §1 (PPOI) and §4.2.
 *
 * Each provider publishes a newline-delimited list of lowercase addresses. From it this
 * module builds the two roots ScreeningGate stores:
 * - `listRoot`: a circomlib sparse Merkle tree keyed by Poseidon(address). PPOI proofs show
 *   the origin's hash is NOT in it (ppoi.circom). The empty tree's root is 0, which is also
 *   what ScreeningGate uses for an excluded (removed or stale) provider.
 * - `flagRoot`: a depth-32 Poseidon Merkle tree whose leaves are the raw addresses, in list
 *   order, zero-padded (MerkleProof32.sol / circuits/scripts/lib/sparseTree.cjs). `flag()`
 *   proves an origin IS in it.
 */
import { buildPoseidon, newMemEmptyTrie } from "circomlibjs";
import type { Address } from "viem";

export const SMT_LEVELS = 32; // ppoi_dev.circom; the production circuit uses 160
export const FLAG_LEVELS = 32; // MerkleProof32.LEVELS

export interface Hasher {
  hash(...inputs: bigint[]): bigint;
  F: { toObject(x: unknown): bigint };
}

let hasherPromise: Promise<Hasher> | undefined;

export function getHasher(): Promise<Hasher> {
  if (hasherPromise) return hasherPromise;
  const p: Promise<Hasher> = buildPoseidon().then((poseidon: { F: Hasher["F"] } & ((i: bigint[]) => unknown)) => ({
    F: poseidon.F,
    hash: (...inputs: bigint[]) => poseidon.F.toObject(poseidon(inputs)),
  }));
  hasherPromise = p;
  return p;
}

/** Parses a provider list: one address per line, blank lines and `#` comments ignored. */
export function parseList(text: string): Address[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (line === "" || line.startsWith("#")) continue;
    if (!/^0x[0-9a-f]{40}$/.test(line)) throw new Error(`invalid address in provider list: ${raw}`);
    out.add(line);
  }
  return [...out].sort() as Address[];
}

export interface NonMembershipWitness {
  root: bigint;
  siblings: bigint[];
  oldKey: bigint;
  oldValue: bigint;
  isOld0: bigint;
}

export interface FlagPath {
  pathElements: bigint[];
  pathIndices: number[];
}

export class ProviderTree {
  private constructor(
    readonly addresses: Address[],
    readonly listRoot: bigint,
    readonly flagRoot: bigint,
    private smt: { root: unknown; find(key: bigint): Promise<SmtFind> },
    private flagLevels: Map<number, bigint>[],
    private zeros: bigint[],
    private hasher: Hasher,
  ) {}

  static async build(addresses: Address[]): Promise<ProviderTree> {
    const hasher = await getHasher();
    // Sequential inserts: concurrent circomlibjs SMT operations may interleave over shared WASM state.
    const smt = await newMemEmptyTrie();
    for (const a of addresses) await smt.insert(hasher.hash(BigInt(a)), 1n);
    const listRoot = hasher.F.toObject(smt.root);

    const zeros = [0n];
    for (let i = 1; i <= FLAG_LEVELS; i++) zeros.push(hasher.hash(zeros[i - 1]!, zeros[i - 1]!));
    let level = new Map<number, bigint>(addresses.map((a, i) => [i, BigInt(a)]));
    const levels = [level];
    for (let d = 0; d < FLAG_LEVELS; d++) {
      const next = new Map<number, bigint>();
      for (const p of new Set([...level.keys()].map((i) => Math.floor(i / 2)))) {
        next.set(p, hasher.hash(level.get(2 * p) ?? zeros[d]!, level.get(2 * p + 1) ?? zeros[d]!));
      }
      levels.push(next);
      level = next;
    }
    const flagRoot = level.get(0) ?? zeros[FLAG_LEVELS]!;
    return new ProviderTree(addresses, listRoot, flagRoot, smt, levels, zeros, hasher);
  }

  /** An empty list: listRoot 0, the tree ScreeningGate substitutes for excluded providers. */
  static empty(): Promise<ProviderTree> {
    return ProviderTree.build([]);
  }

  has(address: Address): boolean {
    return this.addresses.includes(address.toLowerCase() as Address);
  }

  /** Witness that Poseidon(origin) is not in this provider's list (ppoi.circom inputs). */
  async nonMembership(origin: Address): Promise<NonMembershipWitness> {
    const key = this.hasher.hash(BigInt(origin));
    const res = await this.smt.find(key);
    if (res.found) throw new Error(`origin ${origin} is listed by this provider`);
    const siblings = res.siblings.map((s) => this.hasher.F.toObject(s));
    while (siblings.length < SMT_LEVELS) siblings.push(0n);
    return {
      root: this.listRoot,
      siblings,
      oldKey: res.isOld0 ? 0n : this.hasher.F.toObject(res.notFoundKey),
      oldValue: res.isOld0 ? 0n : this.hasher.F.toObject(res.notFoundValue),
      isOld0: res.isOld0 ? 1n : 0n,
    };
  }

  /** Inclusion path for `flag()`; undefined if the address isn't listed. */
  flagPath(address: Address): FlagPath | undefined {
    let idx = this.addresses.indexOf(address.toLowerCase() as Address);
    if (idx < 0) return undefined;
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    for (let d = 0; d < FLAG_LEVELS; d++) {
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(this.flagLevels[d]!.get(sib) ?? this.zeros[d]!);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  /** Recomputes the flag root from a path, the way MerkleProof32.verify does. */
  verifyFlagPath(address: Address, p: FlagPath): boolean {
    let cur = BigInt(address);
    for (let d = 0; d < FLAG_LEVELS; d++) {
      cur = p.pathIndices[d] === 0 ? this.hasher.hash(cur, p.pathElements[d]!) : this.hasher.hash(p.pathElements[d]!, cur);
    }
    return cur === this.flagRoot;
  }
}

interface SmtFind {
  found: boolean;
  siblings: unknown[];
  isOld0: boolean;
  notFoundKey: unknown;
  notFoundValue: unknown;
}

export function toBytes32(x: bigint): `0x${string}` {
  return `0x${x.toString(16).padStart(64, "0")}`;
}
