# Curtain ($CRTN)

![CI](https://github.com/CurtainRH/curtain/actions/workflows/backend.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.x-000000?logo=bun&logoColor=white)
![TanStack Start](https://img.shields.io/badge/TanStack_Start-React_19-FF4154?logo=react&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-0.8.26-363636?logo=solidity&logoColor=white)
![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-4663-CCFF00)

Private swaps and stake-to-earn on Robinhood Chain. Swap USDG and tokenized Stock Tokens without a public trail from your wallet to where the tokens land, instantly or on a random delay you choose, with an escape hatch that always returns your deposit if Curtain can't pay. Tagline: *Draw the curtain.*

Design: [docs/CURTAIN_V2_SPEC.md](docs/CURTAIN_V2_SPEC.md).

## Features

| Feature | What it does |
|---|---|
| Private swap | Deposit token X into the Curtain vault; token Y arrives at the address you choose. On-chain, the deposit and the payout aren't linked. |
| Instant or delayed | Paid right away, or at a random time inside a window you pick (up to 180 days) for more privacy. |
| Escape hatch | If a swap isn't paid by its deadline, you can take your deposit back 3 minutes later. |
| Open keepers | Anyone can submit signed payouts and earn a small fee. |
| Stake-to-earn | Lock for 30 / 90 / 180 days to earn emissions at 1× / 1.5× / 2×. |
| Lending | Morpho integration, after launch. |

## How it works

1. **Intent:** the app asks the operator for a swap (output token, recipient, minimum output, delay). The user gets an escape ticket.
2. **Deposit:** the user deposits into `CurtainVault`. On-chain this shows only the deposit, not where it's going.
3. **Swap:** at the scheduled time, the operator batches deposits and swaps inside the vault through Uniswap.
4. **Payout:** the operator signs a payout; any keeper submits it. It carries no link to the deposit.
5. **Refund if needed:** after the deadline plus 3 minutes, an unpaid deposit can be refunded. A 10-minute challenge window stops anyone who was already paid.

## Fees

| | Fee |
|---|---|
| Swap | 0.20% of the output |
| Keeper | 0.05% of the output (covers gas) |
| DEX | Uniswap pool fee |

## Repo structure

```
/                     frontend: Curtain site (TanStack Start + Vite + Tailwind), deployed by Vercel/Lovable
├─ src/               app routes, Curtain experience (src/curtain), shadcn/ui components
├─ public/
├─ backend/           Bun workspace — see backend/README.md
│  ├─ contracts/      Foundry: CurtainVault, CurtainStaking, CRTN, stealth addresses
│  ├─ packages/       sdk (client + ABIs), db (Postgres + migrations)
│  ├─ services/       operator, keeper, multiplier-view
│  ├─ db/migrations/  operator schema
│  ├─ scripts/        devnet.ts (anvil + Deploy.s.sol for e2e tests)
│  └─ Dockerfile      operator / keeper image
├─ docs/              CURTAIN_V2_SPEC.md (current), earlier ZK specs, repo sync guide
├─ scripts/           sync-public.py
└─ .github/workflows/ backend CI
```

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.4, [Foundry](https://getfoundry.sh), and Docker (for local Postgres).

```bash
git clone --recurse-submodules https://github.com/CurtainRH/curtain.git
cd curtain

# Frontend
cp .env.example .env
bun install
bun run dev

# Backend
cd backend
cp .env.example .env
bun install
bun run test                   # all tests, incl. e2e on a local anvil chain
cd contracts && forge test     # contracts
```

## Operator API

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ status }` |
| GET | `/config` | vault, tokens, keeper fee, max delay |
| POST | `/intents` | `{ id, deadline, salt, deadlineHash, vault }` |
| GET | `/intents/:id` | status, deposit id, output, payout tx |
| GET | `/payouts/pending` | signed payouts any keeper may submit |

## Roadmap

| Phase | Scope |
|---|---|
| MVP | Private swap (vault + operator + keepers), stake-to-earn, SDK |
| Launch | $CRTN token, deploy to Robinhood Chain, move admin/operator keys to multisig/MPC |
| After launch | Morpho lending |

## Tech stack

Solidity 0.8.26 + Foundry · Bun + TypeScript · Postgres · viem · Uniswap · React 19 + TanStack Start + Tailwind v4 + shadcn/ui · GSAP

## License

[MIT](LICENSE)
