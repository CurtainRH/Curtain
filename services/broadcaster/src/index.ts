/**
 * @curtain/broadcaster — Waku-style relay listener: validates bundles, pays gas, submits, publishes fee schedule
 * Milestone: M0 scaffold. Implementation lands in later milestones per Curtain_Build.md.
 */
export const name = "broadcaster" as const;

export function ready(): boolean {
  return true;
}
