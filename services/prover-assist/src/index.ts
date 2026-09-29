/**
 * @curtain/prover-assist — TEE-attested mobile proving assist (blinded witness in, Groth16 proof out)
 * Milestone: M0 scaffold. Implementation lands in later milestones per Curtain_Build.md.
 */
export const name = "prover-assist" as const;

export function ready(): boolean {
  return true;
}
