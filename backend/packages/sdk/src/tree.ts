/**
 * Local replica of CurtainPool's on-chain incremental Merkle trees
 * (mainTree, clearedTree — both depth 32, Poseidon, per Curtain_Build.md
 * §1). The contract never exposes a "give me leaf i's path" view function,
 * so the wallet must reconstruct the tree itself from Shield/Transact/
 * MarkedCleared event leaves and derive paths locally — same convention as
 * IncrementalMerkleTree.sol (zeros[0] = 0, zeros[i] = hash(zeros[i-1],
 * zeros[i-1])), ported from circuits/scripts/lib/sparseTree.cjs.
 */
export const MERKLE_DEPTH = 32;

export type Hash2 = (a: bigint, b: bigint) => Promise<bigint> | bigint;

export async function computeZeros(levels: number, hash: Hash2): Promise<bigint[]> {
  const zeros = [0n];
  for (let i = 1; i <= levels; i++) zeros.push(await hash(zeros[i - 1]!, zeros[i - 1]!));
  return zeros;
}

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
}

/** Grows as leaves are inserted; recomputes level maps from scratch on each insert (fine at wallet scale — hundreds, not millions, of notes). */
export class LocalMerkleTree {
  private leaves = new Map<number, bigint>();
  private levelMaps: Map<number, bigint>[] = [];
  private zeros: bigint[] = [];
  private hash: Hash2;
  private levels: number;
  private dirty = true;

  constructor(hash: Hash2, levels: number = MERKLE_DEPTH) {
    this.hash = hash;
    this.levels = levels;
  }

  async init(): Promise<void> {
    this.zeros = await computeZeros(this.levels, this.hash);
  }

  insert(leafIndex: number, value: bigint): void {
    this.leaves.set(leafIndex, value);
    this.dirty = true;
  }

  has(leafIndex: number): boolean {
    return this.leaves.has(leafIndex);
  }

  private async rebuild(): Promise<void> {
    if (!this.dirty) return;
    let level = new Map(this.leaves);
    const levelMaps = [level];

    for (let d = 0; d < this.levels; d++) {
      const parents = new Set([...level.keys()].map((i) => Math.floor(i / 2)));
      const next = new Map<number, bigint>();
      for (const p of parents) {
        const leftIdx = p * 2;
        const rightIdx = p * 2 + 1;
        const left = level.has(leftIdx) ? level.get(leftIdx)! : this.zeros[d]!;
        const right = level.has(rightIdx) ? level.get(rightIdx)! : this.zeros[d]!;
        next.set(p, await this.hash(left, right));
      }
      levelMaps.push(next);
      level = next;
    }

    this.levelMaps = levelMaps;
    this.dirty = false;
  }

  async root(): Promise<bigint> {
    await this.rebuild();
    const top = this.levelMaps[this.levels];
    return top?.has(0) ? top.get(0)! : this.zeros[this.levels]!;
  }

  async pathTo(leafIndex: number): Promise<MerklePath> {
    await this.rebuild();
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let idx = leafIndex;
    for (let d = 0; d < this.levels; d++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      const siblingLevel = this.levelMaps[d]!;
      pathElements.push(siblingLevel.has(siblingIdx) ? siblingLevel.get(siblingIdx)! : this.zeros[d]!);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }
}
