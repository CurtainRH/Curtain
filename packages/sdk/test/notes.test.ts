import { describe, expect, it } from "bun:test";
import { generateWalletKeys } from "../src/keys";
import { computeCommitment, computeNullifier, encryptNoteTo, tryDecryptNote } from "../src/notes";

describe("notes (commitment/nullifier formulas, ECDH note encryption)", () => {
  it("computeCommitment matches CurtainPool.sol's Poseidon(tokenId, rawAmount, ownerPkX, blinding) shape (order-sensitive)", async () => {
    const a = await computeCommitment({ tokenId: 1n, rawAmount: 2n, ownerPkX: 3n, blinding: 4n });
    const b = await computeCommitment({ tokenId: 1n, rawAmount: 2n, ownerPkX: 3n, blinding: 5n });
    expect(a).not.toBe(b); // blinding actually affects the commitment
    const c = await computeCommitment({ tokenId: 4n, rawAmount: 3n, ownerPkX: 2n, blinding: 1n });
    expect(a).not.toBe(c); // argument order matters (not commutative)
  });

  it("computeNullifier is deterministic and leaf-index-sensitive", async () => {
    const n0 = await computeNullifier(42n, 0);
    const n1 = await computeNullifier(42n, 1);
    const n0Again = await computeNullifier(42n, 0);
    expect(n0).toBe(n0Again);
    expect(n0).not.toBe(n1);
  });

  it("round-trips a note through encryptNoteTo/tryDecryptNote", async () => {
    const { keys } = await generateWalletKeys();
    const plaintext = { tokenId: 111n, rawAmount: 5_000_000_000_000_000_000n, blinding: 999999n };

    const { ephemeralPk, ct } = await encryptNoteTo(keys.ekX, keys.ekY, plaintext);
    const decrypted = await tryDecryptNote(keys, ephemeralPk, ct);

    expect(decrypted).toEqual(plaintext);
  });

  it("fails to decrypt (returns undefined) with the wrong wallet's viewing key", async () => {
    const { keys: recipient } = await generateWalletKeys();
    const { keys: attacker } = await generateWalletKeys();
    const plaintext = { tokenId: 1n, rawAmount: 1n, blinding: 1n };

    const { ephemeralPk, ct } = await encryptNoteTo(recipient.ekX, recipient.ekY, plaintext);
    const decrypted = await tryDecryptNote(attacker, ephemeralPk, ct);

    expect(decrypted).toBeUndefined();
  });

  it("does not throw on malformed ephemeralPk/ct input (defensive scan of untrusted event data)", async () => {
    const { keys } = await generateWalletKeys();
    await expect(tryDecryptNote(keys, "0x1234", "0x5678")).resolves.toBeUndefined();
  });
});
