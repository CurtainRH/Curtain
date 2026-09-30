# Contributing to Curtain

## Wanted right now

- **Routing**: better swap routing for the operator (multi-hop, Uniswap V4) in `backend/services/operator/src/routes.ts`.
- **Keepers**: running keepers, and gas-aware fee thresholds in `backend/services/keeper`.
- **Tests**: fuzz and invariant tests for `CurtainVault` (payouts vs. refunds) and `CurtainStaking` (reward accounting).
- **Privacy**: batching and payout-splitting strategies that make deposits and payouts harder to match.
- **Docs**: corrections to `docs/` wherever they disagree with the code.

## Out of scope

- Anything that lets the operator move vault funds other than through signed payouts or `executeSwap`.
- Anything that can block or delay the escape hatch.
- KYC gating.
- Copy that uses blocked terms: "mixer", "untraceable", "anonymous", "hide", "APY". Use "private" or "selectively disclosable".

## Setup

```bash
git clone --recurse-submodules https://github.com/CurtainRH/curtain.git
cd curtain
bun install && cp .env.example .env                        # frontend
cd backend && bun install && cp .env.example .env          # backend
docker compose up -d                                       # Postgres
```

Requires Bun ≥ 1.4 and Foundry.

## Workflow

1. Fork, then branch from `main` (`feat/uniswap-v4-route`, `fix/refund-window`).
2. Make one change per PR.
3. Run `bun run check && bun run test` in `backend/`, plus `forge test` in `backend/contracts/` if you touched contracts.
4. Open a PR against `main`.

## PR guidelines

- One concern per PR.
- Every behaviour change comes with a test. Contract changes need a forge test. Service changes need a bun test.
- Open an issue first for new contracts, fee changes or new services.
- Never commit `.env` files, keys or `out/` directories.

## Commit style

Imperative, present tense, plain English: `Add Prism DEX swap recipe`, `Fix standby extension when two providers are stale`.

## Reporting bugs

Open an issue with:

- **What you did**: action, network, token, and SDK or app version.
- **What you got**: error, tx hash, logs.
- **What you expected**
- **Repro steps**: minimal, numbered.

Do **not** open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
