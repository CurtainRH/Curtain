# Security Policy

## Scope

**In scope**
- Contracts in `backend/contracts/src` (CurtainVault, CurtainStaking, CRTN, stealth)
- The operator and keeper services (`backend/services/operator`, `backend/services/keeper`) and the SDK (`backend/packages/sdk`)
- The frontend in `src/`

**Out of scope**
- Uniswap, Morpho and other third-party protocols. Report those to their teams.
- Robinhood Chain itself
- Social engineering, physical attacks, volumetric DoS
- Findings that require the operator or admin private key (known MVP trust assumption, see below)

## Reporting

Email **curtainsrh@atomicmail.io**. Do not open a public issue.

Include the affected component, the impact, reproduction steps or a PoC, and any suggested fix.

## Response timeline

| Stage | Target |
|---|---|
| Acknowledge | 48 hours |
| Triage and severity | 5 days |
| Patch critical | 7 days |
| Patch high | 30 days |

## Reporter expectations

- No legal action for good-faith research that avoids privacy violations, data destruction and service disruption.
- Test on local forks or testnet, never against other users' funds.
- Give us reasonable time to fix before disclosing.
- Reporters are credited in the fix release unless they ask not to be.

## Attack surfaces we care most about

1. **Vault funds:** any way to take funds from `CurtainVault` without a valid operator signature or a legitimate refund. For example: payout replay, signature malleability, a router-returned balance trick in `executeSwap`, or double refunds.
2. **Escape hatch:** any way to block a legitimate refund, refund a deposit that was already paid, or learn a deposit's hidden deadline early.
3. **Linkability:** any way to link a deposit to its payout from public data beyond timing and amounts, including through the operator API.
4. **Staking:** reward accounting errors, principal counted as rewards, or withdrawing before unlock.
5. **Operator logic:** inputs that make the operator pay the wrong amount or recipient, sign a payout that can land after a refund, or lose track of a deposit.

## Known trust assumptions (MVP)

- The operator key signs payouts and sets swap prices. If it's stolen, vault funds are at risk. The escape hatch protects against the operator going offline, not against key theft.
- A single admin key controls allowlisted tokens and routers, the operator address and the fee (capped at 1%).
- The operator's database holds the depositor→recipient mapping.

## Deployed contracts

Robinhood Chain (4663) addresses will be listed here once published.
