import { describe, expect, it } from "bun:test";
import { buildPoseidon } from "circomlibjs";
import { computeZeros, LocalMerkleTree } from "../src/tree";

async function poseidonHash2() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  return (a: bigint, b: bigint) => F.toObject(poseidon([a, b])) as bigint;
}

describe("LocalMerkleTree (mirrors CurtainPool.sol's IncrementalMerkleTree convention)", () => {
  it("an empty tree's root is the precomputed all-zeros root", async () => {
    const hash = await poseidonHash2();
    const zeros = await computeZeros(4, hash);
    const tree = new LocalMerkleTree(hash, 4);
    await tree.init();
    expect(await tree.root()).toBe(zeros[4]!);
  });

  it("a path returned by pathTo actually reconstructs the tree's own root", async () => {
    const hash = await poseidonHash2();
    const levels = 4;
    const tree = new LocalMerkleTree(hash, levels);
    await tree.init();
    tree.insert(0, 111n);
    tree.insert(1, 222n);
    tree.insert(3, 333n);

    const root = await tree.root();
    const cases: Array<[number, bigint]> = [[0, 111n], [1, 222n], [3, 333n]];
    for (const [leafIndex, leaf] of cases) {
      const { pathElements, pathIndices } = await tree.pathTo(leafIndex);
      let current: bigint = leaf;
      for (let i = 0; i < levels; i++) {
        current = pathIndices[i] === 0 ? hash(current, pathElements[i]!) : hash(pathElements[i]!, current);
      }
      expect(current).toBe(root);
    }
  });

  it("inserting more leaves changes the root", async () => {
    const hash = await poseidonHash2();
    const tree = new LocalMerkleTree(hash, 4);
    await tree.init();
    const rootBefore = await tree.root();
    tree.insert(0, 42n);
    const rootAfter = await tree.root();
    expect(rootAfter).not.toBe(rootBefore);
  });
});
