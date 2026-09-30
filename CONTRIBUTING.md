# Contributing to Curtain

## Wanted right now

- **Recipes**: new `Step`/`Recipe` adapters in `backend/packages/recipes` for RHC protocols, in Railgun cookbook format.
- **PPOI providers**: list-provider integrations for `backend/services/ppoi-node`.
- **Broadcaster ops**: running a bonded broadcaster, and fixes to relay and gossip reliability in `backend/services/broadcaster`.
- **Tests**: invariant and fuzz tests for `CurtainPool`, `ScreeningGate` and `RelayAdapt`, and leak-harness cases for `prover-assist`.
- **Docs**: corrections to `docs/` wherever they disagree with the code.

## Out of scope

- Upgradeability or admin paths on the pool. Note logic is immutable by design.
- Any unshield path whose destination is not the note's origin.
- Removing or weakening the PPOI standby, or ragequit.
- KYC gating.
- Copy that uses blocked terms: "mixer", "untraceable", "anonymous", "hide", "APY". Use "private", "provably clean", "selectively disclosable" or "vault NAV accrues".

## Setup

```bash
git clone --recurse-submodules https://github.com/CurtainRH/curtain.git
cd curtain
bun install && cp .env.example .env                        # frontend
cd backend && bun install && cp .env.example .env          # backend
docker compose up -d                                       # Postgres + Redis
```

Requires Bun ≥ 1.4 and Foundry.

## Workflow

1. Fork, then branch from `main` (`recipe/morpho-withdraw`, `fix/standby-extension`).
2. Make one change per PR.
3. Run `bun run check && bun run test:unit` in `backend/`, plus `forge test` in `backend/contracts/` if you touched contracts.
4. Open a PR against `main`.

## PR guidelines

- One concern per PR.
- Every behaviour change comes with a test. Contract changes need a forge test. Service changes need a bun test.
- Open an issue first for new contracts, circuit changes, fee changes or new services.
- Never commit `.env` files, keys, `.zkey`/`.ptau` artifacts or `out/` directories.

## Commit style

Imperative, present tense, plain English: `Add Prism DEX swap recipe`, `Fix standby extension when two providers are stale`.

## Reporting bugs

Open an issue with:

- **What you did**: action, network, token, and SDK or app version.
- **What you got**: error, tx hash, logs.
- **What you expected**
- **Repro steps**: minimal, numbered.

Do **not** open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
