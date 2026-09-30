// Regression check for a real bug found while building the M4 ppoi-node
// e2e test: ppoi.circom's SMT check is keyed by Poseidon(originAddr), not
// the raw address (`smt[k].key <== addrHasher.out`). Building provider
// trees with raw addresses and searching with a raw address produces a
// witness that only *accidentally* verifies — whether it does depends on
// unrelated bit-alignment luck between the raw address and its hash, which
// is why it "worked" for small test values (0x1234, 0xA11CE) but failed
// consistently for a real 160-bit Ethereum address.
//
// This script manually reimplements circomlibjs's own root-recomputation
// algorithm (SMTHash0/SMTHash1, LSB-first traversal) independently of the
// circuit, to confirm a witness is self-consistent — then confirms the fix
// (hash entries before inserting, search with the hash) holds across a
// range of address magnitudes, not just one lucky value.
const { newMemEmptyTrie, buildPoseidon } = require("circomlibjs");

async function checkTree(rawEntries, bigAddr, F, poseidon) {
  const hash1 = (x) => F.toObject(poseidon([x]));
  const smt = await newMemEmptyTrie();
  for (const e of rawEntries) await smt.insert(hash1(e), 1n);

  const searchKey = hash1(bigAddr);
  const res = await smt.find(searchKey);
  const SMTHash0 = (L, R) => F.toObject(poseidon([L, R]));
  const SMTHash1 = (key, value) => F.toObject(poseidon([key, value, 1n]));

  const keyBits = [];
  let k = searchKey;
  for (let i = 0; i < 256; i++) {
    keyBits.push(k & 1n);
    k >>= 1n;
  }

  let node = res.isOld0 ? 0n : SMTHash1(F.toObject(res.notFoundKey), F.toObject(res.notFoundValue));
  for (let i = res.siblings.length - 1; i >= 0; i--) {
    const sib = F.toObject(res.siblings[i]);
    node = keyBits[i] === 0n ? SMTHash0(node, sib) : SMTHash0(sib, node);
  }

  const actual = F.toObject(smt.root).toString();
  const match = node.toString() === actual;
  console.log(`entries=${rawEntries} siblings.length=${res.siblings.length} MATCH=${match}`);
  if (!match) throw new Error(`MISMATCH for entries=${rawEntries}, bigAddr=${bigAddr}`);
}

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const magnitudes = [
    1000000000000000000n, // 60 bits
    1000000000000000000000000000000000000n, // 120 bits
    1000000000000000000000000000000000000000000000n, // 150 bits
    642829559307850963015472508762062935916233390536n, // 159 bits — a real anvil test address
  ];

  for (const bigAddr of magnitudes) {
    console.log(`--- bigAddr bits=${bigAddr.toString(2).length} ---`);
    await checkTree([111n, 222n], bigAddr, F, poseidon);
    await checkTree([333n, 444n], bigAddr, F, poseidon);
    await checkTree([555n, 666n], bigAddr, F, poseidon);
  }
  console.log("\nAll magnitudes consistent — fix confirmed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
