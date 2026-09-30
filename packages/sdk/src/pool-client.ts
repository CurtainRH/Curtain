/**
 * Wallet-side CurtainPool client: shield, send (join-split), unshieldToOrigin,
 * and note sync — the API surface Curtain_Build.md §5 describes. The
 * contract exposes no "give me a leaf's Merkle path" view, so this class
 * reconstructs mainTree/clearedTree locally from on-chain events (see
 * tree.ts) exactly the way CurtainPool.sol builds them itself.
 *
 * Scope note (M5): `send` supports only the 2-in-2-out arity (the common
 * case: two owned input notes, one payment output + one change output).
 * 3-in-3-out is wired identically in the contract/circuit but not exposed
 * here yet — left for whenever a real coin-selection/consolidation flow is
 * needed. `sync` also only recovers notes from directly-observed
 * NoteCiphertext events within the scanned block range; it doesn't yet
 * track clearedTree leaf indices for notes received via transact() outputs
 * (CurtainPool.sol never emits an event for those, only for markCleared() —
 * see Curtain_Build.md §11 item 11) — such a note can be held and its
 * balance shown, but not yet re-spent as a join-split input by this client.
 */
import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { encodeAbiParameters, encodePacked, keccak256, parseAbiParameters } from "viem";
import { getPoseidon, type WalletKeys } from "./keys";
import { computeCommitment, computeNullifier, encryptNoteTo, tryDecryptNote, type Note } from "./notes";
import { LocalMerkleTree, MERKLE_DEPTH } from "./tree";
import { proveGroth16 } from "./prover";

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface CircuitPaths {
  wasm: string;
  zkey: string;
}

export interface CurtainWalletConfig {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  poolAddress: Address;
  poolAbi: Abi;
  keys: WalletKeys;
  joinsplit2x2: CircuitPaths;
  unshield: CircuitPaths;
  /** RelayAdapt's address/ABI — only required if `relay()` is used. */
  relayAddress?: Address;
  relayAbi?: Abi;
}

/** A single call RelayAdapt.relay() will execute against an allowlisted target — from `@curtain/recipes`'s `buildRelay(recipe).calls`. */
export interface RelayCall {
  to: Address;
  value: bigint;
  data: Hex;
}

/** One reshielded output a relay produces — where it should land and who owns it. */
export interface RelayOutputSpec {
  token: Address;
  /** The expected amount of `token` this leg of the recipe will actually produce — used to build the self-encrypted note ciphertext (see this file's header on shield()'s identical amount-must-match-reality constraint). */
  expectedAmount: bigint;
  /** Reverts on-chain if the relay produces less than this — from `@curtain/recipes`'s `TokenSpec.minOut`. */
  minOut: bigint;
  toEkX: bigint;
  toEkY: bigint;
  toPkX: bigint;
}

export interface OwnedNote extends Note {
  clearedLeafIndex?: number;
}

export function tokenIdOf(token: Address): bigint {
  const hash = keccak256(encodePacked(["address"], [token]));
  return BigInt(hash) % FIELD_SIZE;
}

export class CurtainWallet {
  constructor(private cfg: CurtainWalletConfig) {}

  /** Deposits `rawAmount` of `token`, self-encrypting the note for later recovery via sync(). */
  async shield(token: Address, rawAmount: bigint): Promise<OwnedNote> {
    const { publicClient, walletClient, account, poolAddress, poolAbi, keys } = this.cfg;
    const tokenId = tokenIdOf(token);
    const blinding = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + 1n;

    // CurtainPool.shield() commits to the NET deposit (post shield-fee), not
    // the raw amount passed in — the note's encrypted plaintext (and the
    // OwnedNote this method returns) must match that exactly, or sync()'s
    // commitment recheck will never match and silently drop the note.
    const feeBpsShield = (await publicClient.readContract({ address: poolAddress, abi: poolAbi, functionName: "feeBpsShield" })) as number;
    const netAmount = rawAmount - (rawAmount * BigInt(feeBpsShield)) / 10000n;

    const { ephemeralPk, ct } = await encryptNoteTo(keys.ekX, keys.ekY, { tokenId, rawAmount: netAmount, blinding });

    const hash = await walletClient.writeContract({
      chain: walletClient.chain,
      account,
      address: poolAddress,
      abi: poolAbi,
      functionName: "shield",
      args: [token, rawAmount, keys.pkX, blinding, ephemeralPk, ct],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("shield: transaction reverted");

    const shieldLog = (
      await publicClient.getContractEvents({
        address: poolAddress,
        abi: poolAbi,
        eventName: "Shield",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      })
    ).find((l) => l.transactionHash === hash);
    if (!shieldLog) throw new Error("shield: Shield event not found in receipt block");
    const { commit, leafIndex } = shieldLog.args as { commit: Hex; leafIndex: number };

    return { tokenId, rawAmount: netAmount, ownerPkX: keys.pkX, blinding, leafIndex, commit: BigInt(commit) };
  }

  /** Permissionless: moves a shielded note into clearedTree once ScreeningGate confirms it spendable. */
  async markCleared(commit: bigint): Promise<number> {
    const { publicClient, walletClient, account, poolAddress, poolAbi } = this.cfg;
    const hash = await walletClient.writeContract({
      chain: walletClient.chain,
      account,
      address: poolAddress,
      abi: poolAbi,
      functionName: "markCleared",
      args: [`0x${commit.toString(16).padStart(64, "0")}` as Hex],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("markCleared: transaction reverted");
    const log = (
      await publicClient.getContractEvents({
        address: poolAddress,
        abi: poolAbi,
        eventName: "MarkedCleared",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      })
    ).find((l) => l.transactionHash === hash);
    if (!log) throw new Error("markCleared: MarkedCleared event not found in receipt block");
    return (log.args as { clearedLeafIndex: number }).clearedLeafIndex;
  }

  /** Scans Shield + NoteCiphertext + MarkedCleared events and returns notes this wallet can decrypt. */
  async sync(fromBlock: bigint = 0n): Promise<OwnedNote[]> {
    const { publicClient, poolAddress, poolAbi, keys } = this.cfg;

    const toBlock = await publicClient.getBlockNumber();
    const [shieldLogs, ciphertextLogs, clearedLogs] = await Promise.all([
      publicClient.getContractEvents({ address: poolAddress, abi: poolAbi, eventName: "Shield", fromBlock, toBlock }),
      publicClient.getContractEvents({ address: poolAddress, abi: poolAbi, eventName: "NoteCiphertext", fromBlock, toBlock }),
      publicClient.getContractEvents({ address: poolAddress, abi: poolAbi, eventName: "MarkedCleared", fromBlock, toBlock }),
    ]);

    const leafIndexByCommit = new Map<string, number>();
    for (const log of shieldLogs) {
      const { commit, leafIndex } = log.args as { commit: Hex; leafIndex: number };
      leafIndexByCommit.set(commit.toLowerCase(), leafIndex);
    }
    const clearedLeafIndexByCommit = new Map<string, number>();
    for (const log of clearedLogs) {
      const { commit, clearedLeafIndex } = log.args as { commit: Hex; clearedLeafIndex: number };
      clearedLeafIndexByCommit.set(commit.toLowerCase(), clearedLeafIndex);
    }

    const notes: OwnedNote[] = [];
    for (const log of ciphertextLogs) {
      const { commit, ephemeralPk, ct } = log.args as { commit: Hex; ephemeralPk: Hex; ct: Hex };
      const plaintext = await tryDecryptNote(keys, ephemeralPk, ct);
      if (!plaintext) continue;

      const recomputed = await computeCommitment({ tokenId: plaintext.tokenId, rawAmount: plaintext.rawAmount, ownerPkX: keys.pkX, blinding: plaintext.blinding });
      if (`0x${recomputed.toString(16).padStart(64, "0")}` !== commit.toLowerCase()) continue; // decrypted, but not addressed to our spending key

      notes.push({
        tokenId: plaintext.tokenId,
        rawAmount: plaintext.rawAmount,
        ownerPkX: keys.pkX,
        blinding: plaintext.blinding,
        commit: BigInt(commit),
        leafIndex: leafIndexByCommit.get(commit.toLowerCase()),
        clearedLeafIndex: clearedLeafIndexByCommit.get(commit.toLowerCase()),
      });
    }
    return notes;
  }

  /** Rebuilds mainTree/clearedTree locally from Shield/Transact/MarkedCleared events, for proof generation. */
  private async buildTrees(): Promise<{ mainTree: LocalMerkleTree; clearedTree: LocalMerkleTree }> {
    const { publicClient, poolAddress, poolAbi } = this.cfg;
    const poseidon = await getPoseidon();
    const F = poseidon.F;
    const hash2 = (a: bigint, b: bigint) => F.toObject(poseidon([a, b])) as bigint;

    const mainTree = new LocalMerkleTree(hash2, MERKLE_DEPTH);
    const clearedTree = new LocalMerkleTree(hash2, MERKLE_DEPTH);
    await mainTree.init();
    await clearedTree.init();

    const toBlock = await publicClient.getBlockNumber(); // pinned explicitly rather than "latest" for a stable, reproducible query
    const [shieldLogs, clearedLogs] = await Promise.all([
      publicClient.getContractEvents({ address: poolAddress, abi: poolAbi, eventName: "Shield", fromBlock: 0n, toBlock }),
      publicClient.getContractEvents({ address: poolAddress, abi: poolAbi, eventName: "MarkedCleared", fromBlock: 0n, toBlock }),
    ]);
    for (const log of shieldLogs) {
      const { commit, leafIndex } = log.args as { commit: Hex; leafIndex: number };
      mainTree.insert(leafIndex, BigInt(commit));
    }
    for (const log of clearedLogs) {
      const { commit, clearedLeafIndex } = log.args as { commit: Hex; clearedLeafIndex: number };
      clearedTree.insert(clearedLeafIndex, BigInt(commit));
    }
    // Transact() outputs also insert into both trees; not replayed here since
    // this client's send() only spends shield-then-markCleared notes (see
    // this file's header) — a future consolidation flow would need to walk
    // Transact events too, in (blockNumber, logIndex) order, to recover
    // those leaf indices.
    return { mainTree, clearedTree };
  }

  /** Spends exactly 2 owned, cleared notes and creates exactly 2 new notes (payment + change). 2-in-2-out only — see this file's header. */
  async send(
    token: Address,
    inputs: [OwnedNote, OwnedNote],
    outputs: [{ toEkX: bigint; toEkY: bigint; toPkX: bigint; amount: bigint }, { toEkX: bigint; toEkY: bigint; toPkX: bigint; amount: bigint }],
  ): Promise<void> {
    const { publicClient, walletClient, account, poolAddress, poolAbi, keys, joinsplit2x2 } = this.cfg;
    const tokenId = tokenIdOf(token);

    for (const n of inputs) {
      if (n.leafIndex === undefined) throw new Error("send: input note has no known leafIndex (must come from a Shield event)");
      if (n.clearedLeafIndex === undefined) throw new Error("send: input note has not been markCleared()'d yet");
    }
    const sumIn = inputs[0].rawAmount + inputs[1].rawAmount;
    const sumOut = outputs[0].amount + outputs[1].amount;
    if (sumIn !== sumOut) throw new Error(`send: conservation violated (in=${sumIn}, out=${sumOut})`);

    const { mainTree, clearedTree } = await this.buildTrees();
    const root = await mainTree.root();
    const clearedRoot = await clearedTree.root();

    const nullifiers = await Promise.all(inputs.map((n) => computeNullifier(keys.sk, n.leafIndex!)));
    const blindings = outputs.map(() => BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + 1n);
    const realCommitments = await Promise.all(
      outputs.map((o, j) => computeCommitment({ tokenId, rawAmount: o.amount, ownerPkX: o.toPkX, blinding: blindings[j]! })),
    );

    const inPaths = await Promise.all(inputs.map((n) => mainTree.pathTo(n.leafIndex!)));
    const inClearedPaths = await Promise.all(inputs.map((n) => clearedTree.pathTo(n.clearedLeafIndex!)));

    // Must match CurtainPool.sol's `_extDataHash` exactly (keccak256(abi.encode(
    // unshieldTo, unshieldAmount, feeAmount)) % FIELD_SIZE) — the contract
    // recomputes this itself and feeds it into the SAME public-signal slot the
    // circuit committed to, so a mismatch here makes an otherwise-valid proof
    // fail verification on-chain (it still passes an isolated snarkjs.verify()
    // check, since that only checks internal consistency, not this binding).
    const zeroAddress: Address = "0x0000000000000000000000000000000000000000";
    const extDataHash = BigInt(keccak256(encodeAbiParameters(parseAbiParameters("address, uint256, uint256"), [zeroAddress, 0n, 0n]))) % FIELD_SIZE;

    const circuitInput = {
      root: root.toString(),
      clearedRoot: clearedRoot.toString(),
      nullifiers: nullifiers.map(String),
      newCommitments: realCommitments.map(String),
      tokenId: tokenId.toString(),
      unshieldAmount: "0",
      unshieldTo: "0",
      feeAmount: "0",
      extDataHash: extDataHash.toString(),
      inAmount: inputs.map((n) => n.rawAmount.toString()),
      inBlinding: inputs.map((n) => n.blinding.toString()),
      inLeafIndex: inputs.map((n) => n.leafIndex!.toString()),
      inOwnerSk: inputs.map(() => keys.sk.toString()),
      inPathElements: inPaths.map((p) => p.pathElements.map(String)),
      inPathIndices: inPaths.map((p) => p.pathIndices),
      inClearedPathElements: inClearedPaths.map((p) => p.pathElements.map(String)),
      inClearedPathIndices: inClearedPaths.map((p) => p.pathIndices),
      outAmount: outputs.map((o) => o.amount.toString()),
      outBlinding: blindings.map(String),
      outOwnerPkX: outputs.map((o) => o.toPkX.toString()),
    };

    const { a, b, c } = await proveGroth16(circuitInput, joinsplit2x2.wasm, joinsplit2x2.zkey);

    const ciphertexts = await Promise.all(
      outputs.map((o, j) => encryptNoteTo(o.toEkX, o.toEkY, { tokenId, rawAmount: o.amount, blinding: blindings[j]! })),
    );

    const proofBytes = encodeGroth16Proof(a, b, c);
    const args = {
      proof: proofBytes,
      token,
      root: `0x${root.toString(16).padStart(64, "0")}` as Hex,
      clearedRoot: `0x${clearedRoot.toString(16).padStart(64, "0")}` as Hex,
      nullifiers: nullifiers.map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex),
      newCommits: realCommitments.map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex),
      unshieldTo: "0x0000000000000000000000000000000000000000" as Address,
      unshieldAmount: 0n,
      feeAmount: 0n,
      ephemeralPks: ciphertexts.map((c) => c.ephemeralPk),
      cts: ciphertexts.map((c) => c.ct),
    };

    const hash = await walletClient.writeContract({
      chain: walletClient.chain,
      account,
      address: poolAddress,
      abi: poolAbi,
      functionName: "transact",
      args: [args],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("send: transact() reverted");
  }

  /**
   * Spends 2 owned, cleared notes through RelayAdapt.relay(): unshields `unshieldAmount` of
   * `token` to RelayAdapt via a real join-split proof (the exact same 2x2 circuit/proving
   * path `send()` already uses — RelayAdapt.relay() just requires `unshieldTo ===
   * RelayAdapt`'s own address; there is no separate "relay circuit"), then lets RelayAdapt
   * run `calls` (from `@curtain/recipes`'s `buildRelay(recipe)`) and reshield the results.
   *
   * `changeAmount` (sumIn - unshieldAmount) becomes a real join-split output note owned by
   * this wallet if positive, encrypted the same way `send()`'s change output is; if the
   * entire input is sent through the relay, both join-split outputs are zero-value dummy
   * notes (valid per joinsplit.circom's conservation check — there's no lower bound on
   * `outAmount`, only the standard 128-bit range check every note commitment already gets).
   *
   * Reshielded outputs land back in the pool via CurtainPool.reshield() (called by
   * RelayAdapt, not this method) and are `sync()`-recoverable exactly like a plain shield()
   * note — no special-case detection needed on this class's side.
   */
  async relay(
    token: Address,
    inputs: [OwnedNote, OwnedNote],
    unshieldAmount: bigint,
    relayCalls: RelayCall[],
    reshieldOutputs: RelayOutputSpec[],
    origin: Address,
  ): Promise<void> {
    const { publicClient, walletClient, account, poolAbi, keys, joinsplit2x2, relayAddress, relayAbi } = this.cfg;
    if (!relayAddress || !relayAbi) throw new Error("relay: CurtainWalletConfig.relayAddress/relayAbi must be set to use relay()");

    for (const n of inputs) {
      if (n.leafIndex === undefined) throw new Error("relay: input note has no known leafIndex (must come from a Shield event)");
      if (n.clearedLeafIndex === undefined) throw new Error("relay: input note has not been markCleared()'d yet");
    }
    const tokenId = tokenIdOf(token);
    const sumIn = inputs[0].rawAmount + inputs[1].rawAmount;
    if (unshieldAmount > sumIn) throw new Error(`relay: unshieldAmount (${unshieldAmount}) exceeds input notes' total (${sumIn})`);
    const changeAmount = sumIn - unshieldAmount;

    // Verify every call target is actually allowlisted before spending gas on a proof —
    // RelayAdapt would revert with TargetNotAllowed anyway, but only after the unshield leg
    // already executed (pool.transact runs before the calls loop in relay()).
    for (const call of relayCalls) {
      const allowed = (await publicClient.readContract({ address: relayAddress, abi: relayAbi, functionName: "allowedTarget", args: [call.to] })) as boolean;
      if (!allowed) throw new Error(`relay: target ${call.to} is not allowlisted on RelayAdapt`);
    }

    const { mainTree, clearedTree } = await this.buildTrees();
    const root = await mainTree.root();
    const clearedRoot = await clearedTree.root();

    const nullifiers = await Promise.all(inputs.map((n) => computeNullifier(keys.sk, n.leafIndex!)));

    // Output 0 carries real change (if any) back to this wallet; output 1 is always a
    // zero-value dummy — 2x2 arity requires exactly 2 outputs even when the whole input is
    // relayed through with no change left over.
    const outAmounts = [changeAmount, 0n];
    const outBlindings = outAmounts.map(() => BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + 1n);
    const outOwnerPkXs = [keys.pkX, keys.pkX];
    const realCommitments = await Promise.all(
      outAmounts.map((amount, j) => computeCommitment({ tokenId, rawAmount: amount, ownerPkX: outOwnerPkXs[j]!, blinding: outBlindings[j]! })),
    );

    const inPaths = await Promise.all(inputs.map((n) => mainTree.pathTo(n.leafIndex!)));
    const inClearedPaths = await Promise.all(inputs.map((n) => clearedTree.pathTo(n.clearedLeafIndex!)));

    // Must match CurtainPool.sol's `_extDataHash` exactly — see send()'s identical comment.
    const feeAmount = 0n; // RelayAdapt has no fee mechanism yet — see its header, deviation 2.
    const extDataHash =
      BigInt(keccak256(encodeAbiParameters(parseAbiParameters("address, uint256, uint256"), [relayAddress, unshieldAmount, feeAmount]))) % FIELD_SIZE;

    const circuitInput = {
      root: root.toString(),
      clearedRoot: clearedRoot.toString(),
      nullifiers: nullifiers.map(String),
      newCommitments: realCommitments.map(String),
      tokenId: tokenId.toString(),
      unshieldAmount: unshieldAmount.toString(),
      unshieldTo: BigInt(relayAddress).toString(),
      feeAmount: feeAmount.toString(),
      extDataHash: extDataHash.toString(),
      inAmount: inputs.map((n) => n.rawAmount.toString()),
      inBlinding: inputs.map((n) => n.blinding.toString()),
      inLeafIndex: inputs.map((n) => n.leafIndex!.toString()),
      inOwnerSk: inputs.map(() => keys.sk.toString()),
      inPathElements: inPaths.map((p) => p.pathElements.map(String)),
      inPathIndices: inPaths.map((p) => p.pathIndices),
      inClearedPathElements: inClearedPaths.map((p) => p.pathElements.map(String)),
      inClearedPathIndices: inClearedPaths.map((p) => p.pathIndices),
      outAmount: outAmounts.map(String),
      outBlinding: outBlindings.map(String),
      outOwnerPkX: outOwnerPkXs.map(String),
    };

    const { a, b, c } = await proveGroth16(circuitInput, joinsplit2x2.wasm, joinsplit2x2.zkey);
    const proofBytes = encodeGroth16Proof(a, b, c);

    // Self-encrypt the change note (self, same pattern shield()/send() already use); the
    // dummy zero-value output is never spendable for anything, so it isn't worth encrypting
    // meaningfully — still needs SOME ciphertext bytes since CurtainPool requires
    // newCommits/ephemeralPks/cts to be equal-length arrays.
    const changeCiphertext = await encryptNoteTo(keys.ekX, keys.ekY, { tokenId, rawAmount: outAmounts[0]!, blinding: outBlindings[0]! });
    const dummyCiphertext = await encryptNoteTo(keys.ekX, keys.ekY, { tokenId, rawAmount: outAmounts[1]!, blinding: outBlindings[1]! });
    const ciphertexts = [changeCiphertext, dummyCiphertext];

    const unshieldArgs = {
      proof: proofBytes,
      token,
      root: `0x${root.toString(16).padStart(64, "0")}` as Hex,
      clearedRoot: `0x${clearedRoot.toString(16).padStart(64, "0")}` as Hex,
      nullifiers: nullifiers.map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex),
      newCommits: realCommitments.map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex),
      unshieldTo: relayAddress,
      unshieldAmount,
      feeAmount,
      ephemeralPks: ciphertexts.map((ct) => ct.ephemeralPk),
      cts: ciphertexts.map((ct) => ct.ct),
    };

    const relayOutputArgs = await Promise.all(
      reshieldOutputs.map(async (o) => {
        const blinding = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) + 1n;
        const { ephemeralPk, ct } = await encryptNoteTo(o.toEkX, o.toEkY, { tokenId: tokenIdOf(o.token), rawAmount: o.expectedAmount, blinding });
        return { token: o.token, ownerPkX: o.toPkX, blinding, ephemeralPk, ct, minOut: o.minOut };
      }),
    );

    const hash = await walletClient.writeContract({
      chain: walletClient.chain,
      account,
      address: relayAddress,
      abi: relayAbi,
      functionName: "relay",
      args: [unshieldArgs, relayCalls, relayOutputArgs, origin],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("relay: transaction reverted");
  }

  /** Withdraws a shielded note straight back to its original depositor, bypassing ScreeningGate entirely. */
  async unshieldToOrigin(token: Address, note: OwnedNote): Promise<void> {
    const { publicClient, walletClient, account, poolAddress, poolAbi, keys, unshield } = this.cfg;
    if (note.leafIndex === undefined) throw new Error("unshieldToOrigin: note has no known leafIndex (must come from a Shield event)");

    const nullifier = await computeNullifier(keys.sk, note.leafIndex);
    const circuitInput = {
      ownerPkX: note.ownerPkX.toString(),
      leafIndex: note.leafIndex.toString(),
      nullifier: nullifier.toString(),
      ownerSk: keys.sk.toString(),
    };
    const { a, b, c } = await proveGroth16(circuitInput, unshield.wasm, unshield.zkey);
    const proofBytes = encodeGroth16Proof(a, b, c);

    const hash = await walletClient.writeContract({
      chain: walletClient.chain,
      account,
      address: poolAddress,
      abi: poolAbi,
      functionName: "unshieldToOrigin",
      args: [
        `0x${note.commit.toString(16).padStart(64, "0")}` as Hex,
        token,
        note.rawAmount,
        note.ownerPkX,
        note.blinding,
        nullifier,
        proofBytes,
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("unshieldToOrigin: transaction reverted");
  }
}

function encodeGroth16Proof(a: [string, string], b: [[string, string], [string, string]], c: [string, string]): Hex {
  return encodeAbiParameters(
    parseAbiParameters("uint256[2], uint256[2][2], uint256[2]"),
    [a.map(BigInt) as [bigint, bigint], b.map((row) => row.map(BigInt)) as [[bigint, bigint], [bigint, bigint]], c.map(BigInt) as [bigint, bigint]],
  );
}

const MULTIPLIER_WAD = 1_000_000_000_000_000_000n;

/**
 * Fetches the live uiMultiplier() for an ERC-8056 token from a running
 * `@curtain/multiplier-view` service (see services/multiplier-view/src/server.ts),
 * WAD-scaled (1e18 == 1.0x). Falls back to 1.0x (no display adjustment) if the service is
 * unreachable or the token isn't registered there — the raw note amount itself never
 * depends on this value (per Curtain_Build.md §4's "ex-div: nothing moves, multiplier-view
 * updates display" flow), so a fallback only means a stale/unadjusted UI number, never an
 * incorrect balance.
 */
export async function fetchUiMultiplier(tokenAddress: Address, multiplierViewUrl: string): Promise<bigint> {
  try {
    const res = await fetch(`${multiplierViewUrl}/multiplier/${tokenAddress}`);
    if (!res.ok) return MULTIPLIER_WAD;
    const body = (await res.json()) as { multiplier: string };
    return BigInt(body.multiplier);
  } catch {
    return MULTIPLIER_WAD;
  }
}

/** Raw × uiMultiplier() for 8056 tokens (Curtain_Build.md §5). `multiplier` is WAD-scaled (1e18 == 1.0x) — fetch it via `fetchUiMultiplier` first. */
export function computeDisplayBalance(rawAmount: bigint, multiplier: bigint): bigint {
  return (rawAmount * multiplier) / MULTIPLIER_WAD;
}
