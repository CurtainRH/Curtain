/**
 * @curtain/prover-assist — TEE-attested mobile proving assist (blinded witness in, Groth16 proof out)
 * M8: attestation (mock TDX — see attestation.ts's header), ECIES witness
 * encryption, enclave session lifecycle (decrypt -> prove -> discard), and
 * the POST /prove/{circuit} + GET /attestation HTTP surface. See
 * Curtain_Build.md §11 for what real TDX hardware would replace.
 */
export const name = "prover-assist" as const;

export function ready(): boolean {
  return true;
}

export * from "./attestation";
export * from "./crypto";
export * from "./enclave";
export * from "./prover";
export * from "./server";
