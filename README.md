# Curtain ($CRTN)

![CI](https://github.com/CurtainRH/curtain/actions/workflows/backend.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)
![TanStack Start](https://img.shields.io/badge/TanStack_Start-React_19-FF4154?logo=react&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-0.8.26-363636?logo=solidity&logoColor=white)
![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-4663-CCFF00)

The privacy system for Robinhood Chain. Shield USDG and tokenized Stock Tokens into private UTXO notes, trade, lend and earn from behind the shield in single atomic transactions, and prove your funds are clean without revealing your book. Tagline: *Draw the curtain.*

## Features

| Feature | What it does |
|---|---|
| Shield | One tap: USDG or any Stock Token becomes a shielded note. 0.20% fee. |
| Swap-into-shield | Buy NVDA on Uniswap and receive it already shielded, in one tx. |
| Private DeFi (RelayAdapt) | Unshield → call any RHC protocol → reshield, atomically. The broadcaster pays gas. |
| Proofs of innocence (PPOI) | Blinded non-membership proofs against multiple list providers. 15-minute standby, and ragequit is always available. |
| Unshield-to-origin | Returns funds only to the user's original EOA, never to a broadcaster address. |
| View keys | Selective disclosure per note or per account to auditors, counterparties or tax tools. |
| Stealth receive | ERC-5564/6538 one-time addresses for USDG and Stock Tokens. |
| Broadcaster network | Permissionless and bonded in $CRTN, with published fee schedules. |
| Mobile proving | Server-assisted Groth16 with blinded witnesses, under 10s. |
| Solvency | Hourly per-token solvency proofs. |

## How it works

1. **Shield**: tokens enter `CurtainPool` as raw-unit notes. ERC-8056 multipliers apply only at display time.
2. **Screen**: `ppoi-node` builds a blinded non-membership proof against pinned provider roots. The note clears within the 15-minute standby.
3. **Use**: the wallet SDK builds join-split proofs locally (desktop) or through `prover-assist` (mobile). Recipes route calls through `RelayAdapt`.
4. **Relay**: a bonded broadcaster submits the bundle and takes its fee inside the proof.
5. **Disclose / prove**: view keys grant scoped read access. `solvency` publishes hourly proofs.

## Fees

| Action | Fee |
|---|---|
| Shield | 0.20% |
| Unshield | 0.20% |
| Same-tx reshield (RelayAdapt) | Shield fee waived |
| Broadcaster | Set by each broadcaster (max 0.30%), paid from the proof on top of the protocol fee |

Fee split: 60% to $CRTN stakers, 40% to treasury and prover costs. Governors can move the protocol fee within 0.10–0.30%, through a 24h timelock the multisig can veto.

## Repo structure

```
/                     frontend: Curtain site (TanStack Start + Vite + Tailwind), deployed by Vercel/Lovable
├─ src/               app routes, Curtain experience (src/curtain), shadcn/ui components
├─ public/
├─ backend/           Bun workspace
│  ├─ contracts/      Foundry: pool, gate, adapt, stealth, disclosure, solvency, staking, token
│  ├─ circuits/       circom: joinsplit, ppoi, solvency, unshield
│  ├─ packages/       sdk, recipes, verifier, db (Postgres access + migrations)
│  ├─ services/       api, broadcaster, indexer, multiplier-view, ppoi-node, prover-assist, solvency, status
│  ├─ scripts/        devnet.ts (anvil + Deploy.s.sol for e2e tests)
│  ├─ apps/web/       wallet web app
│  ├─ db/migrations/  Postgres migrations (applied by services/api on start)
│  └─ Dockerfile      @curtain/api image
├─ docs/              product specs: Overview, Backend, Build; repo sync guide
├─ scripts/           sync-public.py
└─ .github/workflows/ backend CI
```

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.4, [Foundry](https://getfoundry.sh), and Docker (for local Postgres and Redis).

```bash
git clone --recurse-submodules https://github.com/CurtainRH/curtain.git
cd curtain

# Frontend
cp .env.example .env
bun install
bun run dev

# Backend
cd backend
docker compose up -d
cp .env.example .env
bun install
bun run test:unit              # TypeScript unit tests
bun test                       # everything, including e2e (needs anvil + built circuits)
cd contracts && forge test     # contracts
```

Run the API locally with `cd backend/services/api && bun run dev`, then open `GET http://localhost:3000/health`.

## API

`backend/services/api`, read-only, over the indexer's tables:

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ status, timestamp, version }` |
| GET | `/tokens` | registered tokens, TVL, ERC-8056 multiplier |
| GET | `/ppoi/status/:commit` | `cleared` \| `flagged` \| `standby` \| `spendable`, `standbyUntil` |
| GET | `/providers` | list roots, freshness, current standby (15 or 60 min) |
| GET | `/broadcasters` | bond, fees, failures |
| GET | `/solvency/latest` | latest finalized epoch per token |
| GET | `/recipes` | recipe registry |
| GET | `/stats` | daily activity counts |

Public aggregates only: no table or endpoint links a note to an address, an amount or another note. Transactions are built in the wallet SDK, which holds the keys.

## Roadmap

| Phase | Milestones |
|---|---|
| Core | M0 toolchain · M1 stealth v0 · M2 circuits · M3 pool · M4 gate + PPOI |
| Wallet | M5 SDK + web · M6 RelayAdapt + recipes · M7 broadcasters · M8 prover-assist |
| DeFi + launch | M9 Morpho / Arcus / Prism · M10 disclosure + solvency · M11 staking + fees · M12 mainnet |

The full breakdown and launch gates are in [docs/Curtain_Build.md](docs/Curtain_Build.md).

## Tech stack

Solidity 0.8.26 + Foundry · circom 2 + snarkjs (Groth16, BN254) · Bun + TypeScript · Postgres + Redis (Railway) · libp2p gossipsub · viem · React 19 + TanStack Start + Tailwind v4 + shadcn/ui · GSAP

## License

[MIT](LICENSE)
