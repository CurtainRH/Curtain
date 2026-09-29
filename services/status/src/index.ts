/**
 * @curtain/status — Public status page: provider freshness, standby state, solvency, broadcaster uptime
 * Milestone: M0 scaffold. Implementation lands in later milestones per Curtain_Build.md.
 */
export const name = "status" as const;

export function ready(): boolean {
  return true;
}
