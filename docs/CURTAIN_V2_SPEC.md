# Curtain v2 — Spec

Replaces the zero-knowledge design in `Curtain_Overview.md` / `Curtain_Backend.md` / `Curtain_Build.md` for the MVP. Locked 2026-09-30.

## Product

| Feature | MVP | How |
|---|---|---|
| Private swap | Yes | `CurtainVault` contract + Postgres + keepers |
| Stake-to-earn | Yes | `CurtainStaking` contract, lock tiers, pluggable emissions |
| Lending | After launch | Morpho integration |

- **Chain:** Robinhood Chain (4663)
- **Tokens:** USDG, NVDA, TSLA, SPY, QQQ, HOOD
- **DEX:** Uniswap on RHC

## Private swap

### Flow
1. **Intent.** The user asks the operator API for a swap: token X, amount, token Y, recipient, minimum output, and either `instant` or a random delay window of up to 180 days. The operator picks a payout time (random inside the window; immediately for instant) and a deadline (end of the window plus 10 minutes; 10 minutes for instant) and a salt, and stores the intent. It returns `deadline`, `salt` and `deadlineHash = keccak256(deadline, salt)`. The user keeps `deadline` and `salt`; they are only needed for the escape hatch.
2. **Deposit.** The user calls `CurtainVault.deposit(token, amount, deadlineHash)` from the address they named as `depositor`. On-chain this shows only depositor, token, amount and the opaque hash, never the recipient, the output token or the deadline. Hashes are unique per depositor, and the operator matches deposits on (depositor, hash), so nobody can front-run a deposit by reusing its hash.
3. **Settlement.** At payout time the operator groups due deposits by (X, Y), quotes the swap (minus a slippage tolerance, default 0.5%), drops any deposit whose own minimum the price can't meet, and signs one EIP-712 **settlement**: the swap plus one payout per deposit. Each payout is `{ recipient, amount, protocolFee, keeperFee, tag }`, with `tag = keccak256(depositId, secret)`, which does not reveal the deposit.
4. **Landing.** Any keeper submits the settlement with `settle()` and earns the keeper fees. The vault swaps through an allowlisted router and pays every payout **in the same transaction**. It also checks that:
   - the output landed in the vault and meets the minimum;
   - payouts don't exceed what the swap produced;
   - fees are within caps (protocol ≤ `feeBps`, keeper ≤ 1%);
   - no payout goes to the zero address or the vault.

   If a settlement isn't landed within its TTL (default 5 minutes, never past any of its deposits' deadlines), it expires and the deposits are re-quoted and re-settled. Nothing is swapped until a settlement lands, so an unpaid deposit is always refundable in its own token.
5. **Fee.** 0.20% of the output, sent to the treasury inside each payout. The keeper fee is 0.05% of the output.

### Escape hatch (optimistic refund)
- `requestRefund(depositId, deadline, salt)`: depositor only, once `now >= deadline + 3 minutes`. Checks `keccak256(deadline, salt) == deadlineHash`.
- `challengeRefund(depositId, secret)`: within 10 minutes of the request, anyone holding the secret (the operator's keepers) proves a payout with `tag = keccak256(depositId, secret)` already happened. The deposit is marked settled and no refund is paid. This link between a deposit and its payout is revealed only when someone tries to be paid twice.
- `finalizeRefund(depositId)`: after 10 unchallenged minutes, the full deposited amount goes back to the depositor.
- If Curtain goes offline, every unpaid deposit can be refunded 3 minutes after its own deadline.

### Operator and database
- **Operator hot key:** signs settlements. It holds no funds and can't move vault funds except through a signed settlement.
- **Admin key (single key for MVP, two-step ownership transfer):** controls allowlisted routers and tokens, operator rotation, fee (capped at 1%), treasury and a deposit pause (settlements and refunds keep working while paused). Move to a multisig after launch.
- **Trust limit (audit M-02):** a malicious or compromised operator can sign payouts to itself and can block a refund by paying 1 wei under the deposit's tag. The escape hatch protects against an operator that is offline, not one that is hostile. That's why the key belongs in MPC or a multisig.
- **Postgres:** holds intents, deposits, settlements, payouts and secrets. Each state change (deposit seen, swap executed and allocated, payout signed, payout confirmed) is one database transaction.
- **Batching:** delayed deposits are paid at a random time inside their window; payouts can be split.
- **Privacy limits:** the database holds the depositor→recipient mapping. On-chain privacy depends on volume, batching and delays.

## Stake-to-earn

- **Tokens:** the stake token and reward token are set once by the admin (likely $CRTN, not launched yet). Staking is disabled until then.
- **Lock tiers:** 30 days at 1×, 90 days at 1.5×, 180 days at 2×. Each stake is a position with its own unlock time; rewards accrue on `amount × multiplier`.
- **After unlock:** anyone can `kick` a position back to 1×, so only locked stake earns a multiplier.
- **Emissions:** no fixed schedule. The admin funds reward periods with `notifyRewardAmount(amount, duration)` (Synthetix-style), and leftover rewards roll into the next period. While nobody is staked the period pauses, so rewards are never streamed to no one.
- **Claiming:** rewards can be claimed any time. Principal can be withdrawn only after unlock.

## Repo

```
backend/contracts/src/vault/CurtainVault.sol
backend/contracts/src/staking/CurtainStaking.sol
backend/contracts/src/token/CRTN.sol            (launch later)
backend/contracts/src/stealth/                  (ERC-5564/6538, kept)
backend/packages/db                             Postgres access + migrations
backend/packages/sdk                            client: intents, deposit, refund, staking
backend/services/operator                       intents API, deposit watcher, scheduler, swaps, payout signing, refund challenger
backend/services/keeper                         submits signed payouts; anyone can run it
backend/services/multiplier-view                ERC-8056 display multipliers
```
