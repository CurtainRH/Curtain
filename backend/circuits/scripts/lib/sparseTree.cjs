// Generic sparse incremental-Merkle-tree builder for test vectors: given a
// handful of (index -> leaf) pairs, computes the depth-`levels` root and
// each known leaf's inclusion path, treating everything else as the
// precomputed zero hash — matching IncrementalMerkleTree.sol's convention
// exactly (zeros[0] = 0, zeros[i] = hash(zeros[i-1], zeros[i-1])).
function computeZeros(levels, hash) {
  const zeros = [0n];
  for (let i = 1; i <= levels; i++) zeros.push(hash(zeros[i - 1], zeros[i - 1]));
  return zeros;
}

/**
 * @param {Map<number, bigint>} leaves - leaf index -> value
 * @param {number} levels
 * @param {bigint[]} zeros - from computeZeros
 * @param {(a: bigint, b: bigint) => bigint} hash
 * @returns {{ root: bigint, getPath: (leafIndex: number) => { pathElements: bigint[], pathIndices: number[] } }}
 */
function buildSparseTree(leaves, levels, zeros, hash) {
  let level = new Map(leaves);
  const levelMaps = [level];

  for (let d = 0; d < levels; d++) {
    const parents = new Set([...level.keys()].map((i) => Math.floor(i / 2)));
    const next = new Map();
    for (const p of parents) {
      const leftIdx = p * 2;
      const rightIdx = p * 2 + 1;
      const left = level.has(leftIdx) ? level.get(leftIdx) : zeros[d];
      const right = level.has(rightIdx) ? level.get(rightIdx) : zeros[d];
      next.set(p, hash(left, right));
    }
    levelMaps.push(next);
    level = next;
  }

  const root = level.has(0) ? level.get(0) : zeros[levels];

  function getPath(leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    let idx = leafIndex;
    for (let d = 0; d < levels; d++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      const siblingLevel = levelMaps[d];
      const siblingVal = siblingLevel.has(siblingIdx) ? siblingLevel.get(siblingIdx) : zeros[d];
      pathElements.push(siblingVal);
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  return { root, getPath };
}

module.exports = { computeZeros, buildSparseTree };
