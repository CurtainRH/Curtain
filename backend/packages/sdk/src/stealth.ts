/**
 * ERC-5564/6538 stealth addresses — scheme id 1 (secp256k1 with view tags),
 * per Curtain_Build.md §1 and §5. These keys are separate from the Baby
 * Jubjub note-spending keys used by the ZK pool (M2+); this module only
 * covers the v0 stealth-receive flow.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { publicKeyToAddress } from "viem/accounts";
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";

/** Curve order (n) for secp256k1 — scalars are reduced mod this. */
const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

/** ERC-5564 scheme id for "secp256k1 with view tags", the only scheme Curtain supports. */
export const SCHEME_ID = 1n;

export interface StealthKeys {
  spendingPrivateKey: Hex;
  spendingPublicKey: Hex; // compressed, 33 bytes
  viewingPrivateKey: Hex;
  viewingPublicKey: Hex; // compressed, 33 bytes
}

export interface MetaAddress {
  spendingPublicKey: Hex; // compressed, 33 bytes
  viewingPublicKey: Hex; // compressed, 33 bytes
}

export interface StealthPayment {
  stealthAddress: Address;
  ephemeralPublicKey: Hex; // compressed, 33 bytes — published in the announcement
  viewTag: number; // 0-255 — published as announcement metadata for fast scanning
}

export interface ScanResult {
  isMatch: boolean;
  stealthAddress?: Address;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(bytesToHex(bytes));
}

function scalarModN(bytes: Uint8Array): bigint {
  return bytesToBigInt(bytes) % CURVE_ORDER;
}

/** Hashes an ECDH shared point into the scalar `s` used to tweak keys, per ERC-5564. */
function sharedSecretScalar(sharedPointCompressed: Uint8Array): { s: bigint; viewTag: number } {
  const hash = hexToBytes(keccak256(sharedPointCompressed));
  return { s: scalarModN(hash), viewTag: hash[0]! };
}

function stealthPublicKeyFrom(spendingPublicKey: Hex, s: bigint): Uint8Array {
  const spendPoint = secp256k1.Point.fromBytes(hexToBytes(spendingPublicKey));
  const tweakPoint = secp256k1.Point.BASE.multiply(s);
  return spendPoint.add(tweakPoint).toBytes(false); // uncompressed, for address derivation
}

/** Generates a fresh spending/viewing keypair and encodes the ERC-6538 meta-address. */
export function generateStealthKeys(): StealthKeys {
  const spendingSk = secp256k1.utils.randomSecretKey();
  const viewingSk = secp256k1.utils.randomSecretKey();
  return {
    spendingPrivateKey: bytesToHex(spendingSk),
    spendingPublicKey: bytesToHex(secp256k1.getPublicKey(spendingSk, true)),
    viewingPrivateKey: bytesToHex(viewingSk),
    viewingPublicKey: bytesToHex(secp256k1.getPublicKey(viewingSk, true)),
  };
}

/** Encodes a meta-address as `spendingPublicKey ‖ viewingPublicKey` (66 bytes), per Curtain_Build.md §1. */
export function encodeMetaAddress(meta: MetaAddress): Hex {
  const spend = hexToBytes(meta.spendingPublicKey);
  const view = hexToBytes(meta.viewingPublicKey);
  if (spend.length !== 33 || view.length !== 33) {
    throw new Error("stealth: expected 33-byte compressed secp256k1 public keys");
  }
  const out = new Uint8Array(66);
  out.set(spend, 0);
  out.set(view, 33);
  return bytesToHex(out);
}

export function decodeMetaAddress(metaAddress: Hex): MetaAddress {
  const bytes = hexToBytes(metaAddress);
  if (bytes.length !== 66) {
    throw new Error("stealth: invalid meta-address length, expected 66 bytes");
  }
  return {
    spendingPublicKey: bytesToHex(bytes.slice(0, 33)),
    viewingPublicKey: bytesToHex(bytes.slice(33, 66)),
  };
}

/**
 * Sender side. Given the recipient's meta-address, derives a fresh one-time
 * stealth address, the ephemeral public key to announce, and the view tag
 * recipients use to filter announcements cheaply before doing EC math.
 */
export function generateStealthAddress(metaAddress: Hex): StealthPayment {
  const { spendingPublicKey, viewingPublicKey } = decodeMetaAddress(metaAddress);

  const ephemeralSk = secp256k1.utils.randomSecretKey();
  const ephemeralPublicKey = secp256k1.getPublicKey(ephemeralSk, true);

  const sharedPoint = secp256k1.getSharedSecret(ephemeralSk, hexToBytes(viewingPublicKey), true);
  const { s, viewTag } = sharedSecretScalar(sharedPoint);

  const stealthPubKey = stealthPublicKeyFrom(spendingPublicKey, s);

  return {
    stealthAddress: publicKeyToAddress(bytesToHex(stealthPubKey)),
    ephemeralPublicKey: bytesToHex(ephemeralPublicKey),
    viewTag,
  };
}

/**
 * Recipient side. Checks one announcement's view tag against this account's
 * viewing key without the full EC math on a mismatch (the fast path ERC-5564
 * view tags exist for), then computes the stealth address on a match so the
 * caller can confirm it against the announced `stealthAddress`.
 */
export function checkStealthAnnouncement(params: {
  ephemeralPublicKey: Hex;
  viewTag: number;
  spendingPublicKey: Hex;
  viewingPrivateKey: Hex;
}): ScanResult {
  const sharedPoint = secp256k1.getSharedSecret(
    hexToBytes(params.viewingPrivateKey),
    hexToBytes(params.ephemeralPublicKey),
    true,
  );
  const { s, viewTag } = sharedSecretScalar(sharedPoint);

  if (viewTag !== params.viewTag) {
    return { isMatch: false };
  }

  const stealthPubKey = stealthPublicKeyFrom(params.spendingPublicKey, s);
  return { isMatch: true, stealthAddress: publicKeyToAddress(bytesToHex(stealthPubKey)) };
}

/**
 * Recipient side. Derives the one-time private key that controls a matched
 * stealth address, so its balance can be swept. `stealthPrivateKey =
 * spendingPrivateKey + s (mod n)`, mirroring how the stealth public key was
 * built as `spendingPublicKey + s*G`.
 */
export function computeStealthPrivateKey(params: {
  ephemeralPublicKey: Hex;
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
}): Hex {
  const sharedPoint = secp256k1.getSharedSecret(
    hexToBytes(params.viewingPrivateKey),
    hexToBytes(params.ephemeralPublicKey),
    true,
  );
  const { s } = sharedSecretScalar(sharedPoint);

  const spendingScalar = scalarModN(hexToBytes(params.spendingPrivateKey));
  const stealthScalar = (spendingScalar + s) % CURVE_ORDER;

  return `0x${stealthScalar.toString(16).padStart(64, "0")}` as Hex;
}

/** Encodes the announcement metadata byte for scheme 1: just the view tag. */
export function encodeViewTagMetadata(viewTag: number): Hex {
  if (viewTag < 0 || viewTag > 255) throw new Error("stealth: viewTag must be a single byte");
  return `0x${viewTag.toString(16).padStart(2, "0")}` as Hex;
}

export function decodeViewTagMetadata(metadata: Hex): number {
  const bytes = hexToBytes(metadata);
  if (bytes.length < 1) throw new Error("stealth: metadata missing view tag byte");
  return bytes[0]!;
}
