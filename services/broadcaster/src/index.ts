/**
 * @curtain/broadcaster — validates bundles, pays gas, submits, publishes fee schedule
 * M7: assignment + submission + censorship-window logic (node.ts), the
 * HTTPS fallback transport (http.ts). See Curtain_Build.md §11 for what's
 * deferred (libp2p gossip mesh, shieldMeta's meta-tx forwarder, attestor
 * signature gathering for slash()).
 */
export const name = "broadcaster" as const;

export function ready(): boolean {
  return true;
}

export * from "./types";
export * from "./assignment";
export * from "./node";
export * from "./http";
