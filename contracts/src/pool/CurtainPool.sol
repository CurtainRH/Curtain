// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoseidonT3} from "../lib/PoseidonT3.sol";
import {IPoseidonT5} from "../lib/PoseidonT5.sol";
import {IncrementalMerkleTree} from "../lib/IncrementalMerkleTree.sol";
import {IJoinSplitVerifier} from "./IJoinSplitVerifier.sol";
import {AssetGate} from "../config/AssetGate.sol";
import {IScreeningGate} from "../gate/IScreeningGate.sol";

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
contract CurtainPool {
    using SafeERC20 for IERC20;
    using IncrementalMerkleTree for IncrementalMerkleTree.Tree;

    /// BN254 scalar field order — every Poseidon input/output and every
    /// public circuit signal must live in this field.
    uint256 internal constant FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint16 public immutable feeBpsShield;
    uint16 public immutable feeBpsUnshield;
    address public immutable treasury;

    IPoseidonT3 public immutable hasherT3;
    IPoseidonT5 public immutable commitHasher;
    AssetGate public immutable assetGate;
    IScreeningGate public immutable screeningGate;
    IJoinSplitVerifier public immutable joinSplit2x2Verifier;
    IJoinSplitVerifier public immutable joinSplit3x3Verifier;

    IncrementalMerkleTree.Tree internal mainTree;
    IncrementalMerkleTree.Tree internal clearedTree;

    mapping(bytes32 => address) public originOf;
    mapping(bytes32 => uint64) public shieldedAt;
    mapping(bytes32 => bool) public nullifierUsed;
    mapping(bytes32 => bool) public clearedTreeMember;

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

    constructor(
        address hasherT3Addr,
        address hasherT5Addr,
        address assetGateAddr,
        address screeningGateAddr,
        address joinSplit2x2VerifierAddr,
        address joinSplit3x3VerifierAddr,
        address treasuryAddr,
        uint16 feeBpsShield_,
        uint16 feeBpsUnshield_
    ) {
        hasherT3 = IPoseidonT3(hasherT3Addr);
        commitHasher = IPoseidonT5(hasherT5Addr);
        assetGate = AssetGate(assetGateAddr);
        screeningGate = IScreeningGate(screeningGateAddr);
        joinSplit2x2Verifier = IJoinSplitVerifier(joinSplit2x2VerifierAddr);
        joinSplit3x3Verifier = IJoinSplitVerifier(joinSplit3x3VerifierAddr);
        treasury = treasuryAddr;
        feeBpsShield = feeBpsShield_;
        feeBpsUnshield = feeBpsUnshield_;

        mainTree.init(hasherT3);
        clearedTree.init(hasherT3);
    }

    function tokenIdOf(address token) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(token))) % FIELD_SIZE;
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

        IERC20(token).safeTransferFrom(msg.sender, address(this), rawAmount);

        uint256 fee = (rawAmount * feeBpsShield) / 10000;
        if (fee > 0) IERC20(token).safeTransfer(treasury, fee);

        commit = bytes32(commitHasher.poseidon([tokenIdOf(token), rawAmount - fee, ownerPkX, blinding]));
        leafIndex = mainTree.insert(hasherT3, uint256(commit));
        originOf[commit] = msg.sender;
        shieldedAt[commit] = uint64(block.timestamp);

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

        uint256 tokenId = tokenIdOf(a.token);
        uint256 extDataHash = _extDataHash(a.unshieldTo, a.unshieldAmount, a.feeAmount) % FIELD_SIZE;

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
            IERC20(a.token).safeTransfer(treasury, a.feeAmount);
        }

        emit Transact(a.nullifiers, a.newCommits, a.root, a.unshieldTo);
    }

    /// @notice Always available — including during standby, after a PPOI
    /// flag, or under any future guardian pause of `shield`/`relay` — and
    /// only ever pays the EOA recorded at shield time. `proof` need only
    /// demonstrate knowledge of the note opening (no arity-specific
    /// join-split proof required, and no ScreeningGate check at all); closes
    /// Railgun's #140 bug by construction (see Curtain_Overview.md §1, §3).
    function unshieldToOrigin(bytes32 commit, address token, uint256 netAmount, uint256 ownerPkX, uint256 blinding)
        external
    {
        address origin = originOf[commit];
        if (origin == address(0)) revert NotOrigin();
        if (nullifierUsed[commit]) revert AlreadyUnshielded();

        // `netAmount` is the value actually encoded in the note (post
        // shield-fee) — the caller (the note's owner) knows this because
        // they know their own note's opening. Recomputing the commitment
        // from it here is what proves the caller is entitled to `commit`
        // without needing a full join-split ZK proof for this escape hatch.
        uint256 tokenId = tokenIdOf(token);
        uint256 commitField = commitHasher.poseidon([tokenId, netAmount, ownerPkX, blinding]);
        if (bytes32(commitField) != commit) revert InvalidProof();

        // Reuses the nullifier-used map, keyed by the commit itself, purely
        // to prevent double-unshielding the same note via this path — this
        // is a distinct namespace from the real join-split nullifiers
        // (which are Poseidon(ownerSk, leafIndex), never equal to a raw
        // commitment value in practice).
        nullifierUsed[commit] = true;

        uint256 fee = (netAmount * feeBpsUnshield) / 10000;
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

    function _extDataHash(address unshieldTo, uint256 unshieldAmount, uint256 feeAmount) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(unshieldTo, unshieldAmount, feeAmount)));
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
