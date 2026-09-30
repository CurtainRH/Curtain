import { describe, expect, it } from "bun:test";
import { createDisclosureGrant, decryptGrantedViewingKey, deriveWalletKeys } from "../src/index";

describe("Disclosure grants (SDK)", () => {
  it("creates and decrypts a viewing key grant for an auditor", async () => {
    // Owner wallet
    const ownerSeed = new Uint8Array(32);
    ownerSeed.fill(1);
    const ownerKeys = await deriveWalletKeys(ownerSeed);

    // Auditor wallet
    const auditorSeed = new Uint8Array(32);
    auditorSeed.fill(2);
    const auditorKeys = await deriveWalletKeys(auditorSeed);

    // Owner grants viewing key for "SCOPE_TAX_2026"
    const grant = await createDisclosureGrant({
      scope: "SCOPE_TAX_2026",
      viewingKey: ownerKeys.vk,
      viewerEkX: auditorKeys.ekX,
      viewerEkY: auditorKeys.ekY,
      until: 1000n,
    });

    expect(grant.until).toBe(1000n);
    expect(grant.scopeHash).toBeDefined();

    // Auditor decrypts viewing key using auditor's spending key (used as viewerSk)
    const decryptedVk = await decryptGrantedViewingKey(
      auditorKeys.vk,
      grant.viewerEk,
      grant.encryptedVk
    );

    expect(decryptedVk).toBe(ownerKeys.vk);
  });

  it("fails to decrypt with a different wallet's key", async () => {
    const ownerSeed = new Uint8Array(32);
    ownerSeed.fill(1);
    const ownerKeys = await deriveWalletKeys(ownerSeed);

    const auditorSeed = new Uint8Array(32);
    auditorSeed.fill(2);
    const auditorKeys = await deriveWalletKeys(auditorSeed);

    const wrongSeed = new Uint8Array(32);
    wrongSeed.fill(3);
    const wrongKeys = await deriveWalletKeys(wrongSeed);

    const grant = await createDisclosureGrant({
      scope: "SCOPE_TAX_2026",
      viewingKey: ownerKeys.vk,
      viewerEkX: auditorKeys.ekX,
      viewerEkY: auditorKeys.ekY,
    });

    const decryptedVk = await decryptGrantedViewingKey(
      wrongKeys.sk,
      grant.viewerEk,
      grant.encryptedVk
    );

    expect(decryptedVk).toBeUndefined();
  });
});
