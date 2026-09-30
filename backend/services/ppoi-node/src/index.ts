/**
 * @curtain/ppoi-node — Builds blinded non-membership PPOI proofs against provider lists, calls ppoiVerify
 * Milestone: M0 scaffold. Implementation lands in later milestones per Curtain_Build.md.
 */
export const name = "ppoi-node" as const;

export function ready(): boolean {
  return true;
}
