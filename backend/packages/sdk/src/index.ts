/// <reference path="./types/untyped-modules.d.ts" />
/**
 * @curtain/sdk — Wallet SDK: keys, notes, encryption, proving (wasm + assist), recipes runner
 * Milestone: M0 scaffold. Implementation lands in later milestones per Curtain_Build.md.
 */
export const name = "sdk" as const;

export function ready(): boolean {
  return true;
}

export * from "./stealth";
export * from "./keys";
export * from "./notes";
export * from "./tree";
// `proveGroth16` (./prover.ts) is deliberately NOT re-exported here as a value — it's a
// Node-only local prover (spawns a subprocess) that must never end up in a browser bundle's
// module graph, even as dead code (see prover-backend.ts's header: a browser build that
// never calls it can still break at load time if a bundler tries to resolve its `node:*`
// imports). Its type is still exported for callers that just need to type-annotate a
// Groth16Proof value. Callers that specifically want the Node-only local prover function can
// import it directly from "@curtain/sdk/src/prover" (desktop/CLI/test contexts only).
export type { Groth16Proof } from "./prover";
export * from "./prover-backend";
export * from "./pool-client";
export * from "./disclosure";
export * from "./staking";
