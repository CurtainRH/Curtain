/**
 * @curtain/broadcaster — validates bundles, pays gas, submits, publishes fee schedule
 * M7: assignment + submission + censorship-window logic (node.ts), the
 * HTTPS fallback transport (http.ts). `shieldMeta` bundles (gasless shields via the
 * deployed ERC2771Forwarder) are supported as of post-M12 — see node.ts's header. See
 * Curtain_Build.md §11 for what's still deferred (libp2p gossip mesh, attestor signature
 * gathering for slash()).
 */
export const name = "broadcaster" as const;

export function ready(): boolean {
  return true;
}

export * from "./types";
export * from "./assignment";
export * from "./node";
export * from "./http";
