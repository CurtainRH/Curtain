# Curtain ($CRTN)

Privacy system for Robinhood Chain (chain id `4663`). Shield USDG and
tokenized Stock Tokens, trade/lend/earn from behind the shield, prove
funds are clean without revealing your book.

Full spec lives in `docs/` (Overview, Backend, Implementation Build).
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
bun test                 # all TypeScript workspaces
cd contracts && forge test   # contracts
```

## Milestone status

| # | Milestone | Status |
|---|---|---|
| M0 | Repo + toolchain + CI | ✅ done |
| M1 | Stealth v0 | pending |
| M2 | Circuits | pending |
| M3 | Pool | pending |
| M4 | Gate + PPOI | pending |
| M5 | Wallet SDK + web | pending |
| M6 | RelayAdapt + recipes v1 | pending |
| M7 | Broadcasters | pending |
| M8 | prover-assist | pending |
| M9 | Morpho / Arcus / Prism recipes | pending |
| M10 | Disclosure + Solvency | pending |
| M11 | Staking + fees | pending |
| M12 | Mainnet | pending |

## Copy rules

Blocked: "mixer," "untraceable," "anonymous," "hide," "APY."
Permitted: "private," "provably clean," "selectively disclosable,"
"vault NAV accrues."
