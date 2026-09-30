# Curtain ($CRTN)

Privacy system for Robinhood Chain (chain id `4663`). Shield USDG and
tokenized Stock Tokens, trade/lend/earn from behind the shield, prove
funds are clean without revealing your book.

Full spec lives in the root `docs/` (Overview, Backend, Implementation Build).
This repo follows the milestone sequence M0–M12 defined in the
Implementation Build doc — one milestone per PR, each with green tests.

## Stack

- **Contracts:** Foundry (Solidity 0.8.26)
- **Circuits:** circom 2.x + snarkjs (Groth16, BN254)
- **Backend:** Bun + Node/Express (TypeScript)
- **Data:** Postgres + Redis, hosted on Railway (no Supabase, no Timescale —
  time-series tables use plain partitioned Postgres instead)
- **Deploy target:** Railway (all services except GPU/TEE-based mobile
  proving, which lands in M8 and needs separate infra)

## Repo layout

```
contracts/    Foundry project — pool, gate, adapt, stealth, staking, etc.
circuits/     circom circuits — joinsplit, ppoi, solvency
packages/     sdk, recipes, verifier — shared TypeScript libraries
services/     broadcaster, ppoi-node, prover-assist, multiplier-view,
              solvency, indexer, api, status — independently deployable
apps/web/     wallet web app
infra/        deploy manifests, local dev config
docs/         project specs (Overview, Backend, Implementation Build)
```

## Local development

```bash
# 1. Start local Postgres + Redis (mirrors what Railway will host)
docker compose up -d

# 2. Install dependencies
bun install

# 3. Copy env template and fill in values
cp .env.example .env

# 4. Run tests
bun run test:unit        # TypeScript unit tests
bun test                 # everything, incl. e2e (needs anvil, node, and circuit keys)
cd contracts && forge test   # contracts

# Local chain with the full stack (Deploy.s.sol needs a high block gas limit on anvil)
anvil --gas-limit 1000000000
cd contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow
forge script script/Pin.s.sol --rpc-url http://127.0.0.1:8545
```

## Milestone status

Code status after the September 2026 spec cross-check (see the root README and git history
for the fixes). "Built" means implemented and tested locally; nothing is deployed to 4663.

| # | Milestone | Status |
|---|---|---|
| M0 | Repo + toolchain + CI | Built |
| M1 | Stealth v0 | Built |
| M2 | Circuits | Built, **dev-scale**: single-contributor ceremony, PPOI SMT depth 32 (spec 160), solvency chunk 4 (spec 4096) |
| M3 | Pool | Built; fee now enforced on unshield, broadcaster paid from the proof, guardian shield pause |
| M4 | Gate + PPOI | Built; stale/removed providers excluded, previous-root window; `ppoi-node` service (lists, roots, auto-flagging, witnesses, opt-in proving) |
| M5 | Wallet SDK + web | Built |
| M6 | RelayAdapt + recipes v1 | Built; relay calls/outputs/origin now bound into the proof (front-running theft fixed) |
| M7 | Broadcasters | Built; broadcasters now verify the proof pays them |
| M8 | prover-assist | Protocol built; attestation is a **mock**, needs real TDX hardware |
| M9 | Morpho / Arcus / Prism recipes | Built against mocks |
| M10 | Disclosure + Solvency | Built |
| M11 | Staking + fees | Built; vote locking, 4% quorum, 24h timelock with multisig veto, fee vote now reaches the pool |
| M12 | Mainnet | **Not done**: needs the real multi-party ceremony, production circuit parameters, real TDX, token/verifier addresses, then `Deploy.s.sol` + `Pin.s.sol` on 4663 |

## Copy rules

Blocked: "mixer," "untraceable," "anonymous," "hide," "APY."
Permitted: "private," "provably clean," "selectively disclosable,"
"vault NAV accrues."
