// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IScreeningGate} from "./IScreeningGate.sol";
import {IPpoiVerifier} from "./IPpoiVerifier.sol";
import {IPoseidonT2} from "../lib/PoseidonT2.sol";
import {IPoseidonT3} from "../lib/PoseidonT3.sol";
import {MerkleProof32} from "../lib/MerkleProof32.sol";
import {ICurtainPool} from "../pool/ICurtainPool.sol";

/// @notice PPOI screening + standby, per Curtain_Build.md §2.2/§3.2. Reads
/// CurtainPool's `originOf`/`shieldedAt` directly (rather than trusting a
/// caller-supplied value) so nobody can clear or flag a note by lying about
/// which address it came from. `pool` is wired via a one-time `setPool()`
/// after both contracts deploy — the deploy runbook (§7) deploys
/// ScreeningGate *before* CurtainPool, so CurtainPool's address literally
/// isn't known at ScreeningGate's construction time. This is the only
/// mutable state ScreeningGate has for bootstrapping; CurtainPool itself
/// remains fully immutable and never needs a matching setter (it only ever
/// reads `spendable()`/`standby()`, both view calls).
///
/// `flag()` uses a plain (non-ZK) depth-32 Merkle inclusion proof against a
/// provider-published `flagRoot`, not the SMT `listRoot` used for ZK PPOI
/// non-membership — a deliberate simplification (Curtain_Build.md §11 item
/// 2: a positive hit doesn't need privacy, so reusing the already-built,
/// already-tested plain-Merkle-proof code is preferable to a from-scratch
/// on-chain SMT membership verifier). The tradeoff: providers publish two
/// roots instead of one.
///
/// Dev-scale: hardcoded to exactly 3 providers (indices 0-2), matching
/// ppoi_dev.circom's K=3. Scaling K is a circuit-parameter change (see
/// ppoi_main.circom), not a ScreeningGate logic change.
contract ScreeningGate is IScreeningGate, Ownable {
    struct Provider {
        bytes32 listRoot;
        bytes32 flagRoot;
        uint64 updatedAt;
        address publisher;
        bool active;
    }

    uint8 public constant PROVIDER_COUNT = 3;
    uint64 public constant STANDBY_SECONDS = 15 minutes;
    uint64 public constant STANDBY_DEGRADED_SECONDS = 60 minutes;
    // Backend §2.2 says 24h-without-update makes a provider stale; Overview's
    // kill-criteria says 6h — an unresolved spec disagreement (Curtain_Build.md
    // §11 item 1). Going with Backend's more detailed number here.
    uint64 public constant PROVIDER_STALE_AFTER = 24 hours;
    uint64 public constant ROOT_UPDATE_MIN_INTERVAL = 1 hours;

    mapping(uint8 => Provider) public providers;
    mapping(bytes32 => bool) public cleared;
    mapping(bytes32 => bool) public flagged;

    ICurtainPool public pool;
    IPoseidonT2 public immutable originHasher;
    IPoseidonT3 public immutable merkleHasher;
    IPpoiVerifier public immutable ppoiVerifier;

    event PoolSet(address pool);
    event ProviderUpdated(uint8 indexed id, bytes32 listRoot, bytes32 flagRoot);
    event ProviderRemoved(uint8 indexed id);
    event Cleared(bytes32 indexed commit);
    event Flagged(bytes32 indexed commit, uint8 indexed providerId);

    error PoolAlreadySet();
    error NotPublisher();
    error RateLimited();
    error UnknownProvider();
    error NoteNotShielded();
    error AlreadyCleared();
    error AlreadyFlagged();
    error StandbyElapsed();
    error InvalidPpoiProof();
    error InvalidMembershipProof();

    constructor(address originHasherAddr, address merkleHasherAddr, address ppoiVerifierAddr, address initialOwner)
        Ownable(initialOwner)
    {
        originHasher = IPoseidonT2(originHasherAddr);
        merkleHasher = IPoseidonT3(merkleHasherAddr);
        ppoiVerifier = IPpoiVerifier(ppoiVerifierAddr);
    }

    /// @notice One-time bootstrap once CurtainPool's address is known.
    /// Deliberately restricted to a single call (not an ongoing admin
    /// lever) — see the contract-level note on why this exists at all.
    function setPool(address poolAddr) external onlyOwner {
        if (address(pool) != address(0)) revert PoolAlreadySet();
        pool = ICurtainPool(poolAddr);
        emit PoolSet(poolAddr);
    }

    function addProvider(uint8 id, address publisher, bytes32 initialListRoot, bytes32 initialFlagRoot)
        external
        onlyOwner
    {
        providers[id] = Provider({
            listRoot: initialListRoot,
            flagRoot: initialFlagRoot,
            updatedAt: uint64(block.timestamp),
            publisher: publisher,
            active: true
        });
        emit ProviderUpdated(id, initialListRoot, initialFlagRoot);
    }

    function removeProvider(uint8 id) external onlyOwner {
        providers[id].active = false;
        emit ProviderRemoved(id);
    }

    /// @notice Publisher-only, rate-limited to once/hour, per Backend §2.2.
    function updateRoot(uint8 id, bytes32 newListRoot, bytes32 newFlagRoot) external {
        Provider storage p = providers[id];
        if (!p.active) revert UnknownProvider();
        if (msg.sender != p.publisher) revert NotPublisher();
        if (block.timestamp < p.updatedAt + ROOT_UPDATE_MIN_INTERVAL) revert RateLimited();

        p.listRoot = newListRoot;
        p.flagRoot = newFlagRoot;
        p.updatedAt = uint64(block.timestamp);
        emit ProviderUpdated(id, newListRoot, newFlagRoot);
    }

    function freshProviderCount() public view returns (uint8 count) {
        for (uint8 i = 0; i < PROVIDER_COUNT; i++) {
            if (providers[i].active && block.timestamp <= providers[i].updatedAt + PROVIDER_STALE_AFTER) {
                count++;
            }
        }
    }

    /// @notice 15 min normally; 60 min if fewer than 2 providers are fresh.
    function standby() public view returns (uint64) {
        return freshProviderCount() < 2 ? STANDBY_DEGRADED_SECONDS : STANDBY_SECONDS;
    }

    /// @notice Submits a PPOI non-membership proof for `commit`, clearing it
    /// if valid. Origin is read from `pool.originOf(commit)` directly —
    /// callers cannot substitute a different address to launder a listed
    /// origin's note.
    function ppoiVerify(bytes32 commit, bytes calldata proof) external {
        if (flagged[commit]) revert AlreadyFlagged();
        if (cleared[commit]) revert AlreadyCleared();

        uint64 shieldedAtTs = pool.shieldedAt(commit);
        if (shieldedAtTs == 0) revert NoteNotShielded();

        address origin = pool.originOf(commit);
        uint256 originHash = originHasher.poseidon([uint256(uint160(origin))]);

        uint256[] memory signals = new uint256[](6);
        signals[0] = uint256(providers[0].listRoot);
        signals[1] = uint256(providers[1].listRoot);
        signals[2] = uint256(providers[2].listRoot);
        signals[3] = uint256(commit);
        // ppoi.circom's public `shieldBlock` is an opaque binding value with
        // no further in-circuit constraint (see its header) — we use the
        // shield timestamp CurtainPool already tracks rather than adding a
        // separate block-number field, since the exact value only needs the
        // prover and verifier to agree.
        signals[4] = uint256(shieldedAtTs);
        signals[5] = originHash;

        if (!ppoiVerifier.verifyProof(proof, signals)) revert InvalidPpoiProof();

        cleared[commit] = true;
        emit Cleared(commit);
    }

    /// @notice Flags `commit` using a plain Merkle inclusion proof that
    /// `pool.originOf(commit)` appears in provider `providerId`'s published
    /// flag list. Only possible within the standby window and only before
    /// the note has cleared — matches the security checklist's "flag only
    /// within standby; cannot flag cleared notes retroactively"
    /// (Curtain_Build.md §10).
    function flag(bytes32 commit, uint8 providerId, uint256[32] calldata pathElements, uint8[32] calldata pathIndices)
        external
    {
        if (cleared[commit]) revert AlreadyCleared();

        uint64 shieldedAtTs = pool.shieldedAt(commit);
        if (shieldedAtTs == 0) revert NoteNotShielded();
        if (block.timestamp > shieldedAtTs + standby()) revert StandbyElapsed();

        Provider storage p = providers[providerId];
        if (!p.active) revert UnknownProvider();

        address origin = pool.originOf(commit);
        uint256 leaf = uint256(uint160(origin));
        if (!MerkleProof32.verify(merkleHasher, leaf, pathElements, pathIndices, uint256(p.flagRoot))) {
            revert InvalidMembershipProof();
        }

        flagged[commit] = true;
        emit Flagged(commit, providerId);
    }

    /// @notice `!flagged && (cleared || standby elapsed)` — the same
    /// expression Backend §2.2 specifies for `transact()` gating, now
    /// actually usable via CurtainPool's cleared-tree mechanism (see
    /// CurtainPool.sol's header) instead of the unenforceable per-commit
    /// lookup the spec's literal pseudocode described.
    function spendable(bytes32 commit) external view returns (bool) {
        if (flagged[commit]) return false;
        if (cleared[commit]) return true;

        uint64 shieldedAtTs = pool.shieldedAt(commit);
        if (shieldedAtTs == 0) return false;
        return block.timestamp > shieldedAtTs + standby();
    }
}
