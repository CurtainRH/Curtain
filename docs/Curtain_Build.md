# CURTAIN ($CRTN) — Implementation Build (dev handoff)

Companion docs: [Curtain_Overview.md](./Curtain_Overview.md) (what/why), [Curtain_Backend.md](./Curtain_Backend.md) (architecture). This file is the **how**: repo layout, exact interfaces, circuit specs, note/key/encryption formats, service protocols, config, deploy runbook, test matrix, launch gates. Every milestone is sized for one focused build session with a known target and a passing test suite.

**Chain:** Robinhood Chain 4663 (Arbitrum Orbit). **Toolchain (source spec):** Foundry (forge/cast/anvil), Bun 1.x, Hono, tRPC v11, Drizzle + Postgres 16 + Timescale, Redis 7 + BullMQ, circom 2.x + snarkjs (Groth16, BN254) for the join-split family the studio already ships; rapidsnark/GPU prover for `prover-assist`.

> **This repo's actual stack:** Node/Express (TypeScript) on Bun instead of Hono/tRPC; plain partitioned Postgres on Railway instead of Supabase/Timescale. Everything else below is unchanged from spec.

## 0. Repo layout

```
curtain/
├─ contracts/              (Foundry)
│  ├─ src/
│  │  ├─ pool/CurtainPool.sol
│  │  ├─ pool/Verifiers.sol           (JoinSplitVerifier, PPOIVerifier — generated)
│  │  ├─ gate/ScreeningGate.sol
│  │  ├─ adapt/RelayAdapt.sol
│  │  ├─ adapt/targets/*.sol          (thin adapters: UniswapV3, UniswapV4, MorphoVault, Arcus, Prism)
│  │  ├─ stealth/StealthRegistry.sol  (ERC-6538)
│  │  ├─ stealth/StealthAnnouncer.sol (ERC-5564)
│  │  ├─ broadcast/BroadcasterBond.sol
│  │  ├─ disclosure/DisclosureRegistry.sol
│  │  ├─ solvency/SolvencyVerifier.sol
│  │  ├─ token/CRTN.sol, staking/CrtnStaking.sol
│  │  └─ config/AssetGate.sol         (registered tokens; is8056 flag)
│  ├─ test/                           (forge; fuzz + invariants)
│  └─ script/Deploy.s.sol, Pin.s.sol
├─ circuits/                          (circom)
│  ├─ joinsplit.circom                (2-in 2-out, 3-in 3-out variants; existing studio circuit, re-parameterized)
│  ├─ ppoi.circom                     (blinded non-membership vs K provider roots)
│  ├─ solvency.circom                 (Σ live notes per token ≤ pool balance)
│  ├─ build/                          (r1cs, zkey, verification keys; ceremony transcript)
│  └─ test/
├─ packages/
│  ├─ sdk/                            (TS: keys, notes, encryption, proving (wasm + assist), recipes runner)
│  ├─ recipes/                        (Step/Recipe/Combo library)
│  └─ verifier/                       (receipt/solvency verifier lib)
├─ services/
│  ├─ broadcaster/ ├─ ppoi-node/ ├─ prover-assist/ ├─ multiplier-view/
│  ├─ solvency/    ├─ indexer/   ├─ api/           └─ status/
├─ apps/web/                          (wallet: shield/send/recipes/disclosure; scans stealth announcements)
├─ infra/                             (docker-compose, k8s manifests / Railway config, DB init)
└─ docs/
```

## 1. Cryptographic primitives (fixed for v1)

| Primitive | Choice |
|---|---|
| Field / curve | BN254 (circom/snarkjs); Poseidon hash (t=3/t=5 as needed) |
| Note commitment | `C = Poseidon(tokenId, rawAmount, ownerPk_x, blinding)`; `tokenId = uint(keccak(tokenAddr)) mod p` |
| Nullifier | `N = Poseidon(ownerSk, leafIndex)` |
| Owner keys | spending key `sk ∈ F_p`; `pk = sk·G` on Baby Jubjub; viewing key `vk = Poseidon(sk, 1)`; note-encryption key `ek = vk·G` |
| Note encryption (to recipient) | ECDH on Baby Jubjub (ephemeral `r`, shared `S = r·ek`) → ChaCha20-Poly1305 key = `Poseidon(S.x, S.y)` → ciphertext of `{tokenId, rawAmount, blinding, memo}`; stored in event `NoteCiphertext(ephemeralPk, ct)` |
| Merkle tree | Incremental, depth 32, Poseidon; roots kept in a ring of last 128 roots |
| Stealth (ERC-5564) | secp256k1 scheme id 1 (standard); meta-address = spending pk ‖ viewing pk; view tag 1 byte |
| PPOI | Sparse Merkle non-membership proofs against each provider root (depth 160 over `addressHash`), blinded by re-randomized commitment; Groth16 |
| Solvency | Per token: Σ over all unspent leaves (via nullifier-set complement) — computed off-chain with a Groth16 proof over a snapshot root + nullifier root; on-chain check vs `balanceOf(pool)` |

**Trusted setup:** reuse the studio's Phase-2 ceremony for join-split (same circuit family; new parameters require a new Phase-2 contribution round — run a 3-party contribution and publish the transcript in `circuits/build/ceremony.md`).

## 2. Circuits

### 2.1 `joinsplit.circom` (2×2 and 3×3)

```
public:  root, nullifiers[k], newCommits[m], tokenId, unshieldAmount, unshieldTo, extDataHash
private: for each input i: rawAmount_i, blinding_i, leafIndex_i, merklePath_i, ownerSk
         for each output j: rawAmount_j, blinding_j, ownerPk_j
constraints:
  ∀i: C_i = Poseidon(tokenId, rawAmount_i, pk(ownerSk).x, blinding_i); MerkleVerify(C_i, path_i, root)
  ∀j: newCommits_j = Poseidon(tokenId, rawAmount_j, ownerPk_j.x, blinding_j)
  Σ rawAmount_i == Σ rawAmount_j + unshieldAmount + feeAmount
  all amounts < 2^128 (range checks)
  extDataHash binds (unshieldTo, calls hash for RelayAdapt, broadcaster fee) — prevents front-running/replay
```

Single token per proof (multi-token spends = multiple proofs in one tx via `transactBatch`).

### 2.2 `ppoi.circom`

```
public:  providerRoots[K] (K=3..5), noteCommit, shieldBlock
private: originAddr, addrHash = Poseidon(originAddr), nonMembershipPaths[K] (SMT siblings + neighbor)
constraints:
  noteCommit opens correctly
  ∀k: SMTNonMembership(addrHash, providerRoots[k], path_k) == true
  originHash matches pool.originOf[noteCommit] (passed as public input `originHash`)
```

Blinding: the prover reveals nothing about `originAddr` beyond non-membership; `originHash` is already public from the shield tx (stored as hash, not address — the pool stores `originOf` as **the address** for `unshieldToOrigin`; PPOI binds via hash to avoid re-revealing in the proof).

> ⚠️ **Underspecified:** the pool's `originOf` mapping returns an `address` on-chain, while the circuit's public input is a Poseidon hash. Something (likely `ScreeningGate.ppoiVerify`) needs to hash `originOf(commit)` before comparing to the circuit's `originHash` public input — this glue step isn't spelled out in the source spec and should be nailed down during M4.

### 2.3 `solvency.circom`

```
public:  snapshotRoot (commitment tree), nullifierRoot, tokenId, totalUnspent
private: list of leaves with (commit opening, spent flag proof) — batched in chunks of 4096
```

v1 uses chunked proofs (no recursion): `SolvencyVerifier.submitChunk(epoch, tokenId, chunkIdx, partialSum, proof)`; `finalize(epoch, tokenId)` checks Σ partials ≤ `balanceOf(pool)`.

## 3. Contract interfaces (Solidity 0.8.26)

### 3.1 `CurtainPool` (immutable; no owner)

```solidity
interface ICurtainPool {
  event Shield(bytes32 indexed commit, uint32 leafIndex, address indexed token, uint256 rawAmount);
  event NoteCiphertext(bytes32 indexed commit, bytes ephemeralPk, bytes ct);
  event Transact(bytes32[] nullifiers, bytes32[] newCommits, bytes32 root, address unshieldTo);
  event UnshieldToOrigin(bytes32 indexed commit, address indexed origin, uint256 rawAmount);

  function shield(address token, uint256 rawAmount, bytes32 commit, bytes calldata ciphertext, bytes calldata ppoiProof) external;
  // pulls token (permit2 optional); fee = rawAmount*20/10000 → treasury; originOf[commit] = msg.sender
  function transact(TransactArgs calldata a) external;             // single token
  function transactBatch(TransactArgs[] calldata a) external;      // multi token, atomic
  function unshieldToOrigin(bytes32 commit, bytes calldata proof) external; // proof = opening only
  function isKnownRoot(bytes32 root) external view returns (bool);
  function originOf(bytes32 commit) external view returns (address);
  function shieldedAt(bytes32 commit) external view returns (uint64);
  function nullifierUsed(bytes32 n) external view returns (bool);
}

struct TransactArgs { bytes proof; bytes32 root; bytes32[] nullifiers; bytes32[] newCommits; address unshieldTo; uint256 unshieldAmount; }
```

`transact` gating: `ScreeningGate.spendable(commit)` for every input note's commit (resolved via a `leafIndex → commit` map). `unshieldToOrigin` has no gate.

### 3.2 `ScreeningGate`

```solidity
interface IScreeningGate {
  function addProvider(uint8 id, address publisher, string calldata name) external; // timelock
  function removeProvider(uint8 id) external;                                       // timelock
  function updateRoot(uint8 id, bytes32 newRoot) external;                          // publisher
  function ppoiVerify(bytes32 commit, bytes calldata proof, bytes32[] calldata rootsUsed) external;
  function flag(bytes32 commit, uint8 providerId, bytes calldata membershipProof) external;
  function spendable(bytes32 commit) external view returns (bool);
  // spendable = !flagged && (cleared || block.timestamp > shieldedAt + standby())
  function standby() external view returns (uint64); // 15 min; 60 min if < 2 fresh providers
}
```

> ⚠️ **Underspecified:** `flag()` takes a `membershipProof`, but the only circuit defined (`ppoi.circom`) proves **non**-membership. No membership circuit exists in this spec. The likely intent is a plain (non-ZK) Merkle-inclusion proof against a provider's public list root — a positive hit doesn't need privacy — but this should be confirmed/decided explicitly before implementing M4, rather than assumed.

### 3.3 `RelayAdapt`

```solidity
interface IRelayAdapt {
  struct Call { address to; uint256 value; bytes data; }

  function relay(
    ICurtainPool.TransactArgs calldata unshield, // unshieldTo == address(this), extDataHash binds calls
    Call[] calldata calls,
    address[] calldata tokensOut, bytes32[] calldata reshieldCommits, bytes[] calldata reshieldCiphertexts,
    address broadcaster, uint256 broadcasterFee, address feeToken
  ) external;

  function allowedTarget(address) external view returns (bool); // timelock-managed
}
```

Internals: `pool.transact(unshield)` → for each call: `require(allowedTarget(to))`; approve exact amounts to `to` (reset to 0 after); execute → for each `tokensOut[i]`: `bal = balanceOf(this)`; `require(bal ≥ minOut[i])`; `pool.reshield(tokensOut[i], bal, reshieldCommits[i], ...)` (internal entry that **skips fee and standby** and sets `originOf` = original note's origin, carried via `extData`). Any leftover ETH/tokens → revert (no residue). Reentrancy guard.

### 3.4 `BroadcasterBond`

```solidity
function bond(uint256 amount) external;                                    // ≥ 25,000 CRTN
function setFees(uint16 feeBps, uint16 gasMarkupBps) external;             // feeBps ≤ 30
function slash(address b, uint256 amount, bytes32 evidenceRoot, bytes[] calldata attestorSigs) external;
function requestUnbond() external; function unbond() external;             // 14d
```

### 3.5 `StealthRegistry` / `StealthAnnouncer`

Implement ERC-6538 (`registerKeys(schemeId, stealthMetaAddress)`) and ERC-5564 (`announce(schemeId, stealthAddress, ephemeralPubKey, metadata)`) verbatim; no custom fields.

### 3.6 `DisclosureRegistry`

```solidity
function grant(bytes32 scopeHash, bytes calldata viewerEk, bytes calldata encryptedVk, uint64 until) external;
function revoke(bytes32 grantId) external; // forward-only: viewer keeps what it already decrypted
```

### 3.7 `SolvencyVerifier` — chunked as in §2.3; `epochOk(token) → (bool, uint64 ts)`.

### 3.8 `AssetGate` — `register(token, is8056, feed)`; `isRegistered`; timelock.

### 3.9 `CrtnStaking` — standard staking; fee router sends 60% of pool fees; governors vote provider add/remove, RelayAdapt targets, fee within [10, 30] bps.

## 4. Services — protocols

### 4.1 Broadcaster protocol (`services/broadcaster`)

Transport: libp2p gossipsub topic `curtain/bundles/v1` (Waku-compatible), plus HTTPS fallback `POST /bundle`.

Bundle: `{ chainId, kind: "transact"|"relay"|"unshieldToOrigin"|"shieldMeta", calldata, feeToken, feeAmount, deadline, extDataHash, sig? }`. Fee is paid **inside the proof** (an output note to the broadcaster's pk or unshield to its address), so the broadcaster verifies `extDataHash` binds its address + fee before spending gas.

Broadcaster: simulate (`eth_call`) → check fee ≥ published schedule → submit → return txHash. Publishes `/fees.json` and `/health`.

Assignment: bundles carry a random assignee from the bonded set; if not mined in 10 min, any broadcaster may submit and file censorship evidence.

### 4.2 PPOI node (`services/ppoi-node`)

Provider list format: newline-delimited lowercase addresses at a signed URL; node builds SMT (depth 160) and publishes root; publisher key calls `updateRoot` (max once/hour).

Launch providers (3): sanctions oracle mirror (public OFAC list), community scam list (e.g., ScamSniffer-style feed), protocol ASP (studio-maintained: known exploit addresses).

Per new `Shield` event: fetch `originOf` (from tx sender), build non-membership paths vs all active roots, prove (GPU), call `ppoiVerify`. Target < 2 min. Gossip proof so any node can submit.

### 4.3 prover-assist (`services/prover-assist`)

Endpoint `POST /prove/{circuit}` with **blinded witness**: client sends `{publicInputs, encryptedPrivateWitness}` where the private witness is encrypted to a one-time enclave/prover key **and** pre-blinded (amounts/pks are Pedersen-blinded values consistent with the circuit's blinded variant). v1 pragmatic path: run `prover-assist` inside a CPU TEE (TDX) with attestation; client verifies attestation before sending; server discards witness after proof. Desktop always proves locally (wasm).

### 4.4 Recipes SDK (`packages/recipes`)

```ts
type Step = { name: string; inputs: TokenAmount[]; call: (ctx) => Call[]; outputs: TokenSpec[] };
type Recipe = { id: string; version: string; steps: Step[]; targets: Address[] };
type Combo = { recipes: Recipe[] };
export async function buildRelay(recipe, params, notes, keys): Promise<RelayBundle>
```

Day-one recipes: `UniswapV3ExactIn`, `UniswapV4ExactIn`, `BuyAndShield(USDG→StockToken)`, `MorphoDeposit`, `MorphoWithdraw`, `ArcusOpen/Close`, `PrismDexSwap`. Each recipe declares `minOut` computation (from quote − slippage) so RelayAdapt can enforce.

### 4.5 `multiplier-view` / `indexer` / `api` / `status` — as in Backend §3; `status` renders provider freshness, standby (15/60), broadcaster fees/uptime, solvency per token.

## 5. Wallet SDK (`packages/sdk`)

- Key derivation: BIP-39 seed → `sk = HKDF(seed, "curtain/spend/v1") mod p`; `vk`, `ek` derived as §1. Export viewing key for disclosure.
- Note store: local IndexedDB (web) / SQLite (mobile); sync = scan `NoteCiphertext` events, trial-decrypt with `vk` (view-tag optimization: 1 byte prefix).
- Balance display: raw × `uiMultiplier()` for 8056 tokens (from `multiplier-view`).
- API: `shield(token, amount)`, `send(token, amount, recipientPk)`, `unshield(token, amount, to)`, `unshieldToOrigin(note)`, `relay(recipe, params)`, `disclose(scope, viewerEk, until)`, `stealth.resolve(metaAddr)`, `stealth.scan()`.
- Proving: wasm (snarkjs) by default on desktop; `prover-assist` on mobile after attestation check.

## 6. Config / env

```
CHAIN_ID=4663
RPC_HTTP=… (archive)   RPC_WS=…
POOL_ADDR= GATE_ADDR= ADAPT_ADDR= BOND_ADDR= STEALTH_REG= STEALTH_ANN= DISCLOSURE_ADDR=
USDG_ADDR=0x… UNIV3_ROUTER= UNIV4_POOL_MANAGER= MORPHO_USDG_VAULT= ARCUS_ROUTER= PRISM_DEX_ROUTER=
PPOI_PROVIDERS=[{id:1,url:…,pubkey:…},{id:2,…},{id:3,…}]
STANDBY_SECONDS=900 STANDBY_DEGRADED_SECONDS=3600
FEE_BPS_SHIELD=20 FEE_BPS_UNSHIELD=20
BROADCASTER_MIN_BOND=25000e18 BROADCASTER_MAX_FEE_BPS=30
DB_URL=postgres://… REDIS_URL=…
PROVER_MODE=local|assist PROVER_ASSIST_URL=… PROVER_ASSIST_ATTESTATION_ROOT=…
```

All contract addresses pinned with bytecode hashes in `contracts/script/Pin.s.sol`; deploy aborts on mismatch. See [.env.example](../.env.example) for this repo's concrete template.

## 7. Deploy runbook

1. **Ceremony:** Phase-2 contributions for `joinsplit`, `ppoi`, `solvency`; publish transcript + verification keys; generate `Verifiers.sol`.
2. **Fresh deployer** (never used elsewhere); fund with ETH on 4663.
3. Deploy `AssetGate` → register USDG + launch Stock Tokens (NVDA, TSLA, SPY, QQQ, HOOD) with `is8056=true` and feeds.
4. Deploy `Verifiers`, `ScreeningGate` (3 providers, standby 900), `DisclosureRegistry`, `SolvencyVerifier`.
5. Deploy `CurtainPool(verifiers, gate, treasury)` — **verify no admin functions** (`forge inspect` selectors + test).
6. Deploy `RelayAdapt(pool)`; set allowed targets (Uniswap V3 router, V4 PoolManager adapter, Morpho vault, Arcus, Prism DEX) via timelock.
7. Deploy `StealthRegistry`, `StealthAnnouncer`.
8. Deploy `CRTN`, `CrtnStaking`, `BroadcasterBond`; bond 3 studio broadcasters.
9. Transfer gate/adapt/assetgate ownership → 2-of-3 multisig behind 24h timelock; guardian role (pause `shield`/`relay` only) → separate key.
10. Run `Pin.s.sol`; publish `deployments/4663.json` + bytecode hashes; status page live.
11. Smoke: shield 1 USDG → PPOI clears → send → unshield-to-origin → relay `BuyAndShield` 10 USDG → NVDA note; solvency epoch passes.

## 8. Milestones (each = one focused build session, one PR, green tests)

| # | Milestone | Deliverable | Acceptance |
|---|---|---|---|
| M0 | Repo + toolchain + CI | monorepo, forge/bun CI, DB init | `forge test`, `bun test` green on empty suites |
| M1 | Stealth v0 | ERC-6538/5564 contracts + SDK resolve/scan + web page | Send USDG/NVDA to a stealth address; recipient scans and sweeps |
| M2 | Circuits | joinsplit 2×2/3×3, ppoi, solvency (chunked) + ceremony | Proof gen/verify vectors; wasm prover < 8s desktop for 2×2 |
| M3 | Pool | `CurtainPool` + verifiers + `AssetGate`; 8056 raw-unit notes | Shield/transact/unshieldToOrigin tests; immutability test; fuzz conservation |
| M4 | Gate + PPOI | `ScreeningGate` multi-provider, standby 15/60, flag/ragequit; `ppoi-node` | Standby/flag tests; node clears a shield in < 2 min on testnet |
| M5 | Wallet SDK + web | keys, note sync, balances w/ multiplier, shield/send/unshield UI | E2E: shield → send → unshield-to-origin from the UI |
| M6 | RelayAdapt + recipes v1 | adapt + Uniswap V3/V4 adapters + `BuyAndShield` | Atomicity tests; buy NVDA into shield in one tx on testnet |
| M7 | Broadcasters | gossip + HTTPS, bond, fee-in-proof, assignment/censorship evidence | 3 broadcasters; bundle mined by non-assignee after 10 min; slash path test |
| M8 | prover-assist | TDX-attested assist; client attestation check; blinded witness | Mobile proof < 10s p95; server leaks nothing (harness) |
| M9 | Morpho / Arcus / Prism recipes | yield-in-shield; perps; DEX | Deposit/withdraw Morpho from shield; NAV shown; no APY strings |
| M10 | Disclosure + Solvency | grant/revoke UX; hourly chunked proofs; status page | Auditor decrypts scoped notes; solvency epoch ok/fail tests |
| M11 | Staking + fees | CRTN, staking, fee router, governor votes | Fees split 60/40; votes gated to allowed params only |
| M12 | Mainnet | runbook §7; smoke; launch assets | All §9 gates green |

## 9. Launch gates (all must be green)

- **Immutability:** pool bytecode has no owner/upgrade/pause selectors; verified on explorer.
- **Exit:** `unshieldToOrigin` succeeds in every state (standby, flagged, degraded providers, guardian pause) — automated test on mainnet fork.
- **Privacy CI:** grep/schema tests prove no (owner, amount) tuples in DB/logs; broadcaster/ppoi/prover-assist store nothing post-request.
- **PPOI:** 3 providers fresh; standby 15 min; degrade path tested.
- **Solvency:** first two epochs verified on-chain.
- **Recipes:** `BuyAndShield` + Morpho deposit run end-to-end from the web wallet with a broadcaster.
- **Copy lint:** blocked words absent from `apps/`, `docs/`.
- **OPSEC:** deployer, domain, RPC keys, hosting, and design system unique to Curtain.

## 10. Security checklist (before audit)

- Reentrancy on `RelayAdapt` (checks-effects-interactions; guard); approvals zeroed after each call; no residue (revert if any balance remains).
- `extDataHash` binds every external parameter a proof could be replayed with (recipient, calls, fees, broadcaster).
- Root ring (128) prevents proofs against stale roots older than ~1h at RHC block times; document.
- Nullifier double-spend across `transactBatch`.
- Provider root update race: `ppoiVerify` accepts roots current at submission or one update back.
- `flag` only within standby; cannot flag cleared notes retroactively.
- Guardian cannot block `transact` / `unshieldToOrigin`.
- 8056 tokens: raw units only in circuits; multiplier never touches proofs.
- Broadcaster fee bounded by schedule; malformed bundle cost borne by broadcaster.
- Ceremony transcript published; verification keys hashed into `Verifiers.sol` and pinned.

## 11. Known ambiguities (carried over from spec review — resolve before the relevant milestone)

1. PPOI degrade trigger: Overview says outage > 6h; Backend says stale after 24h with no root update. **Resolved in M4** by going with Backend's 24h (`ScreeningGate.PROVIDER_STALE_AFTER`) — documented as a judgment call, not a spec reconciliation.
2. ~~`flag()`'s "membership proof" has no corresponding circuit~~ — **resolved in M4**: implemented as a plain (non-ZK) depth-32 Merkle inclusion proof against a provider-published `flagRoot`, reusing the existing, already-tested `MerkleProof32` library rather than a from-scratch on-chain SMT membership verifier. Tradeoff: providers now publish two roots (`listRoot` for ZK non-membership, `flagRoot` for plain membership) instead of one. See `ScreeningGate.sol`'s header.
3. ~~`originHash` vs. `originOf()` glue step~~ — **resolved in M2**: `ppoi.circom` takes `originHash = Poseidon(originAddr)` as a private-input-derived public signal and the contract-side `ScreeningGate.ppoiVerify` (M4) must hash `originOf(commit)` with the same Poseidon(1) before comparing. See `circuits/ppoi.circom`'s header comment.
4. "Ragequit" is named in Overview/Backend but has no corresponding contract function anywhere in this spec — likely just referring to `unshieldToOrigin`. Unify terminology before M4's acceptance test is written.
5. $CRTN 80/10/5/5 split buckets are unlabeled. Needed before M11 (staking/token) work.
6. ~~`transact`'s spec'd gating~~ — **resolved in M4**: `ScreeningGate.spendable(commit)` genuinely cannot be called from `transact()` (nullifiers are deliberately unlinkable from the commitment they spend). Fixed by adding a **second tree** — `clearedTree` — that `joinsplit.circom` now proves membership against for every input note, alongside the main deposit tree. A Merkle proof reveals nothing about the leaf's position, so this enforces "only spend cleared notes" without the contract ever learning which note is being spent. `CurtainPool.markCleared(commit)` (permissionless) inserts a shield-time commitment into `clearedTree` once `ScreeningGate.spendable()` confirms it; `transact()`'s own outputs are inserted directly, inheriting clean status from already-verified inputs. This **did** require re-running the M2 ceremony for `joinsplit2x2`/`joinsplit3x3` (public signal count went 10→11 / 12→13) — reused the existing `pot_final.ptau` since both circuits still fit under 2^18 constraints after the change.
7. **[found in M3]** `shield()`'s spec'd signature (`shield(token, rawAmount, commit, ciphertext, ppoiProof)`) takes a pre-built `commit` directly. Accepting an opaque commitment without verifying its internal structure lets a user encode a note value larger than what they actually deposited (net of fee) — a real solvency-draining vulnerability, since nothing else in the system checks a note's claimed value against its true backing until it's spent. `CurtainPool.sol` instead takes the note's plaintext opening fields (`ownerPkX`, `blinding`) and **computes the commitment itself** from the actual net deposit — the same fix Railgun's real shield() function uses. Also dropped `ppoiProof` from `shield()`'s parameters: Backend §4's Flows section (not just the §2.1 interface table) makes clear PPOI clearing happens asynchronously, submitted separately by `ppoi-node` via `ScreeningGate.ppoiVerify` — not synchronously inside `shield()`.
8. `ppoi_dev`/`solvency_dev` circuit instantiations (M2) use smaller parameters than spec (SMT depth 32 not 160; chunk size 4 not 4096) — see `circuits/build/ceremony.md` for why (ceremony time at production scale). `ppoi_main.circom`/full-scale solvency remain the documented production targets; scaling up is a ceremony-infrastructure task for later, not a circuit-logic change.
9. **[CRITICAL, found in M4]** PPOI provider lists must store **hashed** addresses, not raw ones — `ppoi.circom`'s SMT check is against `smt[k].key <== addrHasher.out` (i.e. `Poseidon(originAddr)`), never `originAddr` directly. This is what "blinded" PPOI actually means: the published list never contains plaintext addresses. Building/checking the SMT with raw addresses instead produces a witness that only *accidentally* verifies — whether it does depends on unrelated bit-alignment luck between the raw address and its hash (confirmed empirically: worked for two small test addresses, failed consistently for a real 160-bit Ethereum address, worked again for an unrelated 150-bit value — a ~50%-per-provider coincidence, not a real proof). Caught while building the M4 ppoi-node e2e test; root-caused and reproduced independently of Bun/Node/anvil via `circuits/scripts/debug-smt.cjs`. Fixed in `prove-ppoi.cjs`, `prove-ppoi-gate-fixture.cjs`, and the ppoi-node e2e test — all provider trees now hash entries before insertion, all non-membership searches use the hashed origin. Backend §4.2's "newline-delimited lowercase addresses" list format is unaffected (that's the human-readable/transparency format); ppoi-node hashes each address before inserting it into the SMT it builds from that list.
10. **[CRITICAL, found while building M5]** `unshieldToOrigin` and `transact()` tracked spent notes in two disjoint namespaces: `nullifierUsed[commit]` for the origin escape hatch vs. `nullifierUsed[Poseidon(ownerSk, leafIndex)]` for join-split. A note spent via one path could still be spent again via the other — a genuine double-spend / insolvency bug, not a privacy nit, exploitable by any user against the pool's own balance. Not caught by the existing test suite, which only tested same-path replay. Fixed by adding a small dedicated circuit (`circuits/unshield.circom`, ~4.2k constraints — no Merkle tree, no arity, just two constraints: `BabyPbk(ownerSk).Ax == ownerPkX` and `Poseidon(ownerSk, leafIndex) == nullifier`) that lets `unshieldToOrigin` derive and mark the *same* nullifier a join-split spend of that note would use, unifying both paths under one `nullifierUsed` set. `leafIndex` is a **public** signal supplied by the contract from its own `leafIndexOf[commit]` record (set once, at shield time) rather than taken from the caller — a private/caller-chosen `leafIndex` would let a user mint unlimited fresh-looking nullifiers for the same note and reopen the exact same hole. `ownerSk` itself is never revealed on-chain (this project's key model is one long-term spending key per wallet, shared across every note it owns — see §1 — so leaking it anywhere would compromise the whole wallet, not just one note). See `CurtainPool.sol`'s header and `contracts/test/pool/CurtainPool.t.sol`'s `test_unshieldToOrigin_revertsIfNullifierAlreadyUsedByTransact` / `test_transact_revertsIfNullifierAlreadyUsedByUnshieldToOrigin` regression tests.
11. **[found in M5]** `CurtainPool.sol` never emits an event recording a `transact()` output's `clearedTree` leaf index (only `markCleared()`'s `MarkedCleared` event does). A wallet that receives a note via `send()` can see its balance but currently can't reconstruct a `clearedTree` membership proof to spend that note onward as a join-split input — only notes that went through `shield()` + `markCleared()` can be re-spent by `@curtain/sdk`'s `CurtainWallet.send()` today. Either a new event on `_transact()`'s output loop, or a separate way to query a commitment's `clearedTree` position, is needed before consolidation/multi-hop spends are possible. See `packages/sdk/src/pool-client.ts`'s header and `buildTrees()` comment.
12. **[found in M5]** `uiMultiplier()` (Curtain_Build.md §5's "balance display: raw × uiMultiplier() for 8056 tokens") is stubbed to a constant `1n` in `@curtain/sdk/src/pool-client.ts` — the real `multiplier-view` service (§4.5) that would compute a live split-adjustment multiplier per token doesn't exist yet as more than a scaffold. Fine for M5 (no 8056 tokens are registered in its demo/test), but must be wired for real before any UI displays 8056-wrapped stock token balances.
13. **[found in M5]** Mnemonic (BIP-39) import/export for the wallet's spending-key seed is deferred — `@curtain/sdk/src/keys.ts`'s `generateSeed()` only produces a fresh random 32-byte seed, with no human-readable backup/recovery phrase yet. Needed before any real wallet UI ships, since "write down your recovery phrase" is table stakes; tracked here rather than silently assumed.
14. **[bug, found and fixed in M5]** `deriveWalletKeys()` originally reduced the spending key `sk` modulo the full BN254 scalar field (~2^254) before using it as a Baby Jubjub scalar-mult scalar. circomlib's `BabyPbk` template range-checks that scalar with `Num2Bits(253)`, so any `sk` landing in [2^253, 2^254) — roughly half of all randomly generated seeds — made `joinsplit.circom`'s witness generation fail with an assertion error. Purely intermittent (passed or failed depending on the random seed), which is what made it easy to miss in a single manual run. Fixed by reducing `sk` (and `vk`, used the same way to derive `ek`) modulo Baby Jubjub's own subgroup order instead (~2^251, safely under the 253-bit bound). Regression-tested in `packages/sdk/test/keys.test.ts` by generating 20 wallets and asserting both scalars stay under the subgroup order every time.
15. **[bug, found and fixed in M5]** `CurtainWallet.send()` originally hardcoded the join-split circuit's `extDataHash` public input to `0`, but `CurtainPool._transact()` independently computes `extDataHash = keccak256(abi.encode(unshieldTo, unshieldAmount, feeAmount)) % FIELD_SIZE` and feeds *that* value into the same public-signal slot when verifying. Since keccak256 of a zero address/zero amounts is a large nonzero value, every proof failed on-chain with `InvalidProof()` even though the exact same proof passed an isolated `snarkjs.groth16.verify()` check — the mismatch only shows up against the contract's own recomputed binding, not in isolation. Fixed by computing `extDataHash` in the SDK the same way the contract does before building the circuit witness. A related gap this exposed: none of `CurtainWallet`'s write methods checked `receipt.status`, so this failure was initially silent (the call "succeeded" from `waitForTransactionReceipt`'s perspective even though the underlying transaction reverted) — every write method now throws if `receipt.status !== "success"`.
