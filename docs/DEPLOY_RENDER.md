# Deploying Curtain (Robinhood Chain mainnet + Render)

Two parts: deploy the contracts once from your machine, then run the operator, a keeper and Postgres on Render with the Blueprint in `render.yaml`.

## 0. Wallets you need

Create four wallets. They must all be different.

| Wallet | Used for | Needs ETH on Robinhood Chain? |
|---|---|---|
| Deployer | Running the deploy script once | Yes, about 0.01 ETH |
| Admin | Owns the vault and staking (allowlists, operator rotation, fee, pause) | A little, for admin transactions |
| Operator | Signs settlements, challenges double-refunds, runs its own keeper | Yes, keep at least 0.02 ETH topped up |
| Keeper | Lands settlements for the keeper fee | Yes, a little |

The treasury can be any address you control.

Keep the admin key offline. The operator and keeper keys go into Render as secrets.

## 1. Deploy the contracts

From `backend/contracts`, with Foundry installed:

```bash
export PRIVATE_KEY=0x...            # deployer
export ADMIN_ADDR=0x...
export OPERATOR_ADDR=0x...
export TREASURY_ADDR=0x...
export DEX_ROUTER_ADDR=0xcaf681a66d020601342297493863e78c959e5cb2   # Uniswap SwapRouter02 on Robinhood Chain
export TOKEN_ADDRS=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168,0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,0x322F0929c4625eD5bAd873c95208D54E1c003b2d,0x117cc2133c37B721F49dE2A7a74833232B3B4C0C,0xD5f3879160bc7c32ebb4dC785F8a4F505888de68
#                   USDG,                                         NVDA,                                         TSLA,                                         SPY,                                          QQQ

forge script script/Deploy.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --slow
```

- The script refuses to run on mainnet with a missing address, or with a token or router that has no code.
- It writes `deployments/4663.json` with the vault, staking and token addresses. Commit that file.
- Note the block number of the deployment transaction. That's `START_BLOCK` below.
- If `ADMIN_ADDR` differs from the deployer, the script starts a two-step ownership transfer of the vault. The admin must call `acceptOwnership()` on the vault to finish it. Staking is owned by the admin from the start.

## 2. Create the Render services

1. In Render: **New → Blueprint**, connect the GitHub repo, and pick `render.yaml`. It creates `curtain-db` (Postgres), `curtain-operator` (web service) and `curtain-keeper` (worker).
2. Fill in the secrets Render asks for:

   | Variable | Service | Value |
   |---|---|---|
   | `RPC_HTTP` | operator, keeper | A dedicated Robinhood Chain RPC URL (the public one is rate limited) |
   | `OPERATOR_PRIVATE_KEY` | operator | The operator wallet's key |
   | `KEEPER_PRIVATE_KEY` | keeper | The keeper wallet's key |
   | `VAULT_ADDR` | operator, keeper | `vault` from `deployments/4663.json` |
   | `TOKENS` | operator | `tokens` from `deployments/4663.json`, as JSON |
   | `START_BLOCK` | operator | The vault's deployment block |

3. Deploy. The operator creates its database tables on start.
4. Check `https://<operator>.onrender.com/health` returns `{"status":"ok"}`, and `/config` shows the right vault and tokens.

## 3. Monitoring

Point an uptime monitor (Render notifications, Better Stack, UptimeRobot) at:

```
https://<operator>.onrender.com/status
```

It returns **503** with a `problems` list when:
- the operator loop stopped ticking
- the operator's ETH is below 0.005
- a deposit is within 3 minutes of its deadline without a landed settlement (its owner is about to refund)
- the chain watcher is more than 200 blocks behind

Alert yourself on any 503.

## 4. Backups and the database

- Render's paid Postgres plans include daily backups. Upgrade the plan as volume grows.
- The database holds the depositor→recipient mapping and the payout secrets used to challenge double refunds. Don't share access to it.

## 5. Staking (after $CRTN launches)

From the admin wallet:
1. `CurtainStaking.setTokens(CRTN, CRTN)`
2. `CRTN.approve(staking, amount)`
3. `CurtainStaking.notifyRewardAmount(amount, durationSeconds)`

Repeat step 3 for each reward period.

## Day-to-day

- Keep the operator and keeper wallets funded with ETH.
- `autoDeploy` is off: deploy new backend versions deliberately, not on every push.
- To pause new deposits, the admin calls `setDepositsPaused(true)`. Settlements and refunds keep working while paused.
