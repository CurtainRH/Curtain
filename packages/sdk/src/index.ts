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
export * from "./prover";
export * from "./pool-client";
export * from "./disclosure";
export * from "./staking";
