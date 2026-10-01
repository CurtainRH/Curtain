# Curtain Frontend Integration Guide: Private Swap, Escape Hatch & Stake-to-Earn

> **Document Version**: 1.0.0
> **Status**: Ready for Frontend Integration
> **Backend**: Curtain v2 (`backend/`, see `docs/CURTAIN_V2_SPEC.md`)
> **Target Audience**: Frontend engineer / coding agent (Codex)

---

## 0. Rules for this task (read first)

1. **Only change the frontend.** You may edit `src/`, `public/`, the root `package.json`, `tsconfig.json`, `.env.example`, and add new files under `src/`. **Do not edit anything in `backend/`, `render.yaml`, `scripts/` or `.github/`.** If the backend seems to need a change, write it down in your final summary instead.
2. **This is a Lovable project.** The frontend must stay at the repo root. Don't rename or move `src/routes/*`, and don't hand-edit `src/routeTree.gen.ts`. Keep `CurtainApp` client-only, since it uses `window`, wallets and GSAP. Don't add Vite plugins that `@lovable.dev/vite-tanstack-config` already includes (see the comment in `vite.config.ts`).
3. **Use Bun** (`bun add`, `bun run`). Never npm or yarn.
4. **Keep the existing look.** The theatre entrance, the liquid-glass invitation (`src/curtain/glass.css`), fonts, colours and GSAP motion stay. New screens should use the existing panel and table styles in `src/curtain/dashboard.css`.
5. **Copy rules.** Never use "mixer", "untraceable", "anonymous", "hide" or "APY". Use "private", "selectively disclosable" and "rewards".
6. **Don't commit or push.** The project owner will have it audited and pushed.

---

## 1. Executive Summary & Architecture

Curtain v2 has two products. The app currently shows the old design (shielded notes, recipes, disclosure, "Morpho vault"), and **that UI must be replaced**:

| Product | What the user does | Contracts / services |
|---|---|---|
| **Private swap** | Swap token X for token Y and have Y delivered to any address, instantly or after a random delay they choose (up to 180 days) | `CurtainVault` + operator API + keepers |
| **Stake-to-earn** | Lock tokens for 30 / 90 / 180 days and earn rewards at 1× / 1.5× / 2× | `CurtainStaking` |
| **Lending** | Coming after launch (Morpho) | Show it as "coming soon" only |

### How a private swap works
1. **Quote:** the UI asks the operator API what the swap would pay right now (`GET /quote`).
2. **Intent:** the UI calls `POST /intents` with tokens, amount, recipient, minimum output, delay and the user's wallet address as `depositor`. The operator returns an **escape ticket** (`deadline`, `salt`) and a `deadlineHash`.
3. **Deposit:** the user approves the token and calls `CurtainVault.deposit(token, amount, deadlineHash)` from their wallet. The SDK's `swap()` does steps 2 and 3 for you.
4. **Settlement:** at the scheduled time the operator batches deposits, swaps through Uniswap inside the vault, and pays the recipient. The UI only polls `GET /intents/:id`.
5. **Escape hatch:** if a swap isn't paid by its deadline, the user can take their deposit back 3 minutes later (`requestRefund`). After a 10-minute challenge window, anyone can finish it (`finalizeRefund`). **This needs the escape ticket**, and if Curtain's operator is offline, only the ticket the user saved can unlock the refund. Saving the ticket reliably is the most important part of this integration.

**Privacy model, for copy and UX:** on-chain, the deposit shows only the user's address, the token and the amount. The recipient and output token appear only when the payout lands, with nothing linking the two. Longer delays and fresh recipient addresses give more privacy.

---

## 2. Setup

### 2.1 Dependencies
```bash
bun add viem
```
`viem` must be a **root** dependency. Vercel and Lovable install only the root `package.json`, even though the SDK also resolves `viem` from `backend/` locally.

### 2.2 Use the SDK from the frontend
The client SDK lives at `backend/packages/sdk/src`. Add path aliases to the root `tsconfig.json` `compilerOptions.paths`. The Lovable Vite config already applies tsconfig paths, so no Vite change is needed:
```json
"paths": {
  "@/*": ["./src/*"],
  "@curtain/sdk": ["./backend/packages/sdk/src/index.ts"],
  "@curtain/sdk/*": ["./backend/packages/sdk/src/*"]
}
```
Then:
```ts
import { CurtainClient, ROBINHOOD_CHAIN_TOKENS, TIERS, positionsOf, type EscapeTicket, type IntentStatus } from "@curtain/sdk";
```
This has been checked to typecheck under the root's strict `tsconfig`.

### 2.3 Environment variables (`.env.example` at the root)
Vite only exposes `VITE_*` variables. Add these, keeping the existing `VITE_API_URL` line:
```bash
VITE_CURTAIN_API_URL=https://<operator>.onrender.com        # operator API (local: http://localhost:3100)
VITE_CHAIN_ID=4663
VITE_RPC_URL=https://rpc.mainnet.chain.robinhood.com
VITE_EXPLORER_URL=https://robinhoodchain.blockscout.com
VITE_VAULT_ADDR=                                            # from backend/contracts/deployments/4663.json ("vault")
VITE_STAKING_ADDR=                                          # from the same file ("staking")
VITE_STAKING_FROM_BLOCK=                                    # staking deployment block (for listing positions)
VITE_STAKE_TOKEN_ADDR=                                      # $CRTN once launched; empty = staking not live yet
```
The contracts aren't deployed yet. Read every address from env, never hardcode one, and show a clear "not configured" state when a value is empty.

### 2.4 Robinhood Chain (mainnet)
| Field | Value |
|---|---|
| Chain ID | `4663` (hex `0x1237`) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |
| Native currency | ETH, 18 decimals |

Build a viem chain with `defineChain` from these values. Use the explorer for links: `${EXPLORER}/tx/<hash>` and `${EXPLORER}/address/<addr>`.

### 2.5 Tokens
- **Addresses:** take token addresses from `GET /config` (`tokens`, by symbol).
- **Logos and names:** match `ROBINHOOD_CHAIN_TOKENS` from the SDK by **symbol**.
- **Decimals:** read **on-chain** with `decimals()` (cache per address). Local test chains use 18-decimal mock tokens, including a mock USDG, so hardcoding decimals breaks either local testing or mainnet.

Logos are already in `public/tokens/`. Mainnet values for reference:

| Symbol | Address | Decimals | Logo |
|---|---|---|---|
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | **6** | `/tokens/usdg.png` |
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 18 | `/tokens/nvda.svg` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 18 | `/tokens/tsla.svg` |
| SPY | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 18 | `/tokens/spy.svg` |
| QQQ | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | 18 | `/tokens/qqq.svg` |

> ⚠️ **Real USDG has 6 decimals.** `src/curtain/domain.ts` (`parseUnits` / `formatUnits`) assumes 18. Use viem's `parseUnits(value, decimals)` / `formatUnits(raw, decimals)` with the on-chain decimals everywhere amounts are converted.

Stock tokens (`stock: true`) are ERC-8056 tokens: raw balances never change, and the displayed value is raw × `uiMultiplier()` (the stock-split/dividend adjustment). Showing raw balances is fine for v1. If you show adjusted values, read `uiMultiplier()` from the token (18-decimal fixed point).

---

## 3. Backend API Reference (operator)

Base URL: `VITE_CURTAIN_API_URL`. Every response is JSON. Errors look like `{ "error": "message" }` with HTTP 400/404/500. CORS is open.

### 3.1 `GET /config`
```json
{
  "vault": "0x…",
  "tokens": { "USDG": "0x5fc5…", "NVDA": "0xd060…", "TSLA": "0x322F…", "SPY": "0x117c…", "QQQ": "0xD5f3…" },
  "keeperFeeBps": 5,
  "maxDelaySeconds": 15552000
}
```
Use `vault` and `tokens` from here rather than env when the API is reachable.

### 3.2 `GET /quote?tokenIn=&tokenOut=&amountIn=&slippageBps=`
`amountIn` is in raw units (e.g. `1000000000` = 1,000 USDG). `slippageBps` is optional and defaults to 100 (1%).
```json
{
  "amountIn": "1000000000",
  "marketOut": "4333318187319467633",
  "expectedOut": "4300620476839262960",
  "minOutSuggested": "4257614272070870330",
  "protocolFee": "8628…",
  "keeperFee": "2157…",
  "venue": "uniswap-v4 0.01%",
  "available": true
}
```
- Show **`expectedOut`** as "You receive ≈". It already deducts the 0.20% protocol fee, the 0.05% keeper fee and the operator's price tolerance.
- Send **`minOutSuggested`** as the intent's `minOut`. If the price moves below it before settlement, the swap waits for a better price, and if the deadline passes, the user refunds.
- If `available` is false, disable the swap ("No liquidity for this pair right now").
- Re-quote when the amount or tokens change (debounce about 400 ms) and every 15 s while the form is open.

### 3.3 `POST /intents`
The SDK's `CurtainClient.swap()` calls this. You normally won't call it directly.
```json
// request (amounts in raw units, as strings)
{ "tokenIn": "0x…", "amountIn": "1000000000", "tokenOut": "0x…", "recipient": "0x…", "depositor": "0x<connected wallet>", "minOut": "4257…", "delaySeconds": 0 }
// 201
{ "id": "9f2c…(32 hex)", "deadline": "1790000000", "salt": "0x…", "deadlineHash": "0x…", "vault": "0x…" }
```
- `delaySeconds = 0` means instant (paid as soon as the deposit lands). Anything from 1 to 15552000 is a random delay window.
- `recipient` can't be the zero address or the vault, and `depositor` must be the wallet that will deposit.

### 3.4 `GET /intents/:id`
```json
{ "status": "settling", "depositId": "12", "amountOut": "4300…", "payoutTx": null, "blockedReason": null }
```
| `status` | Show the user |
|---|---|
| `awaiting_deposit` | "Waiting for your deposit" |
| `deposited` | Instant: "Swapping…". Delayed: "Scheduled (private delay)". Don't reveal the exact payout time. |
| `settling` | "Delivering…" |
| `paid` | "Delivered", with `payoutTx` linked to the explorer |
| `blocked` | "This token can't be sent to that recipient." + `blockedReason` + the refund flow |
| `expired` | "Deposit didn't match this swap." + the refund flow |
| `refund_requested` | "Refund in progress", with a countdown to finalize (10 min) |
| `refunded` | "Refunded to your wallet" |
| `challenged` | "This swap was already delivered; the refund was declined." |

Poll every 4 s while the status is `awaiting_deposit`, `deposited` (instant) or `settling`; every 60 s for delayed swaps; and stop at `paid`, `refunded` or `challenged`.

### 3.5 Not for the UI
`/health`, `/status` and `/settlements/pending` are for monitoring and keepers. Don't call them from the app.

---

## 4. SDK Reference (`@curtain/sdk`)

```ts
const curtain = new CurtainClient({
  apiUrl: import.meta.env.VITE_CURTAIN_API_URL,
  publicClient,                 // viem PublicClient for Robinhood Chain
  walletClient,                 // viem WalletClient from window.ethereum (custom transport)
  stakingAddress: import.meta.env.VITE_STAKING_ADDR,
});
```
| Method | What it does |
|---|---|
| `config()` | `GET /config` |
| `quote(tokenIn, tokenOut, amountIn, slippageBps?)` | `GET /quote`, returns a typed `SwapQuote` |
| `swap({ tokenIn, amountIn, tokenOut, recipient, minOut, delaySeconds })` | Creates the intent, approves the vault if needed, deposits. Returns `{ intentId, ticket, depositTx }`. It may ask the wallet for two signatures (approve, then deposit). |
| `status(intentId)` | `GET /intents/:id`, returns a typed `IntentStatus` |
| `refundAvailableAt(ticket)` | Unix time from which `requestRefund` works (`deadline + 180`) |
| `requestRefund(ticket)` | Starts the escape hatch. Must be the depositor's wallet. |
| `finalizeRefund(ticket)` | Pays the deposit back. Callable 10 minutes after the request. |
| `stake(token, amount, tier)` | Approves if needed and stakes into tier 0/1/2. Returns the position id. |
| `earned(positionId)` / `claim(positionId)` / `withdraw(positionId)` | Rewards and exit. Withdraw works only after unlock. |
| `positionsOf(publicClient, staking, owner, fromBlock)` | Standalone function listing a wallet's positions (`{ id, amount, weighted, unlockAt, earned, closed }`) |
| `TIERS` | `[{tier:0,days:30,multiplier:1},{tier:1,days:90,multiplier:1.5},{tier:2,days:180,multiplier:2}]` |
| `REFUND_DELAY_SECONDS` (180), `CHALLENGE_WINDOW_SECONDS` (600) | Constants for the countdowns |

**Wallet → viem:** keep the existing `window.ethereum` connection in `src/curtain/App.tsx` (`useNav().wallet`). Build the clients with:
```ts
const walletClient = createWalletClient({ chain: robinhoodChain, transport: custom(window.ethereum), account: wallet as `0x${string}` });
const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(import.meta.env.VITE_RPC_URL) });
```
Before any transaction, check `eth_chainId === 0x1237`. If it isn't, call `wallet_switchEthereumChain`, falling back to `wallet_addEthereumChain` with the values in §2.4.

---

## 5. The Escape Ticket (do this carefully)

`swap()` returns `ticket: { vault, depositId, deadline, salt }`. Without it, a user can't refund if the operator is gone.

1. **Save it automatically** to `localStorage` under `curtain-tickets-v1`, keyed by the connected wallet: `{ [wallet]: Array<{ intentId, ticket, createdAt, tokenIn, amountIn, tokenOut, recipient }> }`. Wrap every read and write in try/catch, because storage can be blocked.
2. **Offer a download right after the deposit:** a JSON file named `curtain-escape-ticket-<depositId>.json` (reuse `downloadFile` from `src/curtain/domain.ts`), with the sentence: *"Keep this file. If Curtain is ever unavailable, it lets you take your deposit back."*
3. **Allow importing a ticket file** in Activity, for use on another browser or device.
4. **Treat it as private:** it reveals the swap's hidden deadline. Never send it anywhere except the user's own wallet transactions.

---

## 6. UI Changes

### 6.1 Remove the old (v1) concepts
In `src/curtain/Dashboard.tsx`, remove the `shield`, `unshield`, `recipes`, `disclosure` and `receive` tabs and the "prover" setting (`curtain-prover`). Also remove or replace the "notes" and "drafts" (`curtain-plans-v1`) features that only prepared those flows. The marketing copy in `App.tsx`, `StageExperience.tsx` and `VelvetCards.tsx` that talks about "shielded notes", "recipes", "view keys" or "proofs" should be reworded to the v2 products: private swaps with an optional delay, stake-to-earn, and lending coming soon. Keep the tone and the "Draw the curtain" voice.

### 6.2 New workspace tabs: **Overview · Swap · Stake · Activity** (+ "Lending — coming soon")

**Overview:** wallet balances of the five tokens, with logos and decimals-aware formatting; open swaps (from saved tickets plus `status()`); staked positions and claimable rewards.

**Swap:**
- **From:** token picker (logo + symbol + balance) + amount input + "Max".
- **To:** token picker (can be the same token: a private transfer).
- **Recipient:** defaults to the connected wallet, with an option for any address. Show this hint: *"Sending to a fresh address gives you the most privacy."* Validate it with `isAddress`; reject the zero address and the vault address.
- **Timing:** a segmented control, *Instant* | *Private delay*. With *Private delay*, offer presets (1 hour, 6 hours, 1 day, 7 days, 30 days, 180 days) plus custom, capped at `maxDelaySeconds`. Explain: *"Curtain pays out at a random time inside this window. Longer windows are more private."*
- **Quote box:** "You receive ≈ `expectedOut` TOKEN", "Minimum `minOutSuggested`", "Route: `venue`", fees (0.20% protocol, 0.05% keeper), and a slippage setting (0.5 / 1 / 2%, default 1%).
- **Primary action:** **`[ Swap privately ]`**. It runs `curtain.swap(...)`, then shows the escape-ticket save step (§5), then a status card that polls `status()` (§3.4).

**Stake:**
- If `VITE_STAKE_TOKEN_ADDR` is empty, show: *"Staking opens when $CRTN launches."*
- Otherwise: an amount input, three tier cards (30d 1× · 90d 1.5× · 180d 2×, "earn up to 2× rewards"), and **`[ Stake ]`**.
- Positions table: amount, tier, unlock date and countdown, earned (refresh every 15 s), **Claim**, and **Withdraw** (enabled after unlock).
- After unlock a position earns 1× (anyone can "kick" it). Mention it in a tooltip: *"After unlocking, a position earns at 1×. Withdraw and restake to earn a multiplier again."*

**Activity:**
- One row per saved ticket: date, `amount TOKEN → TOKEN`, recipient (shortened), status pill, explorer links (deposit tx, payout tx).
- When `Date.now()/1000 >= refundAvailableAt(ticket)` and the status isn't `paid`, `refunded` or `challenged`, show **`[ Get my deposit back ]`** (which calls `requestRefund`). Then show a 10-minute countdown, followed by **`[ Finish refund ]`** (`finalizeRefund`).
- If the API is unreachable, still list tickets and allow refunds once the deadline passes: the escape hatch must not depend on the API.
- "Import ticket" button (§5).

### 6.3 Token visuals
Use the real logos from `public/tokens/` via `ROBINHOOD_CHAIN_TOKENS[i].logo` everywhere a token appears. The `Token` component in `Dashboard.tsx` already renders logos for USDG and NVDA, so extend it to all five.

---

## 7. Error handling

Map wallet and contract errors to plain messages. Use viem's `BaseError.walk` with `ContractFunctionRevertedError` to read `errorName`:

| Source | Show |
|---|---|
| User rejected in wallet | "You cancelled in your wallet. Nothing was sent." |
| `TokenNotAllowed` | "This token isn't supported." |
| `DepositsArePaused` | "New swaps are paused for maintenance. Existing swaps and refunds still work." |
| `DeadlineHashReused` | "This swap was already deposited. Start a new swap." |
| `TooEarly` | "Not yet. Available `<countdown>`." |
| `WrongDeadline` | "This ticket doesn't match the deposit." |
| `NotDepositor` | "Only the wallet that deposited can request this refund." |
| `WrongStatus` | Re-check `status()`: the swap probably already finished or was refunded. |
| `Locked` (staking) | "Still locked until `<date>`." |
| `TokensNotSet` (staking) | "Staking isn't open yet." |
| API 400 | Show the `error` message from the response. |
| API unreachable | "Curtain's service isn't reachable. Your funds are safe; refunds still work from Activity." |

---

## 8. Verification Checklist

- [ ] `bun x tsc --noEmit`, `bun run lint` (no new errors in files you touched) and `bun run build` pass at the repo root.
- [ ] No files changed under `backend/`, `render.yaml`, `scripts/` or `.github/`.
- [ ] Connecting a wallet on the wrong chain prompts a switch to Robinhood Chain (4663).
- [ ] Balances use on-chain decimals: on mainnet, 1 USDG = `1000000` raw.
- [ ] The swap form shows a live quote (`GET /quote`), sends `minOutSuggested`, and creates a deposit. The escape ticket is saved to localStorage and offered as a download.
- [ ] Status updates through to `paid` with the explorer link to the payout.
- [ ] A swap past `deadline + 3 min` shows **Get my deposit back**, then a 10-minute countdown, then **Finish refund**. It also works with the API offline, using only the saved ticket.
- [ ] Importing a ticket file on a fresh browser restores the row and the refund ability.
- [ ] Staking is hidden behind "opens when $CRTN launches" when the stake token isn't configured. When configured: stake, see the position, claim, and withdraw only after unlock.
- [ ] No remaining UI for shield/unshield, recipes, disclosure, view keys, or the prover setting.
- [ ] No banned words ("mixer", "untraceable", "anonymous", "hide", "APY") anywhere in `src/`.
- [ ] The theatre entrance, glass invitation and first-visit behaviour are unchanged.

### How to test locally
1. The backend owner runs a local chain and operator: `anvil --gas-limit 1000000000`, deploys with `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow` (mock tokens), and starts the operator with `ROUTE=mock` (see `backend/README.md`).
2. Point `.env` at it: `VITE_CURTAIN_API_URL=http://localhost:3100`, `VITE_CHAIN_ID=31337`, `VITE_RPC_URL=http://127.0.0.1:8545`, and the addresses from `backend/contracts/deployments/31337.json`.
3. In your wallet, add the local chain (31337) and import Anvil account #1. Its private key is printed when anvil starts; it's a public test key.

---

## 9. Deliverable

A single summary when you're done:
- the files changed
- anything you couldn't do and why
- any backend changes you think are needed (don't make them)
