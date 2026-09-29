// M2 proof-gen/verify vector for the PPOI circuit (dev instantiation,
// depth 32 — see ppoi_dev.circom for why). Builds three independent sparse
// Merkle trees (one per provider) each containing a couple of "listed"
// addresses, then proves that an unrelated address is absent from all three
// — the actual PPOI statement — while also proving the note commitment
// opens correctly.
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");

async function main() {
  const { buildPoseidon, newMemEmptyTrie } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (x) => F.toObject(x);
  const hash = (...inputs) => toField(poseidon(inputs));

  const NLEVELS = 32;

  async function buildProviderTree(listedAddrs) {
    const smt = await newMemEmptyTrie();
    for (const addr of listedAddrs) await smt.insert(addr, 1n);
    return smt;
  }

  async function nonMembershipWitness(smt, key) {
    const res = await smt.find(key);
    if (res.found) throw new Error("key unexpectedly found in provider tree");
    const siblings = res.siblings.map((s) => smt.F.toObject(s));
    while (siblings.length < NLEVELS) siblings.push(0n);
    return {
      root: smt.F.toObject(smt.root),
      siblings,
      oldKey: res.isOld0 ? 0n : smt.F.toObject(res.notFoundKey),
      oldValue: res.isOld0 ? 0n : smt.F.toObject(res.notFoundValue),
      isOld0: res.isOld0 ? 1n : 0n,
    };
  }

  // Three providers, each listing a couple of unrelated addresses.
  const providers = await Promise.all([
    buildProviderTree([111n, 222n]),
    buildProviderTree([333n, 444n]),
    buildProviderTree([555n, 666n]),
  ]);

  const originAddr = 0x1234n; // the shielder's address — not on any list
  const originHash = hash(originAddr);

  const witnesses = await Promise.all(providers.map((smt) => nonMembershipWitness(smt, originAddr)));

  // Note opening this PPOI proof is bound to.
  const tokenId = 999n;
  const rawAmount = 100n;
  const ownerPkX = 42n;
  const blinding = 7n;
  const noteCommit = hash(tokenId, rawAmount, ownerPkX, blinding);

  const input = {
    providerRoots: witnesses.map((w) => w.root.toString()),
    noteCommit: noteCommit.toString(),
    shieldBlock: "123456",
    originHash: originHash.toString(),
    tokenId: tokenId.toString(),
    rawAmount: rawAmount.toString(),
    ownerPkX: ownerPkX.toString(),
    blinding: blinding.toString(),
    originAddr: originAddr.toString(),
    siblings: witnesses.map((w) => w.siblings.map(String)),
    oldKey: witnesses.map((w) => w.oldKey.toString()),
    oldValue: witnesses.map((w) => w.oldValue.toString()),
    isOld0: witnesses.map((w) => w.isOld0.toString()),
  };

  const buildDir = path.resolve(__dirname, "../build/ppoi_dev");
  const wasmPath = path.join(buildDir, "ppoi_dev_js", "ppoi_dev.wasm");
  const zkeyPath = path.join(buildDir, "ppoi_dev_final.zkey");
  const vkeyPath = path.join(buildDir, "verification_key.json");

  console.log("Generating witness + Groth16 proof for PPOI...");
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const proveMs = performance.now() - t0;
  console.log(`Proving time: ${proveMs.toFixed(0)}ms`);

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Verification result:", ok);

  fs.writeFileSync(path.join(buildDir, "test_input.json"), JSON.stringify(input, null, 2));
  fs.writeFileSync(path.join(buildDir, "test_proof.json"), JSON.stringify(proof, null, 2));
  fs.writeFileSync(path.join(buildDir, "test_public.json"), JSON.stringify(publicSignals, null, 2));

  console.log("\n=== PPOI (dev) proof-gen/verify vector ===");
  console.log(`Proof generated: yes`);
  console.log(`Proof verified:  ${ok}`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
