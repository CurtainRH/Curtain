/**
 * The "enclave" session: a fresh ephemeral keypair per session, attested
 * once, used to decrypt exactly the witnesses sent against it, then
 * rotated. Real TDX would generate this keypair inside hardware-protected
 * memory the host OS/operator can't read; here it's plain process memory —
 * see attestation.ts's header for the full real-vs-mock breakdown.
 *
 * "server discards witness after proof" (Curtain_Build.md §4.3): every
 * decrypted witness is held only for the duration of proof generation and
 * explicitly zeroed immediately after, win or lose — see `withWitness`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createAttestation, toHex, type AttestationDocument, type Hex } from "./attestation";
import { decryptFromClient, type EncryptedPayload } from "./crypto";

export class EnclaveSession {
  private privateKey: Uint8Array;
  public readonly publicKey: Hex;
  public readonly attestation: AttestationDocument;

  constructor() {
    this.privateKey = secp256k1.utils.randomSecretKey();
    this.publicKey = toHex(secp256k1.getPublicKey(this.privateKey, true));
    this.attestation = createAttestation(this.publicKey);
  }

  /**
   * Decrypts `payload`, runs `fn` with the plaintext witness bytes, then
   * zeroes the decrypted buffer — regardless of whether `fn` succeeds or
   * throws. `fn` must not retain a reference to its argument past return.
   */
  async withWitness<T>(payload: EncryptedPayload, fn: (witness: Uint8Array) => Promise<T>): Promise<T> {
    const witness = decryptFromClient(this.privateKey, payload);
    try {
      return await fn(witness);
    } finally {
      witness.fill(0);
    }
  }

  /** Ends this session — the ephemeral key is discarded, so any later message encrypted to it can never be decrypted. */
  destroy(): void {
    this.privateKey.fill(0);
  }
}
