import { describe, expect, it } from "bun:test";
import { privateKeyToAddress } from "viem/accounts";
import {
  checkStealthAnnouncement,
  computeStealthPrivateKey,
  decodeMetaAddress,
  decodeViewTagMetadata,
  encodeMetaAddress,
  encodeViewTagMetadata,
  generateStealthAddress,
  generateStealthKeys,
} from "../src/stealth";

describe("stealth (ERC-5564/6538, scheme id 1)", () => {
  it("round-trips a meta-address through encode/decode", () => {
    const keys = generateStealthKeys();
    const encoded = encodeMetaAddress(keys);
    expect(encoded.length).toBe(2 + 66 * 2); // 0x + 66 bytes hex

    const decoded = decodeMetaAddress(encoded);
    expect(decoded.spendingPublicKey).toBe(keys.spendingPublicKey);
    expect(decoded.viewingPublicKey).toBe(keys.viewingPublicKey);
  });

  it("rejects a malformed meta-address length", () => {
    expect(() => decodeMetaAddress("0x1234")).toThrow();
  });

  it("full flow: sender resolves, recipient scans and recovers the spending key", () => {
    const recipient = generateStealthKeys();
    const metaAddress = encodeMetaAddress(recipient);

    const payment = generateStealthAddress(metaAddress);
    expect(payment.stealthAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(payment.viewTag).toBeGreaterThanOrEqual(0);
    expect(payment.viewTag).toBeLessThanOrEqual(255);

    const scan = checkStealthAnnouncement({
      ephemeralPublicKey: payment.ephemeralPublicKey,
      viewTag: payment.viewTag,
      spendingPublicKey: recipient.spendingPublicKey,
      viewingPrivateKey: recipient.viewingPrivateKey,
    });
    expect(scan.isMatch).toBe(true);
    expect(scan.stealthAddress).toBe(payment.stealthAddress);

    const stealthPrivateKey = computeStealthPrivateKey({
      ephemeralPublicKey: payment.ephemeralPublicKey,
      spendingPrivateKey: recipient.spendingPrivateKey,
      viewingPrivateKey: recipient.viewingPrivateKey,
    });

    // The recovered private key must independently derive the same address —
    // this is the property that actually lets the recipient sweep funds.
    expect(privateKeyToAddress(stealthPrivateKey)).toBe(payment.stealthAddress);
  });

  it("a third party's viewing key does not match another recipient's announcement", () => {
    const recipient = generateStealthKeys();
    const eavesdropper = generateStealthKeys();
    const metaAddress = encodeMetaAddress(recipient);

    const payment = generateStealthAddress(metaAddress);

    const scan = checkStealthAnnouncement({
      ephemeralPublicKey: payment.ephemeralPublicKey,
      viewTag: payment.viewTag,
      spendingPublicKey: recipient.spendingPublicKey,
      viewingPrivateKey: eavesdropper.viewingPrivateKey,
    });

    expect(scan.isMatch).toBe(false);
  });

  it("produces a different stealth address on every payment to the same meta-address", () => {
    const recipient = generateStealthKeys();
    const metaAddress = encodeMetaAddress(recipient);

    const first = generateStealthAddress(metaAddress);
    const second = generateStealthAddress(metaAddress);

    expect(first.stealthAddress).not.toBe(second.stealthAddress);
    expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey);
  });

  it("round-trips the view tag metadata byte", () => {
    for (const tag of [0, 1, 128, 255]) {
      expect(decodeViewTagMetadata(encodeViewTagMetadata(tag))).toBe(tag);
    }
    expect(() => encodeViewTagMetadata(256)).toThrow();
    expect(() => encodeViewTagMetadata(-1)).toThrow();
  });
});
