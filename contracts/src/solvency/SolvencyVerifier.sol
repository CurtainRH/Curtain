// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurtainPool} from "../pool/CurtainPool.sol";
import {ISolvencyVerifier} from "./ISolvencyVerifier.sol";

/// @notice SolvencyVerifier per Curtain_Build.md §2.3 and §3.7.
/// Accepts chunked solvency ZK proofs for an epoch and token, sums partial values across chunks,
/// and verifies on-chain that sum(live unspent notes) <= balanceOf(pool).
contract SolvencyVerifier {
    struct EpochStatus {
        bool finalized;
        bool ok;
        uint64 timestamp;
        uint256 totalLiveNotes;
        uint256 poolBalance;
    }

    CurtainPool public immutable pool;
    ISolvencyVerifier public immutable verifier;

    // epoch => token => EpochStatus
    mapping(uint256 => mapping(address => EpochStatus)) public epochs;
    // epoch => token => sum of partial sums
    mapping(uint256 => mapping(address => uint256)) public epochTotalSum;
    // epoch => token => chunkIdx => submitted
    mapping(uint256 => mapping(address => mapping(uint32 => bool))) public chunkSubmitted;
    // token => latest finalized epoch number
    mapping(address => uint256) public latestEpoch;

    event ChunkSubmitted(uint256 indexed epoch, address indexed token, uint32 indexed chunkIdx, uint256 partialSum);
    event EpochFinalized(uint256 indexed epoch, address indexed token, bool ok, uint256 totalLiveNotes, uint256 poolBalance);

    error EpochAlreadyFinalized();
    error ChunkAlreadySubmitted();
    error InvalidSolvencyProof();
    error EpochNotFinalized();
    error InsolventPool(uint256 totalLiveNotes, uint256 poolBalance);

    constructor(address poolAddr, address verifierAddr) {
        pool = CurtainPool(poolAddr);
        verifier = ISolvencyVerifier(verifierAddr);
    }

    /// @notice Submits a chunk proof for a given epoch and token.
    /// Public signals array expected by verifier: [partialSum, snapshotRoot, nullifierRoot, tokenId].
    function submitChunk(
        uint256 epoch,
        address token,
        uint32 chunkIdx,
        uint256 partialSum,
        bytes32 snapshotRoot,
        bytes32 nullifierRoot,
        bytes calldata proof
    ) external {
        if (epochs[epoch][token].finalized) revert EpochAlreadyFinalized();
        if (chunkSubmitted[epoch][token][chunkIdx]) revert ChunkAlreadySubmitted();

        uint256 tokenId = pool.tokenIdOf(token);

        uint256[] memory publicSignals = new uint256[](4);
        publicSignals[0] = partialSum;
        publicSignals[1] = uint256(snapshotRoot);
        publicSignals[2] = uint256(nullifierRoot);
        publicSignals[3] = tokenId;

        if (!verifier.verifyProof(proof, publicSignals)) revert InvalidSolvencyProof();

        chunkSubmitted[epoch][token][chunkIdx] = true;
        epochTotalSum[epoch][token] += partialSum;

        emit ChunkSubmitted(epoch, token, chunkIdx, partialSum);
    }

    /// @notice Finalizes an epoch for a given token, checking total live notes <= pool balance.
    function finalizeEpoch(uint256 epoch, address token) external returns (bool ok) {
        if (epochs[epoch][token].finalized) revert EpochAlreadyFinalized();

        uint256 totalLiveNotes = epochTotalSum[epoch][token];
        uint256 poolBalance = IERC20(token).balanceOf(address(pool));

        ok = (totalLiveNotes <= poolBalance);

        epochs[epoch][token] = EpochStatus({
            finalized: true,
            ok: ok,
            timestamp: uint64(block.timestamp),
            totalLiveNotes: totalLiveNotes,
            poolBalance: poolBalance
        });

        if (epoch > latestEpoch[token]) {
            latestEpoch[token] = epoch;
        }

        emit EpochFinalized(epoch, token, ok, totalLiveNotes, poolBalance);
        if (!ok) revert InsolventPool(totalLiveNotes, poolBalance);
    }

    function epochOk(address token) external view returns (bool ok, uint64 timestamp, uint256 liveNotes, uint256 poolBalance) {
        uint256 ep = latestEpoch[token];
        EpochStatus storage s = epochs[ep][token];
        if (!s.finalized) revert EpochNotFinalized();
        return (s.ok, s.timestamp, s.totalLiveNotes, s.poolBalance);
    }
}
