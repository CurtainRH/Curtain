/**
 * @curtain/indexer — Indexes on-chain Curtain events into Postgres for api/status
 * Milestone: M0 scaffold. Implementation lands in later milestones per Curtain_Build.md.
 */
export const name = "indexer" as const;

export function ready(): boolean {
  return true;
}
