/**
 * @curtain/multiplier-view — Serves ERC-8056 uiMultiplier() per token for wallet display,
 * per Curtain_Build.md §3.1/§4. See store.ts's header for the real-data-feed boundary this
 * service intentionally stops at (write path exists; no live corporate-actions feed is
 * wired in since that needs a specific paid data provider chosen and credentialed first).
 */
export const name = "multiplier-view" as const;

export function ready(): boolean {
  return true;
}

export * from "./store";
export * from "./server";
