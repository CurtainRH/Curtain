/**
 * Disclosure grant verification functions for @curtain/verifier.
 */

export interface DisclosureGrantRecord {
  grantId: string;
  granter: string;
  scopeHash: string;
  viewerEk: string;
  encryptedVk: string;
  until: number;
  revoked: boolean;
}

/**
 * Checks if a disclosure grant is currently active and unexpired.
 */
export function isGrantValid(grant: DisclosureGrantRecord, currentTimestamp: number = Math.floor(Date.now() / 1000)): boolean {
  if (!grant || grant.revoked) return false;
  if (!grant.granter || grant.granter === "0x0000000000000000000000000000000000000000") return false;
  if (grant.until !== 0 && currentTimestamp > grant.until) return false;
  return true;
}
