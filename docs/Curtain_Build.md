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
4. ~~"Ragequit" naming~~ — **resolved post-M12**: "ragequit" in Overview/Backend is confirmed to be narrative/positioning shorthand for `unshieldToOrigin`'s unconditional-exit guarantee, not a separate function. There is no distinct on-chain "ragequit" path, and none is needed: `unshieldToOrigin` already works unconditionally regardless of screening state (standby, flagged, degraded providers, or fully cleared — see `contracts/test/launch/LaunchGates.t.sol`'s four `test_Gate2_ExitSafety_*` tests, added post-M12 specifically to prove this). No terminology change was made in the contracts (there was never a competing name to unify against); this item is closed as "already correct, just under-documented."
5. **[resolved in M11]** $CRTN total supply is 100,000,000 CRTN (100M tokens, 18 decimals). The 80 / 10 / 5 / 5 bucket split is explicitly assigned as: 80% (80M) Community & Shield Staking Rewards, 10% (10M) Core Contributors/Team, 5% (5M) Early Backers & Advisory, 5% (5M) Broadcaster Subsidies & Protocol Reserve.
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
16. **[design decision, M6]** `RelayAdapt`'s spec pseudocode passes a pre-built `reshieldCommits[i]` into `pool.reshield()`. As with `shield()` (item 7), accepting an opaque commitment without verifying its structure would let a relay claim a reshielded note worth more than the swap actually produced — a solvency-draining bug. `CurtainPool.reshield()` instead takes the plaintext opening (`ownerPkX`, `blinding`) and computes the commitment itself from the *real* post-swap token balance, exactly like `shield()`. `RelayAdapt.relay()`'s signature also omits spec's `broadcaster`/`broadcasterFee`/`feeToken` params for M6 — paying a broadcaster fee only means something once bonded broadcasters exist to receive it (§4.1, M7); the caller pays their own gas directly for now, and extending the signature once M7 lands is additive, not a redesign.
17. **[design decision, M6]** Gating `CurtainPool.reshield()` to RelayAdapt only, without breaking CurtainPool's tested zero-admin-function invariant, needed `relayAdapt` to be an immutable address known at CurtainPool's own construction — but RelayAdapt's constructor also needs CurtainPool's address, a genuine two-way dependency. Resolved with no setter at all: the deployer predicts RelayAdapt's future address before deploying either contract (`vm.computeCreateAddress`, using the deployer's next-but-one nonce), bakes that prediction into CurtainPool's constructor, then deploys RelayAdapt immediately after so it lands exactly there. See `CurtainPool.sol`'s header and `test/adapt/RelayAdapt.t.sol`'s `setUp()`. A real `Deploy.s.sol` doing the equivalent for every contract, end to end, is still an M12 launch-runbook item — no such script exists yet.
18. **[deferred, M6]** `RelayAdapt`'s day-one Uniswap V3/V4 integration uses `contracts/test/mocks/MockDexRouter.sol` (a fixed-rate `swapExactIn`) instead of the real Uniswap contracts, since testing against real Uniswap V3/V4 needs a mainnet-fork RPC endpoint (`anvil --fork-url ...`) this environment doesn't have. `packages/recipes/src/dex.ts`'s `swapExactInStep` is written so swapping in real Uniswap calldata encoding later is an isolated change, not a redesign. `MorphoDeposit`/`MorphoWithdraw`/`ArcusOpen`/`ArcusClose`/`PrismDexSwap` (§4.4's other day-one recipes) are M9 work per the milestone table and aren't implemented yet.
19. **[deferred, M6]** `packages/recipes`'s `buildRelay()` produces the `calls`/`targets`/`outputs` a `RelayAdapt.relay()` call needs, but stops short of building the actual `ReshieldOutput[]` entries (which need `ownerPkX`/`blinding`/`ephemeralPk`/`ct` — note cryptography, not step composition). Wiring `CurtainWallet` (the SDK) to call `RelayAdapt.relay()` end to end — pairing a recipe's declared outputs with fresh encrypted notes — hasn't been built yet; M6's on-chain acceptance ("buy NVDA into shield in one tx") is proven directly against the contract in `test/adapt/RelayAdapt.t.sol` instead.
20. **[design decision, M7]** `BroadcasterBond`'s constructor takes any ERC-20 as the bondable token rather than hardcoding CRTN, since CRTN itself doesn't exist until M11 (`CrtnStaking`). Whatever token M11 deploys plugs in unchanged. Separately, spec's `slash(address b, uint256 amount, bytes32 evidenceRoot, bytes[] calldata attestorSigs)` doesn't define what an "attestor" is or how evidence is validated — implemented as an owner-managed attestor set requiring a threshold of EIP-712 signatures (ECDSA or ERC-1271, same pattern `StealthRegistry.registerKeysOnBehalf` already uses) over `(broadcaster, amount, evidenceRoot)`, with `evidenceRoot` itself never interpreted on-chain — it's attestors' job to verify the underlying censorship evidence off-chain before signing, and it's marked used once slashed so it can't be replayed into a second slash.
21. **[gap, M7]** The spec's assignment/censorship mechanism has a real, unresolved incentive-design question this milestone doesn't solve: a bundle's fee is bound into its proof for a SPECIFIC (originally-assigned) broadcaster's address (per §4.1, "an output note to the broadcaster's pk or unshield to its address"). A non-assignee who submits a censored bundle after the 10-minute window pays gas but the fee still goes to the negligent original assignee's address, not to them — there's no reward carved out of the slash for whoever exposed the censorship either (100% goes to `slashTreasury`). Mechanically, `services/broadcaster`'s fallback submission and `BroadcasterBond.slash()` both work exactly as spec'd; this item flags that nothing currently makes a rational non-assignee want to actually do the fallback submission, which is a protocol/tokenomics design gap, not an implementation bug.
22. **[deferred, M7]** The libp2p gossipsub mesh (`curtain/bundles/v1`) is not implemented — `services/broadcaster` only has the HTTPS fallback (`POST /bundle`, `GET /fees.json`, `GET /health`), which is what M7's tests actually exercise. Real P2P networking needs multiple physical/containerized nodes to test meaningfully, out of scope for this environment (same category of deferral as M6's mainnet-fork RPC gap). `shieldMeta` bundles are accepted but `submitBundle` refuses to execute them, since no meta-tx forwarder contract exists yet. Gathering attestor signatures for a real `slash()` call (i.e. the governance process by which attestors decide censorship evidence is valid) is also not implemented — `BroadcasterNode.detectCensorship()` only detects the precondition; filing the evidence and collecting signatures is assumed to happen via an external process.
23. **[bug, found and fixed in M7]** Submitting a transaction that depends on a prior transaction's state (e.g. `bond()` right after `approve()`, from the same account) without first awaiting the prior transaction's receipt doesn't cleanly revert on anvil — it leaves the dependent transaction stuck pending indefinitely, with no error and no timeout, even when an explicit `waitForTransactionReceipt` timeout is passed. Cost significant debugging time in `services/broadcaster/test/broadcaster.e2e.test.ts` because the hang point varied between runs depending on exactly how much unrelated setup preceded it. Fixed by awaiting every dependent transaction's receipt before submitting the next one in the same chain (mint -> approve -> bond). Worth remembering for any future service code that chains transactions from the same account: never assume "submitted" means "state visible to the next call."
24. **[design decision, M8]** Curtain_Build.md §4.3 calls for running `prover-assist` inside a real Intel TDX confidential-computing enclave with hardware attestation, which needs actual TDX-capable hardware (e.g. an Azure DCasv5 confidential VM) neither this dev environment nor CI has — the same category of hardware/infra gap as M6's mainnet-fork RPC and M7's libp2p mesh. Built a structurally faithful MOCK attestation instead (`services/prover-assist/src/attestation.ts`): a fixed, hardcoded keypair plays the part of Intel's root of trust, and a fixed hash stands in for a hardware-measured MRENCLAVE. The client/server protocol (fetch attestation, verify before sending, ECIES-encrypt the witness to the enclave's one-time key, decrypt-prove-discard) is real and tested; only the root-of-trust itself is fake. Whoever holds the mock root private key can forge attestations — that property is exactly what real hardware attestation exists to remove, and is called out loudly in the code so this is never mistaken for production-ready. `@curtain/sdk`'s `CurtainWallet` isn't wired to call prover-assist yet (desktop still always proves locally per spec); that integration is deferred until real hardware makes prover-assist worth using for something other than protocol testing.
25. **[bug, found and fixed in M8]** `snarkjs.groth16.verify()` hangs indefinitely under Bun's runtime with no error — the same root cause already documented for `snarkjs.groth16.fullProve()` (both use ffjavascript's WASM-backed curve/pairing arithmetic, which is incompatible with Bun's WASM runtime in a way that leaves the promise pending forever rather than throwing). This had gone unnoticed until M8 because every earlier milestone only ever verified proofs via the real on-chain Solidity verifier (never called `snarkjs.groth16.verify` directly from a Bun process) — M8's test is the first one that needed to verify a proof without a deployed contract in the loop. Fixed the same way proving already was: run verification in a plain Node subprocess (`services/prover-assist/test/verify-subprocess.cjs`), never inline under Bun. Worth remembering for any future test that calls `snarkjs.groth16.verify` directly: it needs the same subprocess treatment `fullProve` already gets, not just proving.
26. **[bug, found and fixed in M8]** `@noble/curves`'s `bytesToHex`/`hexToBytes` work on bare hex with no `"0x"` prefix, unlike every other hex convention already used across this codebase (viem, this project's own manual `` `0x${...}` `` constructions). Writing `bytesToHex(x) as Hex` and later `.slice(2)`-ing the result to "strip the 0x" silently chopped off the first real byte of every key, signature, and ciphertext in `services/prover-assist` — producing signatures that were spuriously 63 bytes instead of 64 (looked like a rare RFC6979 edge case, wasn't) and a corrupted enclave public key that broke ECDH entirely. A type assertion (`as Hex`) let this compile cleanly with no warning. Fixed with two explicit helpers (`toHex`/`fromHex` in `attestation.ts`) that every conversion in the package now goes through, instead of the raw noble functions. Worth remembering: `as` type assertions on a string's *shape* don't make the runtime value match that shape — a lesson equally applicable anywhere else in this codebase that reaches for `as Hex` around a non-viem hex source.
27. **[false alarm, M7/M8 — recorded so it isn't re-chased]** `services/broadcaster`'s e2e test started intermittently timing out at exactly 60,000ms with no error, looking exactly like the M7 item 23 hang. Instrumenting every step showed it was never stuck — the test genuinely runs ~20 sequential on-chain transactions (bonding 3 broadcasters, minting, submitting, setting attestors, slashing) and normally takes ~45-50s, uncomfortably close to a 60s bound; ordinary system load variance was enough to tip it over. Fixed by raising the test's own timeout to 120s — no code change needed. Distinguishing this from a real hang took re-instrumenting the same way item 23 was diagnosed and confirming every step DID complete, just slowly; worth checking "did it finish slowly" before assuming "did it hang" when a test times out at exactly its configured bound.
28. **[design decision & deferred, M9]** Real Morpho, Arcus, and Prism DEX contracts are not available in local devnet/anvil without a mainnet-fork RPC. Built structurally faithful mock contracts (`MockMorphoVault.sol` for ERC-4626 MetaMorpho vault, `MockArcusRouter.sol` for perps open/close, `MockPrismRouter.sol` for DEX swaps) in `contracts/test/mocks/`, matching the established M6 `MockDexRouter.sol` pattern. Tested atomic unshield -> Morpho deposit/withdraw -> reshield with yield accrual via `RelayAdaptM9Test.sol` (80 Foundry tests passing).
29. **[compliance constraint, M9]** Yield-in-shield (Morpho Vault deposit/withdraw) implements exact Net Asset Value (NAV) calculation (`calculateMorphoNAV(shares, rateWad)`) in `@curtain/recipes`, explicitly avoiding misleading fixed APY marketing strings per Curtain spec §4.4 & Backend §0 rules.
30. **[design decision, M10]** Disclosure key grants (`DisclosureRegistry.sol`, `@curtain/sdk`'s `createDisclosureGrant`/`decryptGrantedViewingKey`) use Baby Jubjub ECDH + ChaCha20-Poly1305 encryption of viewing keys bound to scope hashes and optional expiration timestamps (`until`). The private key for a wallet's note-encryption key `(ekX, ekY)` is its viewing key `vk` (`vk = Poseidon(sk, 1)`), enabling auditors to decrypt scoped viewing keys and notes without revealing the owner's spending key `sk`. Solvency verification (`SolvencyVerifier.sol`, `@curtain/verifier`, `services/solvency`) enforces chunked proof aggregation and verifies sum(live unspent notes) <= balanceOf(pool) on-chain per epoch. `services/status` aggregates provider freshness, standby state (15/60 min), solvency, and broadcaster metrics.
31. **[design decision, M11]** `$CRTN` ERC-20 token (`contracts/src/token/CRTN.sol`) implements 100M total supply with 80/10/5/5 minting to designated buckets. `CrtnStaking.sol` handles $CRTN staking for governor shares, routes shield/unshield fees (60% to stakers, 40% to treasury), and enables governor parameter voting (`SetFeeBps` [10, 30] bps, `AddProvider`/`RemoveProvider` on `ScreeningGate`, `AddRelayTarget`/`RemoveRelayTarget` on `RelayAdapt`). Immutable note logic in `CurtainPool` remains untouched. `@curtain/sdk` exports fee split calculations and tokenomics helpers.
32. **[design decision, M12]** Completed deployment runbook (`contracts/script/Deploy.s.sol`), bytecode immutability pin script (`contracts/script/Pin.s.sol`), and launch gates test suite (`LaunchGates.t.sol` & `packages/sdk/test/launch-gates.test.ts`). Verified all §9 launch gates: immutability, exit safety across all states, provider freshness/standby bounds, chunked solvency, copy lint compliance, and `.env.example` template.
33. **[CRITICAL bug, found and fixed post-M12 audit]** `Deploy.s.sol` as pushed for M12 never transferred `ScreeningGate`/`RelayAdapt` ownership to `CrtnStaking` after deploying it — meaning every governor proposal executed via `CrtnStaking.executeProposal()` (`AddProvider`/`RemoveProvider`, `AddRelayTarget`/`RemoveRelayTarget`) would revert forever against a freshly-deployed protocol, since those `onlyOwner` contracts would still be owned by the deployer EOA, not the staking/governance contract that's supposed to control them. Also separately, the script did not compile at all: four bucket-address env-var defaults were full 40-hex-digit literals with invalid EIP-55 checksums (solc rejects these at compile time), and after fixing those, a "stack too deep" compiler error surfaced from ~35 simultaneously-live locals in one `run()` function — the M12 "all tests pass" claim was never actually re-verified against a clean build. Fixed by (a) switching to short non-40-digit placeholder literals matching this codebase's own established convention, (b) refactoring `run()` into a sequence of internal helpers that write deployed addresses to contract storage instead of returning them as locals (storage writes don't consume EVM stack slots, unlike `via_ir` this doesn't change codegen for every other contract), and (c) adding a `_transferGovernanceOwnership()` step, run last, that calls `gate.transferOwnership(address(staking))` / `adapt.transferOwnership(address(staking))` — after the one-time `gate.setPool()` bootstrap, which needs `deployer` to still be owner. Verified end-to-end on a live anvil deployment: `gate.owner()`/`adapt.owner()` both equal the deployed `CrtnStaking` address.
34. **[CRITICAL bug, found and fixed post-M12 audit]** Despite `CrtnStaking.sol`'s 60/40 shield/unshield fee split (item 31) being fully implemented and unit-tested in isolation, `Deploy.s.sol` passed a plain treasury EOA/placeholder as `CurtainPool`'s `treasury` constructor argument instead of `CrtnStaking`'s address — meaning the fee router was never actually reachable in a real deployment; 100% of every shield/unshield fee would go straight to a plain EOA forever, exactly as before M11 existed. `CurtainPool` is deliberately immutable and must never be modified to know about or call `CrtnStaking` (a plain ERC-20 `transfer` to a contract works identically to one to an EOA, so no `CurtainPool` code changes were needed at all). Fixed with a push+sync pattern: `Deploy.s.sol` now passes `address(staking)` as `CurtainPool`'s `treasury`, and a new permissionless `CrtnStaking.syncFees(token)` function (matching this project's established `CurtainPool.markCleared()` permissionless-keeper pattern) computes `balanceOf(this) - lastKnownBalance[token]` to detect and distribute newly-arrived fees via the existing `_distributeFees` split logic; `claimFees`/`_claimAllPending` were patched to decrement `lastKnownBalance` on payout so the balance-diffing invariant stays correct across claims. Verified end-to-end on a live anvil deployment: a real 100 USDG `shield()` call produced exactly the expected 0.2 USDG (0.20% fee) landing in `CrtnStaking`, and `syncFees()` correctly forwarded the full amount to the real treasury address (100%, since `totalStaked == 0` — no stakers yet, matching documented behavior).
35. **[CRITICAL bug, found and fixed post-M12 audit]** `SolvencyVerifier.finalizeEpoch()` never checked that all of an epoch's chunks had actually been submitted before summing `epochTotalSum` and declaring solvency — calling it after only a partial chunk set (e.g. 1 of 2) would understate `totalLiveNotes` and could report a genuinely insolvent pool as solvent. Fixed by having `submitChunk` take a `totalChunks` parameter, declared by whichever chunk is submitted first for an (epoch, token) pair and required to match on every later chunk (`TotalChunksMismatch` otherwise), with `chunkIdx` range-checked against it (`ChunkIndexOutOfRange`); `finalizeEpoch` now reverts with `EpochIncomplete(submitted, declared)` unless every declared chunk has actually landed, and with `NoChunksSubmitted` if called before any chunk exists for that epoch/token at all. `contracts/test/solvency/SolvencyVerifier.t.sol` gained 5 new regression tests for this (incomplete epoch, no chunks, mismatch, out-of-range, zero-total-chunks); all 3 existing call sites (`LaunchGates.t.sol`, and the pre-existing solvent/insolvent/invalid-proof tests) were updated for the new signature. No off-chain caller existed yet for `submitChunk` (services/solvency doesn't call it), so this was a pure contract-and-test-only fix.
36. **[bugs found and fixed post-M12 audit — theater tests]** `LaunchGates.t.sol`'s `test_Gate2_ExitSafety` docstring claimed to cover "every state" but only ever exercised one (still-in-standby); `packages/sdk/test/launch-gates.test.ts`'s "Gate 3: Privacy CI" test asserted nothing more than `typeof 123456789n === "bigint"`, and its "Gate 7: Copy lint" test only scanned `apps/` despite Curtain_Build.md §9 requiring `docs/` too. Fixed: Gate 2 is now four separate tests covering standby, flagged (using the same real Merkle-proof fixture `ScreeningGate.t.sol` already exercises), degraded-provider standby, and post-clearance state — all confirming `unshieldToOrigin` pays out identically regardless of screening state (there is no guardian-pause mechanism to test against; `CurtainPool` has zero admin/pause selectors by design per Gate 1, and Curtain_Build.md §7 step 9 scopes any future guardian pause to `shield`/`relay` only, never `unshieldToOrigin`, via an external contract that doesn't exist yet). The TS suite was rewritten with: a real Copy lint scan across both `apps/` and `docs/` (excluding the two internal spec files, `Curtain_Overview.md`/`Curtain_Backend.md`, that legitimately quote the blocked words to define the policy itself); a real Privacy CI check that `services/broadcaster|ppoi-node|prover-assist`'s source carries no persistent-storage driver, that every file owning a temp witness path also cleans it up, and that `Bundle`/`BroadcasterConfig` never declare a bare `owner`/`amount` field; and two real OPSEC checks (`.env.example` declares RPC/chain config with no live secrets committed, and `Deploy.s.sol`'s fallback private key is Anvil's published test key, never a real one). The temp-witness-cleanup check caught a genuine live instance of exactly the leak it's meant to prevent: `services/ppoi-node/test/clear-shield.e2e.test.ts` wrote real `rawAmount`/`ownerPkX`/`originAddr` values to `.tmp-ppoi-input.json`/`.tmp-ppoi-output.json` and never removed them (gitignored, so never at risk of being committed, but left sitting on disk indefinitely after every run) — fixed by `rmSync`-ing both files at the end of the test. Two gates remain honestly `it.todo` rather than faked: full Recipes coverage "from the web wallet with a broadcaster" (blocked on items 19 and 22 below — the wallet SDK isn't wired to `RelayAdapt.relay()` yet and the broadcaster has no bundle mesh) — though the gate's contract-layer half is now covered for real by a new `test_relay_buyAndShield_thenMorphoDeposit_endToEnd` in `RelayAdaptM9.t.sol`, the first test chaining a swap and a Morpho deposit atomically in one `relay()` call; and OPSEC's deployer/domain/hosting/design-system uniqueness, which has no config or deployment artifact anywhere in the repo yet to check against (`deployments/4663.json` doesn't exist until a real deploy happens).
37. ~~mnemonic import/export deferred~~ — **resolved post-M12**: `@curtain/sdk/src/keys.ts` gained `mnemonicFromSeed`/`seedFromMnemonic`/`generateWalletKeysWithMnemonic`/`recoverWalletKeysFromMnemonic`, using `@scure/bip39` for a direct, reversible 32-byte-seed<->24-word-mnemonic encoding (the seed IS the BIP-39 entropy; no PBKDF2 stretching or passphrase on top, since `deriveWalletKeys`'s own HKDF-SHA256 step already does that job — adding BIP-39's standard seed derivation too would just be a redundant second KDF pass with its own passphrase UX to design around). 7 new tests in `packages/sdk/test/keys.test.ts` cover round-tripping, exact key-recovery equality, whitespace/casing tolerance, and rejection of a bad checksum or an out-of-wordlist word.
38. ~~`uiMultiplier()` stubbed to a constant~~ — **resolved post-M12**: `services/multiplier-view` is now a real HTTP service (`Bun.serve`, matching `prover-assist`'s pattern) backed by `MultiplierStore`, a WAD-scaled (1e18 == 1.0x) per-token record with immediate (`setMultiplier`) and scheduled (`scheduleMultiplier`/`effectiveAt`) updates — matching Curtain_Build.md §3.1's `tokens(multiplier, next_mult, next_at)` schema and §4's "ex-div: nothing moves, multiplier-view updates display" flow (raw notes never change; scheduled multipliers only promote to current once `effectiveAt` passes). `@curtain/sdk/src/pool-client.ts`'s `uiMultiplier(tokenId)` (hardcoded to `1n`) was replaced with `fetchUiMultiplier(tokenAddress, serviceUrl)`, a real fetch against this service with a safe 1.0x fallback on any failure (never affects the underlying raw balance, only display). **Explicit boundary, not a mock**: there is no live corporate-actions data feed wired in, and can't be from this environment — a real stock split/ex-div event is an issuer announcement, not something derivable on-chain, so a production deployment needs `MultiplierStore`'s write path (`setMultiplier`/`scheduleMultiplier`) fed by a real paid market-data API or manual ops entry once one is chosen; the service itself (storage, scheduling, HTTP surface, auth) is real and fully tested (17 new tests across both packages).
39. ~~wallet SDK not wired to `RelayAdapt.relay()`~~ — **resolved post-M12**: `CurtainWallet.relay()` (`packages/sdk/src/pool-client.ts`) now builds and submits a real relay end to end. Key finding during implementation: `RelayAdapt.relay()`'s "unshield leg" is not a separate circuit — it's a full, ordinary `CurtainPool.transact()` join-split call (the exact same `joinsplit2x2` circuit/proving path `send()` already used), just with `unshieldTo` set to RelayAdapt's own address instead of zero. So `relay()` reuses `send()`'s exact proving pattern (`buildTrees`, nullifiers, Merkle paths, circuit-input assembly, `proveGroth16`) with `unshieldAmount`/`unshieldTo` populated, builds a real join-split output pair (real change note if any value isn't relayed through, else a valid zero-value dummy note — `joinsplit.circom`'s `outAmount` has no lower bound beyond its 128-bit range check, so an all-zero note is a perfectly valid conservation-satisfying output), pre-flight-checks every call target against `RelayAdapt.allowedTarget` before spending gas on a proof, builds real `ReshieldOutput[]` entries via the same `encryptNoteTo` helper `shield()`/`send()` already use, and submits `RelayAdapt.relay()` directly. No changes were needed in `@curtain/recipes` — its `buildRelay(recipe)` output (`calls`/`targets`/`outputs: TokenSpec[]`) was already correctly scoped to step composition, with note cryptography deliberately left to the wallet. New end-to-end test `packages/sdk/test/wallet-relay.e2e.test.ts`: shields USDG, relays the full amount through a real `MockDexRouter` swap into NVDA, and confirms the reshielded NVDA note is real and `sync()`-recoverable, with zero residue left in RelayAdapt — using the real on-chain `JoinSplit2x2Groth16Verifier`, not a mock. Remaining gap, not closed by this: `apps/web` doesn't call `relay()` yet (still an M0 stub — see item 40), and `services/broadcaster` still has no bundle mesh to route a relay bundle through (item 22) — both are separate, already-documented items.
40. ~~`shieldMeta`'s meta-tx forwarder doesn't exist~~ — **resolved post-M12**: `CurtainPool` now inherits OpenZeppelin's audited `ERC2771Context` (a new immutable `trustedForwarder` constructor param — zero admin/setter surface, `isTrustedForwarder` is a harmless view function, so Gate 1's immutability check is unaffected) and `Deploy.s.sol` deploys an unmodified `ERC2771Forwarder`. A real security finding surfaced while designing this: the obvious naive approach — a custom forwarder contract that holds the user's funds and calls `shield()` itself — would have bound `originOf[commit]` to the FORWARDER's own address (since `shield()` uses `msg.sender`), permanently misdirecting that note's `unshieldToOrigin` escape hatch away from the real depositor. This is exactly the bug class `RelayAdapt`'s reshield design and the M5 unshield-nullifier-unification fix (item 10) already closed elsewhere by construction — reintroducing it via a sloppy meta-tx layer would have been a real, fund-locking regression, not a rejected design nitpick. ERC-2771 avoids it structurally: only `shield()`'s two `msg.sender` uses became `_msgSender()` (token pull and `originOf` binding), which resolves to the true EIP-712 signer recovered from the forwarder's appended calldata suffix — a relayer that merely pays gas never touches the user's tokens or origin binding. `contracts/test/pool/CurtainPoolMetaTx.t.sol` (4 new tests) proves this directly: a relayer address submits the meta-tx and pays gas, yet `originOf` resolves to the real signer (not the relayer, not the forwarder), tokens are pulled from the signer alone, replayed requests revert, and direct (non-meta) `shield()` calls are unaffected. `services/broadcaster/src/node.ts`'s `submitBundle` no longer special-cases or rejects `shieldMeta` bundles — once the forwarder existed, submitting one is identical to any other bundle kind (just `to`/`calldata` pointed at the forwarder's `execute()`), so the `UnsupportedBundleKindError` guard was removed; `checkFee()` is skipped specifically for `shieldMeta` since — unlike `transact`/`relay`/`unshieldToOrigin` — its fee isn't bound into any proof's public signals (there's no proof at all), so gasless relaying here runs on the same out-of-band incentive `ERC2771Forwarder`'s own documentation describes (an app subsidizing a user's first shield as an acquisition cost), not a per-bundle fee schedule. New end-to-end test `services/broadcaster/test/shield-meta.e2e.test.ts`: a signer with zero ETH gets a real shield mined via a broadcaster paying gas on her behalf, with `originOf` and token movement both correctly bound to her, not the broadcaster. Every existing `new CurtainPool(...)` call site (7 test files, `Deploy.s.sol`, `apps/web/src/demo-wallet.ts`) was updated for the new trailing constructor argument (`address(0)` where meta-tx isn't exercised). Verified via forge test (115/115 passing, up from 111) and bun test (99/99 passing, 2 honest todo).
41. **[CRITICAL architectural finding, found and fixed post-M12]** `apps/web` was still an M0 scaffold (`ready(): boolean { return true; }`) despite the milestone table marking M5 "done", and building a real browser UI surfaced a genuine, previously-undiscovered blocker: `packages/sdk`'s ENTIRE proving pipeline (`send`, `relay`, `unshieldToOrigin` — everything except `shield`, which needs no proof) called `proveGroth16` directly and unconditionally, which spawns a Node.js `child_process` (`prove-subprocess.cjs`) to route around a Bun/snarkjs-WASM incompatibility (item 25). `node:child_process`/`node:fs` don't exist in a browser, and — worse than a clean failure — a real bundler (Vite/Rolldown) doesn't refuse to build when it hits a `node:*` import; it silently "externalizes" it with only a build-time warning, deferring the actual crash to whenever a real user's browser tries to load that code path. Fixed with a pluggable proving backend (`packages/sdk/src/prover-backend.ts`): `LocalNodeProverBackend` (desktop/CLI/tests, unchanged behavior, `./prover` loaded via a LAZY `import()` inside its own method so a browser bundle's static module graph never reaches it at all) and a new `ProverAssistBackend` — a genuine browser-safe client for the existing `services/prover-assist` server, reimplementing its ECIES-encrypt-to-enclave protocol (secp256k1 ECDH + HKDF + ChaCha20-Poly1305, ported from `crypto.ts`/`attestation.ts` using only `@noble/*` + `fetch`) so private circuit fields (`inOwnerSk`/`ownerSk` — a wallet's entire long-term spending key — most critically) never leave the device unencrypted, matching exactly the "client sends blinded witness, server never learns amounts/owners" model Backend §3 already specified for this service. `CurtainWallet.send`/`relay`/`unshieldToOrigin` now go through `this._prove(circuit, circuitInput)` instead of calling `proveGroth16` directly; a new `packages/sdk/test/prover-assist-backend.e2e.test.ts` proves the full path end-to-end (`unshieldToOrigin` via a real prover-assist server, real on-chain `UnshieldGroth16Verifier`) with zero Node-only calls reachable from the client side. On top of this, two more real browser-compat gaps surfaced only once an actual `vite build`/live browser session was attempted (a Foundry test suite alone can't catch these — they're specific to bundling and browser globals): (a) even with the pluggable backend, `@curtain/sdk/src/index.ts`'s barrel still statically re-exported `./prover` as a value, which pulled `node:child_process` back into the bundle's module graph regardless — fixed by re-exporting only `Groth16Proof`'s type (erased at compile time) and dropping the value export entirely; (b) `circomlibjs` (Poseidon/BabyJub, used throughout `keys.ts`/`notes.ts`) references Node's `Buffer` and `process` globals at module-evaluation time, not just inside functions — a same-module `globalThis.Buffer = ...` assignment runs too late regardless of where it's written, since ES modules fully evaluate every `import` declaration in a file before running that module's own top-level statements; fixed with a dedicated `apps/web/src/browser/browser-polyfills.ts` imported as the literal first import in `main.ts`, whose own trivial dependency-free assignment completes before any later import's subtree (including `@curtain/sdk` → `circomlibjs`) begins evaluating. `apps/web` now has a real Vite-based single-page app (`index.html`, `src/browser/`): wallet generation/import via BIP-39 mnemonic (item 37) with a password-encrypted local keystore (scrypt + ChaCha20-Poly1305 — a genuinely new, real addition, not previously specified anywhere; raw seed in plaintext localStorage was never an acceptable bar for anything holding real funds), injected-wallet (MetaMask-style) connection via viem, shield, note sync/balances, per-note `markCleared`/`unshieldToOrigin`, and a settings panel for pointing at any deployed pool/prover-assist/multiplier-view instance. Manually verified end-to-end in a real browser session (not just `vite build` succeeding): wallet generation, real Baby Jubjub key derivation, password-encrypted keystore save, and a lock/unlock cycle recovering the identical keys. Explicitly out of scope for this pass, flagged rather than silently skipped: `relay()`/recipe selection has no UI yet (the underlying SDK method is real and fully tested — see item 19 — wiring a "pick a recipe" UI is a separate follow-up), disclosure grants have no UI, balances don't show the ERC-8056 `uiMultiplier()`-adjusted display value yet (needs a tokenId->token-address registry this minimal UI doesn't have), and there is no automated browser/Playwright regression test for the UI itself — only manual verification in this session and the underlying SDK's own e2e test suite. Building `apps/web` also caught a real gap in the Copy lint gate's own real-ification (item 36): its directory scanner excluded `node_modules`/`.git`/`out`/`cache`/`lib` but not `dist` — a local `vite build` of `apps/web` left minified vendor code containing the word "anonymous" (an incidental string inside some bundled dependency, not this project's own copy) sitting in `apps/web/dist/`, which the scanner then correctly flagged since `dist/` was never excluded. Fixed by adding `dist` to the excluded-directory list; `dist/` was already gitignored, so nothing was ever at risk of shipping, but the gate itself would have false-failed on any local build artifact left lying around.


