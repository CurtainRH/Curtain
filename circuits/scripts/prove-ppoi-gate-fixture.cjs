// Generates a real PPOI proof fixture for ScreeningGate's Foundry test
// suite: a genuine shield-time commitment (matching CurtainPool's exact
// formula) plus a genuine Groth16 proof that its origin address is absent
// from three provider SMTs.
const path = require("path");
const fs = require("fs");
const snarkjs = require("snarkjs");

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Must match the Foundry test's fixed deterministic token address exactly
// (etched with MockERC20's bytecode there) and the alice test address.
const TOKEN_ADDR = "0x000000000000000000000000000000000000FEED";
const ORIGIN_ADDR = 0xA11CEn; // matches `address alice = address(0xA11CE)` in Foundry

function tokenIdOf(tokenAddrHex) {
  const { keccak256 } = require("js-sha3");
  // Matches Solidity's keccak256(abi.encodePacked(address)) — 20 raw bytes,
  // no padding, lowercase hex without 0x.
  const addrBytes = Buffer.from(tokenAddrHex.replace(/^0x/, ""), "hex");
  const hashHex = keccak256(addrBytes);
  return BigInt("0x" + hashHex) % FIELD_SIZE;
}

async function main() {
  const { buildPoseidon, newMemEmptyTrie } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const toField = (x) => F.toObject(x);
  const hash = (...inputs) => toField(poseidon(inputs));

  const NLEVELS = 32;
  const tokenId = tokenIdOf(TOKEN_ADDR);

  const rawAmount = 10n * 10n ** 18n; // 10 ether, matches the Foundry test's shield call
  const feeBps = 20n;
  const fee = (rawAmount * feeBps) / 10000n;
  const netAmount = rawAmount - fee;

  const ownerPkX = 111n;
  const blinding = 222n;
  const commit = hash(tokenId, netAmount, ownerPkX, blinding);

  // Provider lists store HASHED addresses — ppoi.circom's SMT check is
  // against `addrHasher.out = Poseidon(originAddr)`, not the raw address
  // (this is what "blinded" PPOI means: the published list never contains
  // plaintext addresses). Confirmed by circuits/scripts/debug-smt.cjs after
  // this bug was found and fixed — see the M4 session notes.
  async function buildProviderTree(listedAddrs) {
    const smt = await newMemEmptyTrie();
    for (const addr of listedAddrs) await smt.insert(hash(addr), 1n);
    return smt;
  }

  async function nonMembershipWitness(smt, key) {
    const res = await smt.find(key);
    if (res.found) throw new Error("origin unexpectedly listed");
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

  const providers = await Promise.all([
    buildProviderTree([111n, 222n]),
    buildProviderTree([333n, 444n]),
    buildProviderTree([555n, 666n]),
  ]);
  const originHash = hash(ORIGIN_ADDR); // Poseidon(1) — matches PoseidonT2 on-chain
  // Search the tree for the HASHED origin, matching what the circuit checks.
  const witnesses = await Promise.all(providers.map((smt) => nonMembershipWitness(smt, originHash)));
  // Must match the Foundry test's `vm.warp(SHIELD_TIMESTAMP)` before shield()
  // — ScreeningGate.ppoiVerify binds on the pool's real shieldedAt timestamp.
  const shieldBlockPlaceholder = 1_000_000n;

  const input = {
    providerRoots: witnesses.map((w) => w.root.toString()),
    noteCommit: commit.toString(),
    shieldBlock: shieldBlockPlaceholder.toString(),
    originHash: originHash.toString(),
    tokenId: tokenId.toString(),
    rawAmount: netAmount.toString(),
    ownerPkX: ownerPkX.toString(),
    blinding: blinding.toString(),
    originAddr: ORIGIN_ADDR.toString(),
    siblings: witnesses.map((w) => w.siblings.map(String)),
    oldKey: witnesses.map((w) => w.oldKey.toString()),
    oldValue: witnesses.map((w) => w.oldValue.toString()),
    isOld0: witnesses.map((w) => w.isOld0.toString()),
  };

  const buildDir = path.resolve(__dirname, "../build/ppoi_dev");
  const wasmPath = path.join(buildDir, "ppoi_dev_js", "ppoi_dev.wasm");
  const zkeyPath = path.join(buildDir, "ppoi_dev_final.zkey");
  const vkeyPath = path.join(buildDir, "verification_key.json");

  console.log("Generating gate-test PPOI proof...");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Verified:", ok);
  if (!ok) process.exit(1);

  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const parsed = JSON.parse(`[${calldata}]`);
  const [a, b, c] = parsed;

  const fixture = {
    tokenAddr: TOKEN_ADDR,
    originAddr: "0x" + ORIGIN_ADDR.toString(16).padStart(40, "0"),
    commit: "0x" + commit.toString(16).padStart(64, "0"),
    rawAmount: rawAmount.toString(),
    ownerPkX: ownerPkX.toString(),
    blinding: blinding.toString(),
    providerRoots: witnesses.map((w) => "0x" + w.root.toString(16).padStart(64, "0")),
    a, b, c,
    publicSignals,
  };

  const outPath = path.resolve(__dirname, "../../contracts/test/fixtures/ppoi_gate_proof.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`Wrote ${outPath}`);
  process.exit(0); // snarkjs leaves the process alive otherwise — see prove-ppoi-subprocess.cjs's header
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
