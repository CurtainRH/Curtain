// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IPoseidonT3} from "../lib/PoseidonT3.sol";
import {IPoseidonT5} from "../lib/PoseidonT5.sol";
import {IncrementalMerkleTree} from "../lib/IncrementalMerkleTree.sol";
import {IJoinSplitVerifier} from "./IJoinSplitVerifier.sol";
import {IUnshieldVerifier} from "./IUnshieldVerifier.sol";
import {AssetGate} from "../config/AssetGate.sol";
import {IScreeningGate} from "../gate/IScreeningGate.sol";
import {IFeeSource} from "./IFeeSource.sol";
import {IGuardian} from "../guardian/IGuardian.sol";

/// @notice Curtain's shielded UTXO pool, per Curtain_Build.md §3.1.
/// Deliberately has NO owner, NO admin functions, and NO upgrade path —
/// verified by the immutability test in test/pool/CurtainPool.t.sol and (at
/// mainnet) by the launch gate in Curtain_Build.md §9. Migration to a new
/// pool version is always a fresh deployment plus user-initiated moves,
/// never an in-place upgrade.
///
/// GATING (M4 resolution of the M3 KNOWN GAP — see Curtain_Build.md §11 item
/// 6): the spec's literal `ScreeningGate.spendable(commit)` lookup can't
/// work inside `transact()` because nullifiers are deliberately unlinkable
/// from the commitment they spend. Instead, `transact()`'s ZK proof must
/// prove each input note is included in a *second* tree — `clearedTree` —
/// which only contains commitments ScreeningGate has actually confirmed
/// spendable. A Merkle inclusion proof reveals nothing about the leaf's
/// position, so this enforces "only spend cleared notes" without ever
/// telling the contract which note is being spent. Shield-time commitments
/// enter `clearedTree` only via `markCleared()`, once `screeningGate.
/// spendable(commit)` returns true; `transact()`'s own output commitments
/// are inserted directly, since they inherit clean status from already-
/// verified (cleared) inputs. `unshieldToOrigin` is unaffected by any of
/// this — it intentionally works regardless of screening state, by design.
///
/// UNSHIELD NULLIFIER UNIFICATION (found while building M5 — see
/// Curtain_Build.md section 11): unshieldToOrigin used to track spent
/// notes in its own nullifierUsed[commit] slot, entirely separate from
/// transact()'s nullifierUsed[Poseidon(ownerSk, leafIndex)] slots for the
/// exact same notes. A note spent one way could still be spent the other
/// way too -- a real double-spend, not just a privacy nit. Fixed by
/// having unshieldToOrigin prove (via the tiny unshield.circom circuit)
/// that it knows the spending key behind the note and derive the SAME
/// nullifier a join-split spend of that note would use, keyed by the
/// note's true leafIndexOf[commit] (recorded once, at shield time, so the
/// caller can't pick a fresh leafIndex to mint unlimited nullifiers for
/// one note) -- then mark it in the very same nullifierUsed mapping
/// transact() uses. Both spend paths now share one nullifier set per
/// note, so using either one blocks the other.
///
/// RELAYADAPT / reshield (M6): `reshield()` lets RelayAdapt deposit a
/// swap's output token straight back into the shielded pool, atomically,
/// skipping the normal shield fee and standby (the funds already passed
/// through a fully-proven, already-cleared note in the SAME transaction
/// via transact()'s ordinary unshield-to-RelayAdapt step -- re-charging a
/// deposit fee or re-screening would be redundant, not extra safety).
/// Gating this to RelayAdapt ONLY, without adding a mutable admin setter
/// (which would break the zero-admin-function invariant this contract is
/// tested for), needs `relayAdapt` to be immutable and known at THIS
/// contract's construction time -- but RelayAdapt's own constructor also
/// needs CurtainPool's address, a genuine two-way dependency. Resolved
/// with no setter at all: the deployer predicts RelayAdapt's address
/// before deploying either contract (`vm.computeCreateAddress` /
/// `getContractAddress`, using the deployer's next-but-one nonce), bakes
/// that prediction into CurtainPool's constructor, then deploys RelayAdapt
/// immediately after -- landing it at exactly the predicted address. See
/// `test/adapt/RelayAdapt.t.sol` for the concrete deployment order this
/// requires (a real Deploy.s.sol script doing the same, end to end for
/// every contract, is still an M12 launch-runbook item -- see
/// Curtain_Build.md section 7 and section 11).
/// META-TX SUPPORT FOR `shieldMeta` (post-M12, resolving Curtain_Build.md §11 item 22's
/// forwarder gap): CurtainPool inherits OpenZeppelin's audited ERC2771Context so a single,
/// immutable `trustedForwarder` (set once at construction, no setter — the zero-admin
/// invariant is untouched, `isTrustedForwarder` is a plain view function, not a selector any
/// immutability check would flag) may submit a `shield()` call on a user's behalf while
/// `_msgSender()` still resolves to the REAL signer, not the forwarder's own address. This
/// matters for a subtle reason: `originOf[commit]` binds `unshieldToOrigin`'s payout
/// destination, and it is deliberately anchored to the caller rather than any
/// caller-supplied value specifically to prevent spoofing (see this file's header on the
/// RelayAdapt #140-bug precedent). A naive meta-tx design where a forwarder contract holds
/// funds and calls `shield()` itself would bind `originOf` to the FORWARDER, permanently
/// routing that note's unshield-to-origin escape hatch to the forwarder instead of the real
/// depositor — reintroducing exactly the bug class Curtain already closed elsewhere by
/// construction, not a stylistic nitpick. ERC2771Context avoids this: the forwarder only
/// relays an EIP-712-signed request (see ShieldMetaForwarder.sol, an unmodified deployment
/// of OpenZeppelin's ERC2771Forwarder), and `_msgSender()` recovers the true signer from the
/// trailing 20 bytes of calldata the forwarder appends — token transfers and `originOf`
/// binding both use `_msgSender()`, so they land on the real user's address exactly as if
/// they'd called `shield()` directly and paid their own gas. Only `shield()`'s two
/// `msg.sender` uses were changed to `_msgSender()`; `reshield()`'s `msg.sender != relayAdapt`
/// check is untouched (reshield is only ever called by RelayAdapt directly — meta-tx
/// forwarding was never relevant there).
///
/// FEES, BROADCASTER PAY AND EXTDATA BINDING (post-audit fixes):
/// - The protocol fee is `feeBps()` (governed via `feeSource`, clamped to [10, 30] bps,
///   defaulting to `defaultFeeBps`). The pool has no fee setter of its own.
/// - `transact()` charges it on `unshieldAmount`: `feeAmount` (proved in the circuit's
///   balance equation) must cover it, and anything above it is the broadcaster's fee, paid to
///   `feeRecipient`. Before this fix the prover picked `feeAmount` freely, so unshields could
///   skip the fee, and broadcasters were never paid on-chain.
/// - `extDataHash` now also binds `feeRecipient` and `extData`. RelayAdapt puts the hash of
///   its calls, outputs and origin in `extData`, so a relay proof can't be replayed with
///   different calls (the front-running theft in test/adapt/RelayFrontRun.t.sol).
/// - `shield()` honours the Guardian's shield pause. `transact()` and `unshieldToOrigin()`
///   never consult the Guardian.
contract CurtainPool is ERC2771Context {
    using SafeERC20 for IERC20;
    using IncrementalMerkleTree for IncrementalMerkleTree.Tree;

    /// BN254 scalar field order — every Poseidon input/output and every
    /// public circuit signal must live in this field.
    uint256 internal constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint16 public constant MIN_FEE_BPS = 10;
    uint16 public constant MAX_FEE_BPS = 30;

    uint16 public immutable defaultFeeBps;
    IFeeSource public immutable feeSource;
    IGuardian public immutable guardian;
    address public immutable treasury;

    IPoseidonT3 public immutable hasherT3;
    IPoseidonT5 public immutable commitHasher;
    AssetGate public immutable assetGate;
    IScreeningGate public immutable screeningGate;
    IJoinSplitVerifier public immutable joinSplit2x2Verifier;
    IJoinSplitVerifier public immutable joinSplit3x3Verifier;
    IUnshieldVerifier public immutable unshieldVerifier;
    address public immutable relayAdapt;

    IncrementalMerkleTree.Tree internal mainTree;
    IncrementalMerkleTree.Tree internal clearedTree;

    mapping(bytes32 => address) public originOf;
    mapping(bytes32 => uint64) public shieldedAt;
    mapping(bytes32 => bool) public nullifierUsed;
    mapping(bytes32 => bool) public clearedTreeMember;
    mapping(bytes32 => uint32) public leafIndexOf;

    struct TransactArgs {
        bytes proof;
        address token;
        bytes32 root;
        bytes32 clearedRoot;
        bytes32[] nullifiers;
        bytes32[] newCommits;
        address unshieldTo;
        uint256 unshieldAmount;
        uint256 feeAmount;
        bytes[] ephemeralPks;
        bytes[] cts;
        address feeRecipient; // broadcaster paid `feeAmount - protocolFee`; zero sends it all to treasury
        bytes32 extData; // opaque, bound into extDataHash (RelayAdapt: hash of calls/outputs/origin)
    }

    event Shield(bytes32 indexed commit, uint32 leafIndex, address indexed token, uint256 rawAmount);
    event NoteCiphertext(bytes32 indexed commit, bytes ephemeralPk, bytes ct);
    event Transact(bytes32[] nullifiers, bytes32[] newCommits, bytes32 root, address unshieldTo);
    event UnshieldToOrigin(bytes32 indexed commit, address indexed origin, uint256 rawAmount);
    event MarkedCleared(bytes32 indexed commit, uint32 clearedLeafIndex);

    error TokenNotRegistered();
    error UnknownRoot();
    error UnknownClearedRoot();
    error NullifierAlreadyUsed();
    error InvalidProof();
    error UnsupportedArity();
    error LengthMismatch();
    error NotOrigin();
    error AlreadyUnshielded();
    error NotShielded();
    error AlreadyClearedTreeMember();
    error NotSpendable();
    error NotRelayAdapt();
    error FeeTooLow(uint256 feeAmount, uint256 protocolFee);
    error ShieldPausedByGuardian();
    error InvalidDefaultFee();

    constructor(
        address hasherT3Addr,
        address hasherT5Addr,
        address assetGateAddr,
        address screeningGateAddr,
        address joinSplit2x2VerifierAddr,
        address joinSplit3x3VerifierAddr,
        address unshieldVerifierAddr,
        address relayAdaptAddr,
        address treasuryAddr,
        address feeSourceAddr,
        uint16 defaultFeeBps_,
        address trustedForwarderAddr,
        address guardianAddr
    ) ERC2771Context(trustedForwarderAddr) {
        if (defaultFeeBps_ < MIN_FEE_BPS || defaultFeeBps_ > MAX_FEE_BPS) revert InvalidDefaultFee();
        hasherT3 = IPoseidonT3(hasherT3Addr);
        commitHasher = IPoseidonT5(hasherT5Addr);
        assetGate = AssetGate(assetGateAddr);
        screeningGate = IScreeningGate(screeningGateAddr);
        joinSplit2x2Verifier = IJoinSplitVerifier(joinSplit2x2VerifierAddr);
        joinSplit3x3Verifier = IJoinSplitVerifier(joinSplit3x3VerifierAddr);
        unshieldVerifier = IUnshieldVerifier(unshieldVerifierAddr);
        relayAdapt = relayAdaptAddr;
        treasury = treasuryAddr;
        feeSource = IFeeSource(feeSourceAddr);
        defaultFeeBps = defaultFeeBps_;
        guardian = IGuardian(guardianAddr);

        mainTree.init(hasherT3);
        clearedTree.init(hasherT3);
    }

    function tokenIdOf(address token) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(token))) % FIELD_SIZE;
    }

    /// @notice Current protocol fee for shields and unshields, in bps. Read from `feeSource`
    /// (governance) and clamped to [MIN_FEE_BPS, MAX_FEE_BPS]; falls back to `defaultFeeBps`
    /// if there is no source or the call fails, so exits can never be blocked by it.
    function feeBps() public view returns (uint16) {
        if (address(feeSource) == address(0)) return defaultFeeBps;
        try feeSource.currentFeeBps() returns (uint16 bps) {
            if (bps < MIN_FEE_BPS) return MIN_FEE_BPS;
            if (bps > MAX_FEE_BPS) return MAX_FEE_BPS;
            return bps;
        } catch {
            return defaultFeeBps;
        }
    }

    /// @notice Protocol fee owed on an unshield of `unshieldAmount`.
    function protocolFeeFor(uint256 unshieldAmount) public view returns (uint256) {
        return (unshieldAmount * feeBps()) / 10000;
    }

    /// @notice The `extDataHash` public signal a transact proof must be generated against.
    /// Wallets, broadcasters and tests use this to match the pool exactly.
    function extDataHashFor(address unshieldTo, uint256 unshieldAmount, uint256 feeAmount, address feeRecipient, bytes32 extData)
        external
        pure
        returns (uint256)
    {
        return _extDataHash(unshieldTo, unshieldAmount, feeAmount, feeRecipient, extData) % FIELD_SIZE;
    }

    function currentRoot() external view returns (bytes32) {
        return bytes32(mainTree.currentRoot());
    }

    function currentClearedRoot() external view returns (bytes32) {
        return bytes32(clearedTree.currentRoot());
    }

    function isKnownRoot(bytes32 root) public view returns (bool) {
        return mainTree.isKnownRoot(uint256(root));
    }

    function isKnownClearedRoot(bytes32 root) public view returns (bool) {
        return clearedTree.isKnownRoot(uint256(root));
    }

    /// @notice Shields `rawAmount` of `token`. The contract computes the
    /// note commitment itself from the *actual net deposit* — callers
    /// cannot pass a pre-built commitment, which would let a note claim a
    /// value larger than what was really deposited (net of fee) and drain
    /// other users' funds on a later spend.
    function shield(address token, uint256 rawAmount, uint256 ownerPkX, uint256 blinding, bytes calldata ephemeralPk, bytes calldata ct)
        external
        returns (bytes32 commit, uint32 leafIndex)
    {
        if (!assetGate.isRegistered(token)) revert TokenNotRegistered();
        if (address(guardian) != address(0) && guardian.shieldPaused()) revert ShieldPausedByGuardian();

        IERC20(token).safeTransferFrom(_msgSender(), address(this), rawAmount);

        uint256 fee = (rawAmount * feeBps()) / 10000;
        if (fee > 0) IERC20(token).safeTransfer(treasury, fee);

        commit = bytes32(commitHasher.poseidon([tokenIdOf(token), rawAmount - fee, ownerPkX, blinding]));
        leafIndex = mainTree.insert(hasherT3, uint256(commit));
        originOf[commit] = _msgSender();
        shieldedAt[commit] = uint64(block.timestamp);
        leafIndexOf[commit] = leafIndex;

        emit Shield(commit, leafIndex, token, rawAmount);
        emit NoteCiphertext(commit, ephemeralPk, ct);
    }

    /// @notice Permissionless: inserts a shield-time commitment into
    /// `clearedTree` once ScreeningGate confirms it's spendable (either
    /// explicitly PPOI-cleared, or standby has elapsed with no flag).
    /// Anyone may call this — the security comes from ScreeningGate's own
    /// verification, not from who submits the transaction.
    function markCleared(bytes32 commit) external returns (uint32 clearedLeafIndex) {
        if (shieldedAt[commit] == 0) revert NotShielded();
        if (clearedTreeMember[commit]) revert AlreadyClearedTreeMember();
        if (!screeningGate.spendable(commit)) revert NotSpendable();

        clearedTreeMember[commit] = true;
        clearedLeafIndex = clearedTree.insert(hasherT3, uint256(commit));
        emit MarkedCleared(commit, clearedLeafIndex);
    }

    /// @notice RelayAdapt-only: deposits a relay's swap output straight back
    /// into the shielded pool, atomically, with no shield fee and no
    /// standby (see this file's header for why that's safe here and not a
    /// backdoor). `origin` is caller-supplied rather than `msg.sender`
    /// (which would just be RelayAdapt itself) specifically so
    /// `unshieldToOrigin` on the reshielded note still pays the ORIGINAL
    /// depositor, not RelayAdapt — RelayAdapt is trusted to pass through
    /// the origin of the note it just unshielded via its own `relay()` call
    /// in the same transaction, never an arbitrary caller-chosen address.
    function reshield(
        address token,
        uint256 rawAmount,
        uint256 ownerPkX,
        uint256 blinding,
        bytes calldata ephemeralPk,
        bytes calldata ct,
        address origin
    ) external returns (bytes32 commit, uint32 leafIndex) {
        if (msg.sender != relayAdapt) revert NotRelayAdapt();

        IERC20(token).safeTransferFrom(msg.sender, address(this), rawAmount);

        commit = bytes32(commitHasher.poseidon([tokenIdOf(token), rawAmount, ownerPkX, blinding]));
        leafIndex = mainTree.insert(hasherT3, uint256(commit));
        originOf[commit] = origin;
        shieldedAt[commit] = uint64(block.timestamp);
        leafIndexOf[commit] = leafIndex;

        // Skips standby entirely — inherits cleared status the same way
        // transact()'s own outputs do, since the value backing this note
        // was already proven cleared as an input earlier in this very tx.
        clearedTreeMember[commit] = true;
        clearedTree.insert(hasherT3, uint256(commit));

        emit Shield(commit, leafIndex, token, rawAmount);
        emit NoteCiphertext(commit, ephemeralPk, ct);
    }

    function transact(TransactArgs calldata a) external {
        _transact(a);
    }

    function transactBatch(TransactArgs[] calldata args) external {
        for (uint256 i = 0; i < args.length; i++) {
            _transact(args[i]);
        }
    }

    function _transact(TransactArgs calldata a) internal {
        if (!isKnownRoot(a.root)) revert UnknownRoot();
        if (!isKnownClearedRoot(a.clearedRoot)) revert UnknownClearedRoot();
        if (a.newCommits.length != a.ephemeralPks.length || a.newCommits.length != a.cts.length) revert LengthMismatch();

        for (uint256 i = 0; i < a.nullifiers.length; i++) {
            if (nullifierUsed[a.nullifiers[i]]) revert NullifierAlreadyUsed();
        }

        uint256 protocolFee = protocolFeeFor(a.unshieldAmount);
        if (a.feeAmount < protocolFee) revert FeeTooLow(a.feeAmount, protocolFee);

        uint256 tokenId = tokenIdOf(a.token);
        uint256 extDataHash = _extDataHash(a.unshieldTo, a.unshieldAmount, a.feeAmount, a.feeRecipient, a.extData) % FIELD_SIZE;

        uint256[] memory publicSignals = _buildPublicSignals(a, tokenId, extDataHash);
        IJoinSplitVerifier verifier = _verifierFor(a.nullifiers.length, a.newCommits.length);
        if (!verifier.verifyProof(a.proof, publicSignals)) revert InvalidProof();

        for (uint256 i = 0; i < a.nullifiers.length; i++) {
            nullifierUsed[a.nullifiers[i]] = true;
        }
        for (uint256 j = 0; j < a.newCommits.length; j++) {
            mainTree.insert(hasherT3, uint256(a.newCommits[j]));
            // Outputs inherit cleared status from already-verified inputs —
            // no separate markCleared() round trip needed for them.
            clearedTreeMember[a.newCommits[j]] = true;
            clearedTree.insert(hasherT3, uint256(a.newCommits[j]));
            emit NoteCiphertext(a.newCommits[j], a.ephemeralPks[j], a.cts[j]);
        }

        if (a.unshieldAmount > 0) {
            IERC20(a.token).safeTransfer(a.unshieldTo, a.unshieldAmount);
        }
        if (a.feeAmount > 0) {
            uint256 broadcasterFee = a.feeRecipient == address(0) ? 0 : a.feeAmount - protocolFee;
            uint256 treasuryFee = a.feeAmount - broadcasterFee;
            if (treasuryFee > 0) IERC20(a.token).safeTransfer(treasury, treasuryFee);
            if (broadcasterFee > 0) IERC20(a.token).safeTransfer(a.feeRecipient, broadcasterFee);
        }

        emit Transact(a.nullifiers, a.newCommits, a.root, a.unshieldTo);
    }

    /// @notice Always available — including during standby, after a PPOI
    /// flag, or under any future guardian pause of `shield`/`relay` — and
    /// only ever pays the EOA recorded at shield time. No arity-specific
    /// join-split proof or ScreeningGate check is required; closes Railgun's
    /// #140 bug by construction (see Curtain_Overview.md §1, §3).
    ///
    /// `unshieldProof` is a tiny `unshield.circom` proof (see this file's
    /// header) that the caller knows the spending key behind `ownerPkX` and
    /// that `nullifier == Poseidon(ownerSk, leafIndexOf[commit])` — the same
    /// nullifier a join-split spend of this exact note would produce. This
    /// is what lets the contract mark the note spent in the very same
    /// `nullifierUsed` set `transact()` uses, instead of a disjoint one, so
    /// a note already spent via either path can't be spent via the other.
    function unshieldToOrigin(
        bytes32 commit,
        address token,
        uint256 netAmount,
        uint256 ownerPkX,
        uint256 blinding,
        uint256 nullifier,
        bytes calldata unshieldProof
    ) external {
        address origin = originOf[commit];
        if (origin == address(0)) revert NotOrigin();
        if (nullifierUsed[bytes32(nullifier)]) revert AlreadyUnshielded();

        // `netAmount` is the value actually encoded in the note (post
        // shield-fee) — the caller (the note's owner) knows this because
        // they know their own note's opening. Recomputing the commitment
        // from it here is what proves the caller is entitled to `commit`.
        uint256 tokenId = tokenIdOf(token);
        uint256 commitField = commitHasher.poseidon([tokenId, netAmount, ownerPkX, blinding]);
        if (bytes32(commitField) != commit) revert InvalidProof();

        // leafIndex comes from the contract's own record (set once, at
        // shield time), never from the caller — see this function's header
        // and circuits/unshield.circom's header for why that matters.
        uint256[] memory unshieldSignals = new uint256[](3);
        unshieldSignals[0] = ownerPkX;
        unshieldSignals[1] = leafIndexOf[commit];
        unshieldSignals[2] = nullifier;
        if (!unshieldVerifier.verifyProof(unshieldProof, unshieldSignals)) revert InvalidProof();

        nullifierUsed[bytes32(nullifier)] = true;

        uint256 fee = (netAmount * feeBps()) / 10000;
        uint256 payout = netAmount - fee;
        if (fee > 0) IERC20(token).safeTransfer(treasury, fee);
        IERC20(token).safeTransfer(origin, payout);

        emit UnshieldToOrigin(commit, origin, payout);
    }

    function _verifierFor(uint256 nIns, uint256 nOuts) internal view returns (IJoinSplitVerifier) {
        if (nIns != nOuts) revert UnsupportedArity();
        if (nIns == 2) return joinSplit2x2Verifier;
        if (nIns == 3) return joinSplit3x3Verifier;
        revert UnsupportedArity();
    }

    function _extDataHash(address unshieldTo, uint256 unshieldAmount, uint256 feeAmount, address feeRecipient, bytes32 extData)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(unshieldTo, unshieldAmount, feeAmount, feeRecipient, extData)));
    }

    /// @dev Order MUST exactly match each joinsplitNxN.circom's
    /// `component main {public [...]}` declaration: root, clearedRoot,
    /// nullifiers[], newCommitments[], tokenId, unshieldAmount, unshieldTo,
    /// feeAmount, extDataHash — circom flattens array public inputs in
    /// declaration order.
    function _buildPublicSignals(TransactArgs calldata a, uint256 tokenId, uint256 extDataHash)
        internal
        pure
        returns (uint256[] memory)
    {
        uint256 n = a.nullifiers.length;
        uint256[] memory signals = new uint256[](2 + n + n + 5);
        uint256 idx = 0;
        signals[idx++] = uint256(a.root);
        signals[idx++] = uint256(a.clearedRoot);
        for (uint256 i = 0; i < n; i++) signals[idx++] = uint256(a.nullifiers[i]);
        for (uint256 j = 0; j < n; j++) signals[idx++] = uint256(a.newCommits[j]);
        signals[idx++] = tokenId;
        signals[idx++] = a.unshieldAmount;
        signals[idx++] = uint256(uint160(a.unshieldTo));
        signals[idx++] = a.feeAmount;
        signals[idx++] = extDataHash;
        return signals;
    }
}
