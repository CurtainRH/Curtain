# CURTAIN ($CRTN) — Backend Build

**Chain:** Robinhood Chain 4663. **Stack (source spec):** Foundry · Bun/Hono/tRPC v11 · Drizzle · Postgres + Timescale · Redis + BullMQ · studio ZK core (compiled circuits, GPU prover) · Waku-style broadcaster relay.

> **This repo's actual stack** deviates slightly from the spec above: Node/Express (TypeScript) instead of Hono/tRPC, and plain partitioned Postgres (hosted on Railway) instead of Supabase/Timescale. See the root [README](../README.md) for rationale. Redis/BullMQ, Foundry, and the ZK toolchain are unchanged.

**Principles:** immutable note logic (no upgradeable pool); unshield-to-origin always works and only to origin; PPOI standby 15 min; multiplier-aware notes; broadcasters permissionless + bonded; view keys; no APY language for yield-in-shield ("vault NAV accrues").

## 0. Verified facts

| Fact | Used for |
|---|---|
| RH Stock Tokens: non-rebasing 18-dec ERC-20 + ERC-8056 `uiMultiplier()` | Raw-unit notes; display multiplier |
| Railgun: 0.25/0.25 fees, RelayAdapt, broadcasters, PPOI 1h standby, cookbook format, bug #140 (unshield-to-origin routed to broadcaster) | Port + fixes |
| Privacy Pools: ASP root on-chain, ragequit | Compliance model |
| ERC-5564/6538 finalized | Stealth v0 |
| Nothing privacy-related live on RHC | 1/1 claim |

## 1. Architecture

```
contracts
├─ StealthRegistry (ERC-6538) + StealthAnnouncer (ERC-5564) — v0
├─ CurtainPool         (existing XPrivacyPool: commitments tree, nullifiers, join-split verifier)
├─ ScreeningGate       (existing; extended: multi-provider list roots, PPOI verifier, 15-min standby)
├─ RelayAdapt          (unshield → arbitrary calls → reshield, atomic)
├─ BroadcasterBond     (bond $CRTN, fee schedule, slashing)
├─ DisclosureRegistry  (existing; view keys per account/note)
├─ SolvencyVerifier    (existing; epoch proofs)
└─ CrtnStaking         (fees → governors)

services
├─ broadcaster(s)   (accept encrypted tx bundles, pay gas, submit; publish fees)
├─ ppoi-node        (fetch provider lists, build blinded non-membership proofs, gossip proofs)
├─ prover-assist    (GPU proving with blinded witnesses for mobile)
├─ recipes SDK      (Step → Recipe → Combo; Uniswap, Morpho, Arcus, Prism DEX)
├─ multiplier-view  (uiMultiplier per token for wallet display)
├─ solvency, indexer, api
```

## 2. Contracts

### 2.1 `CurtainPool.sol` (existing pool, deployed immutable)

- Note: `commit(token, rawAmount, ownerPk, blinding)`; ERC-8056 tokens stored as **raw units** (`balanceOf` units); UI value = raw × `uiMultiplier()`.
- `shield(token, rawAmount, noteCommit, ppoiProof)`: transfers tokens in; fee 0.20% to Treasury; records `shieldedAt`; note enters standby (see 2.2).
- `transact(proof, nullifiers[], newCommits[], unshieldTo?, unshieldAmount?)`: join-split; unshield fee 0.20%.
- **Unshield-to-origin:** `unshieldToOrigin(noteCommit, proof)` — allowed at any time (including standby, including PPOI-failed); destination is **the EOA recorded at shield** (`originOf[noteCommit]`), never a parameter. Closes Railgun #140 by construction.
- No upgrade path. Migration = new pool + user-initiated move.

### 2.2 `ScreeningGate.sol` (extended)

```solidity
struct Provider { bytes32 listRoot; uint64 updatedAt; address publisher; bool active; }
mapping(uint8 => Provider) providers; // ≥ 3 providers; roots updated by publisher
uint64 public standby = 15 minutes;
function ppoiVerify(bytes calldata proof, bytes32 noteCommit) external; // blinded non-membership
// transact() requires: cleared[note] || block.timestamp > shieldedAt + standby && !flagged[note]
// flagged[note] set only by a provider proof of membership (positive hit) submitted within standby
```

- Deposit-side ASP (Privacy Pools model) + Railgun-style blinded PPOI; **both**.
- Provider outage: if no root update in 24h, that provider is `stale` and excluded; standby extends to 60 min while < 2 providers fresh. Public status page.

### 2.3 `RelayAdapt.sol`

```solidity
struct Call { address to; uint256 value; bytes data; }
function relay(bytes calldata unshieldProof, address[] calldata tokensOut, Call[] calldata calls, ...) external;
 // 1. pool unshields to this contract (fee applies)
 // 2. execute calls (Uniswap swap / Morpho deposit / Arcus open ...) with allowances scoped exactly
 // 3. for each tokensOut: balance → pool.shield(reshieldCommits[i]) with require(balance ≥ minOut)
 // 4. revert everything if any step fails (atomic)
```

- Reshield in the same tx **skips PPOI standby** (funds never left the system's custody boundary; provenance is the original cleared note). Shield fee on reshield waived; unshield fee applies once.
- Allowed call targets whitelisted by timelock (Uniswap routers/PoolManager, Morpho vault, Arcus, Prism DEX router); arbitrary targets later via governance.

### 2.4 `BroadcasterBond.sol`

Bond ≥ 25,000 $CRTN; publish `feeBps` (max 30) and `gasMarkupBps`; any bonded broadcaster may submit any bundle. Slash on provable censorship (failing to submit a validly paid bundle within 10 min when it was assigned via relay — attestation by 3 other broadcasters) or on malformed submission that burns user fees.

### 2.5 `StealthRegistry` / `StealthAnnouncer` (ERC-6538 / 5564) — v0

Users register a meta-address; senders derive one-time addresses; announcer emits ephemeral pubkey + view tag. Wallet scans announcements with viewing key. Works for USDG and Stock Tokens today; later, stealth addresses double as shield-deposit mailboxes.

### 2.6 `DisclosureRegistry.sol`, `SolvencyVerifier.sol` — existing

View keys: per account (all notes) or per note; revocable forward-only. Solvency: hourly pool balances ≥ Σ live notes per token.

### 2.7 `CrtnStaking.sol`

60% of shield/unshield fees → stakers ("governors"); governors vote on: provider add/remove, RelayAdapt targets, fee within [0.10%, 0.30%]. **Cannot** touch pool logic.

### 2.8 Deploy / OPSEC

Fresh deployer; pool immutable; gate/adapt behind 2-of-3 multisig + 24h timelock; guardian pause = `shield` and `relay` only, **never** `transact`/`unshieldToOrigin`. Nothing shared with other studio brands.

## 3. Services

| Service | Does |
|---|---|
| `broadcaster` | Waku-style relay listener; validates bundle + fee; submits; publishes fee schedule + uptime; ≥ 3 studio-run at launch, permissionless after |
| `ppoi-node` | Pulls provider lists (sanctions oracle, scam lists, protocol ASP), builds blinded non-membership proofs per shield within ~2 min, gossips; anyone can run one |
| `prover-assist` | Mobile flow: client sends blinded witness (commitment openings encrypted to a one-time key; server never learns amounts/owners) → GPU prover returns proof in < 10s; desktop proves locally |
| `recipes` (SDK, TS) | Railgun cookbook format: `Step {inputs, spentTokens, outputTokens, fees} → Recipe → Combo`. Day-one: `UniswapV3Swap`, `UniswapV4Swap`, `MorphoDeposit/Withdraw`, `ArcusOpen/Close`, `PrismDexSwap`, `BuyAndShield` (swap-into-shield) |
| `multiplier-view` | Per-token `uiMultiplier()` + upcoming `newUIMultiplier/effectiveAt` for wallet display (raw note × multiplier) |
| `solvency` | Hourly proofs |
| `indexer`, `api` | Public aggregates only (TVL per token, tx counts, broadcaster stats, provider freshness) |

### 3.1 Tables

```
tokens        (addr pk, symbol, is8056 bool, multiplier numeric, next_mult numeric, next_at)
commitments   (leaf_index pk, commit, block, shielded_at, standby_until, cleared bool, flagged bool)
providers     (id pk, name, root, updated_at, stale bool)
broadcasters  (addr pk, bond, fee_bps, gas_markup_bps, submitted int, failed int, uptime_30d)
recipes       (id pk, name, version, targets text[], audited bool)
solvency      (epoch, ts, token, pool_balance, live_notes, tx)
-- No table maps a note to an address, amount, or another note.
```

### 3.2 tRPC / SDK (source spec — this repo exposes these as REST via Express instead)

```
stealth.register(metaAddress) / stealth.scan(viewingKey)
shield.build(token, rawAmount) → {tx, noteCommit, standbyUntil}
ppoi.status(noteCommit) → cleared|standby|flagged
transact.build(...) / unshieldToOrigin.build(noteCommit)
relay.build(recipe, params) → bundle → broadcaster.submit(bundle)
recipes.list / recipes.simulate
disclosure.grant(scope, viewerPk) / disclosure.revoke
solvency.latest / broadcasters.list / providers.status
```

## 4. Flows

**Stealth send (v0):** sender resolves recipient meta-address → one-time address → transfer USDG/NVDA → announcement. Recipient scans, sweeps or leaves.

**Shield:** approve → shield (0.20%) → ppoi-node proves within ~2 min → cleared (or standby expiry at 15 min) → note spendable.

**Buy-and-shield:** USDG note → RelayAdapt [Uniswap swap → NVDA] → reshield NVDA note. One tx, one fee.

**Yield-in-shield:** USDG note → RelayAdapt [Morpho deposit] → vault-share note; NAV accrues; withdraw via RelayAdapt [Morpho withdraw] → USDG note.

**Ex-div:** nothing moves; multiplier-view updates display. Splits: same.

**Flagged:** provider proves a hit within standby → note can only `unshieldToOrigin`. User keeps funds; system stays clean.

**Disclosure:** grant view key to an auditor → they read notes; nothing else changes.

## 5. Tests & acceptance

| Test | Pass |
|---|---|
| Unshield-to-origin | Destination always `originOf[note]`; parameterized destination impossible (no such function) |
| Standby | `transact` reverts before `min(cleared, 15 min)`; `unshieldToOrigin` works during standby |
| Flagged note | Only origin exit; `transact` reverts forever |
| Provider stale | Excluded from PPOI root set; standby extends to 60 min when < 2 fresh |
| RelayAdapt atomicity | Any failing call reverts unshield; no residue outside pool |
| Reshield | Same-tx reshield skips standby; shield fee waived; unshield fee charged once |
| ERC-8056 notes | Raw units invariant across multiplier change; UI value updates |
| Broadcaster slash | Provable non-submission → slash; malformed bundle → slash |
| Mobile proving | Server never receives amounts/owners (blinded witness test); proof < 10s p95 |
| Solvency | Hourly proof verifies per token; injected deficit fails |
| Immutability | Pool has no admin/upgrade selectors (bytecode test) |

## 6. Build order (narrative — see Implementation Build's M0–M12 table for the authoritative, per-session breakdown)

1. `StealthRegistry`/`Announcer` + wallet scan (v0 live in days)
2. `CurtainPool` deploy (existing core) + `ScreeningGate` multi-provider + 15-min standby + origin-only exit
3. `ppoi-node` + ≥ 3 providers + status page
4. `RelayAdapt` + recipes: Uniswap swap, `BuyAndShield` → private stock buying live
5. Broadcaster network + bonding; `prover-assist`
6. Morpho recipe (yield-in-shield), Arcus, Prism DEX; `DisclosureRegistry` UX
7. `CrtnStaking`; Solvency page; SDK publish

## 7. Copy rules

Blocked: "mixer," "untraceable," "anonymous," "hide," "APY." Permitted: "private," "provably clean," "selectively disclosable," "vault NAV accrues."
