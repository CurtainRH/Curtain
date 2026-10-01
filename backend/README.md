# Curtain backend

Private swaps and stake-to-earn on Robinhood Chain (4663). Design: [`docs/CURTAIN_V2_SPEC.md`](../docs/CURTAIN_V2_SPEC.md).

## Layout

```
contracts/            Foundry
  src/vault/          CurtainVault — deposits, signed settlements (swap + payouts), escape hatch
  src/staking/        CurtainStaking — lock tiers, pluggable reward token, funded emissions
  src/token/          CRTN (launches later)
  src/stealth/        ERC-5564/6538 stealth addresses
  script/Deploy.s.sol writes deployments/<chainid>.json
packages/db           Postgres access + migrations (PGlite in tests)
packages/sdk          client: swap, escape-hatch refund, staking; shared ABIs
services/operator     intents API, chain watcher, quoting, settlement signing, refund challenger
services/keeper       lands signed settlements for a fee; anyone can run it
services/multiplier-view  ERC-8056 display multipliers
db/migrations         operator schema
scripts/devnet.ts     anvil + Deploy.s.sol, for e2e tests
```

## How a private swap runs

1. **Intent:** the frontend calls `POST /intents` with the depositor's address. The operator stores the recipient, output token, minimum output and delay, and returns a `deadlineHash` plus the user's escape ticket (`deadline`, `salt`).
2. **Deposit:** the user calls `CurtainVault.deposit(token, amount, deadlineHash)`.
3. **Settlement:** at the scheduled time, the operator quotes and signs a settlement for each token pair: the swap plus the payouts it funds.
4. **Landing:** any keeper lands it with `settle()`, swapping and paying in one transaction, and earns the keeper fee.
5. **Escape hatch:** if a deposit is never paid, its depositor can refund it 3 minutes after the deadline. There's a 10-minute challenge window; paid deposits get challenged.

## Local development

```bash
bun install
cp .env.example .env

bun run check                 # typecheck every workspace
bun run test                  # all tests, incl. e2e (needs Foundry: anvil + forge)
cd contracts && forge test    # contracts

# Local chain with the stack deployed
anvil --gas-limit 1000000000
cd contracts && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow
```

- **`--gas-limit` on anvil:** without it, a large deployment transaction can wait for a block that never comes.
- **`--slow` on forge:** sends one transaction at a time; parallel broadcasting occasionally drops one on anvil.

## Running

```bash
docker compose up -d                                  # Postgres
cd services/operator && bun run start                 # needs .env (see .env.example)
cd services/keeper && bun run start                   # optional: anyone can run keepers
```

## Status

| Piece | Status |
|---|---|
| CurtainVault | Built; unit, audit-regression and fuzz tests |
| CurtainStaking | Built; unit, audit-regression and fuzz tests |
| Internal audit (2026-10-01) | H-01, M-01, M-03 and L-01 to L-04 fixed with regression tests; M-02 is a documented trust assumption |
| Operator | Built; e2e on anvil covers settlement, keeper landing, expiry and re-settle, challenge, refund, delay, slippage, rescans |
| Keeper | Built, e2e |
| SDK | Built, e2e (swap, refund, staking) |
| Deploy | `Deploy.s.sol` checks all addresses on 4663; not deployed yet |
| $CRTN | Not launched; staking waits for `setTokens` |
| Lending (Morpho) | After launch |

## Before mainnet

- **Keys (MVP):** a single admin key and a single operator key. A stolen or malicious operator key puts vault funds at risk and can block refunds (audit M-02); move both to a multisig/MPC after launch.
- **External audit:** the internal audit doesn't replace an independent one before real funds.
- **Tokens and router:** set the real token addresses and the Uniswap router on 4663.
- **Postgres:** run a Postgres the operator can reach, and back it up. It holds the depositor→recipient mapping and the payout secrets that power challenges.
- **Monitoring:** alert when the operator hasn't paid an instant swap within a few minutes, since users can refund 3 minutes after the deadline.

## Copy rules

Blocked: "mixer", "untraceable", "anonymous", "hide", "APY". Permitted: "private", "selectively disclosable".
