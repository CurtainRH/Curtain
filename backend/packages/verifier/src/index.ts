/**
 * @curtain/verifier — Receipt, disclosure, and solvency proof verification library
 */
export const name = "verifier" as const;

export function ready(): boolean {
  return true;
}

export * from "./solvency-verifier";
export * from "./disclosure-verifier";
