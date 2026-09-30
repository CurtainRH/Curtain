# Security Policy

## Scope

**In scope**
- Contracts in `backend/contracts/src` (pool, gate, adapt, broadcast, stealth, disclosure, solvency, staking, token)
- Circuits in `backend/circuits` and their generated verifiers
- The wallet SDK (`backend/packages/sdk`) and recipes (`backend/packages/recipes`)
- Services in `backend/services` (api, broadcaster, ppoi-node, prover-assist, solvency, indexer, multiplier-view, status)
- The frontend in `src/`

**Out of scope**
- Third-party protocols reached through recipes (Uniswap, Morpho, Arcus, Prism). Report those to their teams.
- Robinhood Chain itself
- Social engineering, physical attacks, volumetric DoS
- Findings that need a compromised user device or a leaked viewing key

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

1. **Note-logic soundness**: join-split or unshield proofs that mint, double-spend or break conservation, including ERC-8056 raw-unit and multiplier handling.
2. **Exit-path integrity**: any way `unshieldToOrigin` reaches a destination other than `originOf[note]`, or any way to bypass or extend the PPOI standby, flagging or ragequit.
3. **RelayAdapt atomicity**: partial execution that leaves funds outside the pool, reentrancy through adapter targets, or fee double-charging on reshield.
4. **Privacy leaks**: `prover-assist` learning plaintext witnesses, API or indexer data linking notes to addresses or amounts, or view-key scope escalation.
5. **Broadcaster and PPOI manipulation**: censorship without slashable evidence, fee manipulation outside the proof, and stale or forged provider roots.

## Deployed contracts

Robinhood Chain (4663) addresses will be listed here once published.
