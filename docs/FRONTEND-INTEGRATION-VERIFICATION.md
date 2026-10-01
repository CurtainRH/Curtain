# Curtain frontend integration

Implemented from `docs/FRONTEND-INTEGRATION.md`, with the frontend at the repository root and the existing client-only mount, theatre entrance, glass invitation, media, fonts and GSAP transitions retained.

## Changed files

- `package.json`, `bun.lock`: root viem dependency, pinned to the SDK's installed version.
- `tsconfig.json`: `@curtain/sdk` aliases.
- `.env.example`: operator, network, explorer, vault and staking configuration.
- `src/curtain/integration.ts`: viem clients, chain switching, RPC network validation, cached on-chain decimals, wallet/contract errors and private ticket storage.
- `src/curtain/useCurtain.ts`: token balances, operator statuses, direct vault refund reads, staking positions and reward refreshes. Original lock tiers come from staking events, so a later kick cannot mislabel the original tier.
- `src/curtain/Dashboard.tsx`, `dashboard.css`: Overview, Swap, Stake and Activity; live quotes; recipient/timing/slippage controls; saved ticket downloads/import; direct refunds and challenge countdowns; lending coming soon.
- `src/curtain/domain.ts`, `useWorkspaceTools.ts`: remove v1 plans and amount helpers; retain JSON downloads and navigation automation without exposing tickets.
- `src/curtain/App.tsx`, `StageExperience.tsx`, `VelvetCards.tsx`, `Legal.tsx`: v2 product copy and wallet connection; storage failures no longer interrupt the experience.
- `src/routes/__root.tsx`: formatting-only correction needed by root lint.
- This verification record.

No backend, deployment, script, GitHub workflow or generated route-tree files were edited. No commits or pushes were made.

## Verification

Run at the repository root using Bun:

- `bun x tsc --noEmit`: passed.
- `bun run lint`: passed; seven existing React Fast Refresh warnings remain.
- `bun run build`: passed.
- Source scan: no banned words and no v1 workspace screens.

Chromium checks use mocked EIP-1193 wallet, operator and JSON-RPC responses, not a live chain:

- Wrong-chain connection requests switch/add for the configured network.
- USDG reads six decimals and submits 10 USDG as `10000000` raw units; a fresh browser with an eighteen-decimal local mock submits `10000000000000000000`.
- A live quote becomes the swap's minimum output, and the confirmed deposit produces a wallet-scoped saved ticket and the required JSON download.
- Paid status links to the payout explorer.
- Operator-offline refund request, disabled finalization during the challenge window, and finalization after that window.
- A standalone ticket imported into a fresh browser restores refund access without the operator.
- Unconfigured staking shows the CRTN launch message.
- Configured staking submits the selected amount/tier, lists positions, refreshes claimed rewards, blocks withdrawal before unlock and closes the position after withdrawal.
- Blocked ticket storage produces an explicit backup warning while retaining the ticket download in memory.
- The swap screen fits a 390-pixel mobile viewport without horizontal overflow.
- No browser runtime errors occurred.

The chain defaults were checked against [Robinhood's official network documentation](https://docs.robinhood.com/chain/connecting/).

## Live verification still required

There is no running local operator/chain, and the root environment only supplies the old `VITE_API_URL`. Consequently no real wallet transaction or deployed-contract settlement was exercised.

Use the local setup from the integration guide, then configure `VITE_CURTAIN_API_URL`, `VITE_CHAIN_ID=31337`, `VITE_RPC_URL`, the vault/staking/token addresses and `VITE_STAKING_FROM_BLOCK`. Set a local explorer URL if available. Restart `bun run dev` after changing environment values. Test an actual swap, automatic ticket backup, payout, operator-offline refund and staking lifecycle. For production, supply deployed addresses and the operator URL. Empty values produce explicit configuration/launch states.

No backend change is required for the implemented flows. One SDK reliability follow-up is recommended: expose the intent/ticket before waiting for the deposit receipt, or provide a deposit-submitted callback. The present SDK returns its escape ticket after receipt confirmation; a browser closed during that wait cannot persist a ticket it has not yet received. Keep the page open until the ticket download appears, then retain a backup.
