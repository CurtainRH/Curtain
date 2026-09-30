# CURTAIN ($CRTN) — Overview

**One line:** The privacy system for Robinhood Chain. Shield Stock Tokens and USDG, trade/lend/earn from behind the curtain, prove your funds are clean without showing anyone your book. **Chain:** Robinhood Chain (4663). **Sector:** Privacy · RWA **Leader replicated:** Railgun (UTXO shield, RelayAdapt private DeFi, broadcasters, Private Proofs of Innocence, cookbook) + Privacy Pools (ASP roots, ragequit) + Hinkal (view keys, in-shield DeFi) + Zashi (one-tap shield UX). **Leader beaten on:** tokenized-stock support (ERC-8056), 15-minute PPOI standby with safe auto-refund, yield inside the shield, mobile proving, new-chain presence. **Status:** Spec v1.1 (RHC-only) — 2026-09-25.

Studio reuse ≈ 85%: XPrivacyPool (notes, join-split, relayers), ScreeningGate (→ PPOI), DisclosureRegistry (view keys), SolvencyProof, stealth addresses, rebase-aware raw-unit notes (ERC-8056), GPU prover fleet, Uniswap + Morpho adapters. New: RelayAdapt + recipe SDK, broadcaster bonding, 15-min PPOI flow, stealth registry front-end. The 1/1 twist: Stock Tokens inside the shield, with DeFi — buy NVDA on Uniswap and receive it already shielded, earn on USDG in Morpho from behind the curtain, all in single atomic txs. Railgun explicitly refuses multiplier tokens; nobody else is on RHC.

## 1. Sector state (verified 2026-09-25)

| Player | What works | What's broken |
|---|---|---|
| Railgun ($98M TVL, ETH/ARB/BSC/Polygon; Base approved Aug 2026; in EF's Kohaku) | Encrypted UTXO notes, Groth16, RelayAdapt (unshield → call → reshield in one tx), broadcasters pay gas, PPOI blinded non-membership proofs against Elliptic/Chainalysis/ScamSniffer lists, cookbook (Step→Recipe→Combo) | 0.25% + 0.25% shield/unshield; **1-hour unshield-only standby** after shield; "PPOI Missing" limbo; **open bug #140**: ~$50k USDC trapped when "safely unshield to origin" routed to a broadcaster contract; DAO can change logic; explicitly unsupports rebasing/multiplier tokens; not on RHC or Arc |
| Privacy Pools / 0xbow | ASP root on-chain, ragequit escape, "prove clean" narrative | $6M lifetime volume; ETH only; ASP alone isn't a product |
| Hinkal ($400M vol) | View keys, swap/stake/lend inside the shield, auto-shield | KYC-gated Access Token — retail-hostile |
| Aztec / Zama / Arc Privacy | Real cryptography | Aztec alpha with a July 2026 critical vuln; Zama $7.7M TVL, hides amounts not graph; Arc Privacy unshipped |
| Zcash | Shielded supply 11% → 30% in a year | Lesson: **Zashi's one-tap shield + swap-into-shield rails did it, not new crypto** |
| RHC | Nothing live. Two shells (Privacy Hood, VeiledHood) | — |

**Technical fact that makes this easy:** RH Stock Tokens are plain 18-dec, non-rebasing ERC-20s; dividends/splits live in `uiMultiplier()`. Raw balances are static → perfectly shieldable as UTXO notes. Only the display needs the multiplier. Railgun can't do it because their model refuses multiplier tokens; ours already does (rebase-aware raw-unit notes shipped).

**Defensible claim:** "First privacy system for tokenized stocks." On RHC: first privacy layer, first private DeFi.

## 2. Why this name

A curtain is what you draw so the room is still there, still yours, and no one on the street can see in. Zero crypto hits (Shade, Cloak, Hush, Sable, Dusk, Veil, Obscura, Shroud, Penumbra all taken). Tagline: "Draw the curtain."

## 3. What it does

**Shield.** One tap: USDG or any Stock Token → shielded note. Fee 0.20% (Railgun 0.25%). **Swap-into-shield** rails: buy NVDA on Uniswap and receive it already shielded, in one tx (Zashi/NEAR-intents pattern, done natively).

**Private DeFi (RelayAdapt).** From the shield, call any RHC protocol atomically: unshield → execute → reshield outputs, in one transaction, broadcaster pays gas. Day-one recipes: Uniswap V3/V4 swap, Morpho USDG deposit/withdraw (yield inside the shield), Arcus perp open/close, Prism DEX swap. Recipe format copied from Railgun's cookbook so recipes port both ways.

**Proofs of innocence, fixed.** Blinded non-membership proof against multiple list providers at shield time (Railgun's PPOI), but: standby 15 minutes (not 1 hour), lists pinned on-chain with provider roots (Privacy Pools ASP model), ragequit always available, and the "safely unshield to origin" path only ever returns to the user's original EOA — never a broadcaster address (the #140 bug, closed by construction).

**View keys.** Per-account viewing key; share with an auditor, a counterparty, a tax tool. Selective disclosure per note or per account (Hinkal pattern; studio DisclosureRegistry).

**Stealth receive (v0, ships first).** ERC-5564/6538 meta-address registry: receive Stock Tokens/USDG at one-time addresses before the ZK pool ships. Cheap, immediate, and the mailbox for shielded deposits later.

**Broadcaster network.** Permissionless, bonded, published fee schedule, Waku-style relay. Any broadcaster can serve any tx.

**Mobile proving < 10s.** Server-assisted proving with blinded witnesses (the studio's GPU prover fleet) as the default on mobile; local Groth16 on desktop.

## 4. Studio engines reused

Everything here is the shipped privacy core, packaged as the chain's product: XPrivacyPool (UTXO notes, join-split, relayers), ScreeningGate (association sets → PPOI), DisclosureRegistry (view keys), SolvencyProof epochs, stealth addresses/strategy wallets, rebase-aware raw-unit notes (ERC-8056), GPU prover (private-inference fleet reused for proof generation), Unison/Uniswap adapters, Morpho adapter.

New: RelayAdapt contract + recipe SDK; broadcaster bonding; 15-min PPOI flow; stealth registry front-end.

## 5. Token — $CRTN

- 80 / 10 / 5 / 5. Fresh deployer, multisig, unlinked. *(Note: which bucket is which is not specified in the source spec — confirm before tokenomics/vesting work.)*
- **Utility:** shield/unshield fees (0.20%/0.20%) → 60% to $CRTN stakers ("governors," Railgun pattern), 40% treasury/prover costs. Broadcasters must bond $CRTN. Governance **cannot** change note logic (immutable core; upgrades = new pool + migration), removing Railgun's DAO-can-rewrite risk.

## 6. Launch — two-gate check

**Wet pond:** RHC $1.69B/month Stock Token volume on fully public wallets; Zcash proved retail shields when it's one tap.

**KOL-tweetable first:** "First private wallet for tokenized stocks — buy NVDA on Robinhood Chain and nobody sees it." Day one: stealth receive + shield/unshield + Uniswap recipe. Week one: Morpho yield-in-shield.

**Format:** FLASH; "draw the curtain" one-tap demo video is the launch asset.

## 7. Kill criteria

- Day 7: < $1M shielded TVL → cut broadcaster subsidies; keep the pool.
- Day 30: < $5M TVL and < 2k unique shielders → freeze new recipes; run as infra for other products.
- Any PPOI list-provider outage > 6h → shields continue with standby extended and a public notice; never block unshield-to-origin.

## 8. Frictions

- **[environmental]** "Mixer" narrative. Counter: PPOI + ASP roots + ragequit + view keys, framed "prove clean, never doxx." Publish list providers.
- **[competitive]** Railgun deploys to RHC. Counter: they can't shield multiplier tokens without a rewrite; we're already there. Claim category first.
- **[self-induced]** Proving UX. Mitigation: server-assisted proving default on mobile from day one.

## 9. What not to say

Never "mixer," "untraceable," "anonymous," "hide from." Say **private by default, provably clean, selectively disclosable**.

Never mention Veil, Lowkey, DarkpoolFi, Hood USDP.
