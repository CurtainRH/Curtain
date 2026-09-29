// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IScreeningGateGov {
    function addProvider(uint8 id, address publisher, bytes32 initialListRoot, bytes32 initialFlagRoot) external;
    function removeProvider(uint8 id) external;
}

interface IRelayAdaptGov {
    function setAllowedTarget(address target, bool allowed) external;
}

/// @notice $CRTN Staking, Fee Router, and Governance parameter voting contract,
/// per Curtain_Build.md §3.9 & §2.7.
///
/// STAKING & FEES:
/// - Stakers deposit $CRTN to receive governor shares and earn pool fees.
/// - Fee router splits incoming shield/unshield fees 60/40:
///   - 60% distributed proportionally to $CRTN stakers ("governors").
///   - 40% transferred to protocol treasury / prover costs.
///
/// GOVERNANCE:
/// - Governors (stakers) can vote on allowed protocol parameter changes:
///   1. Provider add/remove on ScreeningGate
///   2. Allowed RelayAdapt execution targets
///   3. Protocol fee BPS within bounds [10, 30] (0.10% - 0.30%)
/// - Note logic remains strictly immutable and untouched.
contract CrtnStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable crtnToken;
    address public immutable treasury;

    uint256 public totalStaked;
    mapping(address => uint256) public stakedBalance;

    // Fee distribution state (per token)
    address[] public feeTokens;
    mapping(address => bool) public isFeeToken;
    mapping(address => uint256) public accFeePerShare; // scaled by 1e18
    mapping(address => mapping(address => uint256)) public rewardDebt; // user => token => debt

    // Governance parameters
    uint64 public constant VOTING_PERIOD = 3 days;
    uint256 public constant MIN_PROPOSAL_STAKE = 100_000 ether; // 100,000 $CRTN required to propose
    uint16 public constant MIN_FEE_BPS = 10; // 0.10%
    uint16 public constant MAX_FEE_BPS = 30; // 0.30%

    uint16 public currentFeeBps = 20; // Default 0.20%

    enum ProposalType {
        SetFeeBps,
        AddProvider,
        RemoveProvider,
        AddRelayTarget,
        RemoveRelayTarget
    }

    struct ProviderData {
        uint8 providerId;
        address publisher;
        bytes32 listRoot;
        bytes32 flagRoot;
    }

    struct Proposal {
        uint256 id;
        address proposer;
        ProposalType pType;
        address targetContract;
        ProviderData provider;
        address relayTarget;
        uint16 proposedFeeBps;
        uint64 startTime;
        uint64 endTime;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
        bool canceled;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event FeesReceived(address indexed token, uint256 totalAmount, uint256 stakerShare, uint256 treasuryShare);
    event FeesClaimed(address indexed user, address indexed token, uint256 amount);

    event ProposalCreated(uint256 indexed id, address indexed proposer, ProposalType pType);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId);
    event FeeBpsUpdated(uint16 newFeeBps);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientStake();
    error FeeBpsOutOfBounds();
    error InsufficientStakeToPropose();
    error ProposalNotActive();
    error AlreadyVoted();
    error NoVotingPower();
    error ProposalNotEnded();
    error ProposalAlreadyExecuted();
    error ProposalFailed();

    constructor(address crtnTokenAddr, address treasuryAddr) {
        if (crtnTokenAddr == address(0) || treasuryAddr == address(0)) revert ZeroAddress();
        crtnToken = IERC20(crtnTokenAddr);
        treasury = treasuryAddr;
    }

    // --- STAKING & FEE HARVESTING ---

    function feeTokensCount() external view returns (uint256) {
        return feeTokens.length;
    }

    /// @notice Stake CRTN tokens to earn governor voting weight and pool fees.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        _claimAllPending(msg.sender);

        crtnToken.safeTransferFrom(msg.sender, address(this), amount);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;

        _updateRewardDebts(msg.sender);

        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake CRTN tokens.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (stakedBalance[msg.sender] < amount) revert InsufficientStake();

        _claimAllPending(msg.sender);

        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;

        _updateRewardDebts(msg.sender);

        crtnToken.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    /// @notice Receive pool shield/unshield fees and split 60% stakers / 40% treasury.
    function receiveFees(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (token == address(0)) revert ZeroAddress();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        uint256 treasuryShare = (amount * 40) / 100;
        uint256 stakerShare = amount - treasuryShare;

        if (treasuryShare > 0) {
            IERC20(token).safeTransfer(treasury, treasuryShare);
        }

        if (stakerShare > 0) {
            if (totalStaked == 0) {
                // If no stakers exist, transfer staker share to treasury to prevent stuck fees
                IERC20(token).safeTransfer(treasury, stakerShare);
            } else {
                if (!isFeeToken[token]) {
                    isFeeToken[token] = true;
                    feeTokens.push(token);
                }
                accFeePerShare[token] += (stakerShare * 1e18) / totalStaked;
            }
        }

        emit FeesReceived(token, amount, stakerShare, treasuryShare);
    }

    /// @notice Query accumulated pending fees for a staker and fee token.
    function pendingFees(address staker, address token) public view returns (uint256) {
        uint256 balance = stakedBalance[staker];
        if (balance == 0) return 0;
        uint256 accumulated = (balance * accFeePerShare[token]) / 1e18;
        uint256 debt = rewardDebt[staker][token];
        if (accumulated <= debt) return 0;
        return accumulated - debt;
    }

    /// @notice Claim pending fees for a specific token.
    function claimFees(address token) external nonReentrant {
        uint256 pending = pendingFees(msg.sender, token);
        rewardDebt[msg.sender][token] = (stakedBalance[msg.sender] * accFeePerShare[token]) / 1e18;
        if (pending > 0) {
            IERC20(token).safeTransfer(msg.sender, pending);
            emit FeesClaimed(msg.sender, token, pending);
        }
    }

    /// @notice Claim pending fees across all tracked fee tokens.
    function claimAllFees() external nonReentrant {
        _claimAllPending(msg.sender);
        _updateRewardDebts(msg.sender);
    }

    function _claimAllPending(address staker) internal {
        uint256 len = feeTokens.length;
        for (uint256 i = 0; i < len; i++) {
            address token = feeTokens[i];
            uint256 pending = pendingFees(staker, token);
            if (pending > 0) {
                rewardDebt[staker][token] = (stakedBalance[staker] * accFeePerShare[token]) / 1e18;
                IERC20(token).safeTransfer(staker, pending);
                emit FeesClaimed(staker, token, pending);
            }
        }
    }

    function _updateRewardDebts(address staker) internal {
        uint256 len = feeTokens.length;
        uint256 balance = stakedBalance[staker];
        for (uint256 i = 0; i < len; i++) {
            address token = feeTokens[i];
            rewardDebt[staker][token] = (balance * accFeePerShare[token]) / 1e18;
        }
    }

    // --- GOVERNANCE PROPOSALS & VOTING ---

    function getProposalSummary(uint256 proposalId) external view returns (
        uint256 id,
        address proposer,
        ProposalType pType,
        address targetContract,
        uint64 startTime,
        uint64 endTime,
        uint256 forVotes,
        uint256 againstVotes,
        bool executed
    ) {
        Proposal storage p = _proposals[proposalId];
        return (
            p.id,
            p.proposer,
            p.pType,
            p.targetContract,
            p.startTime,
            p.endTime,
            p.forVotes,
            p.againstVotes,
            p.executed
        );
    }

    function proposeSetFeeBps(uint16 feeBps) external returns (uint256 proposalId) {
        if (stakedBalance[msg.sender] < MIN_PROPOSAL_STAKE) revert InsufficientStakeToPropose();
        if (feeBps < MIN_FEE_BPS || feeBps > MAX_FEE_BPS) revert FeeBpsOutOfBounds();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.pType = ProposalType.SetFeeBps;
        p.proposedFeeBps = feeBps;
        p.startTime = uint64(block.timestamp);
        p.endTime = uint64(block.timestamp + VOTING_PERIOD);

        emit ProposalCreated(proposalId, msg.sender, ProposalType.SetFeeBps);
    }

    function proposeAddProvider(
        address gateContract,
        uint8 providerId,
        address publisher,
        bytes32 listRoot,
        bytes32 flagRoot
    ) external returns (uint256 proposalId) {
        if (stakedBalance[msg.sender] < MIN_PROPOSAL_STAKE) revert InsufficientStakeToPropose();
        if (gateContract == address(0)) revert ZeroAddress();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.pType = ProposalType.AddProvider;
        p.targetContract = gateContract;
        p.provider = ProviderData({
            providerId: providerId,
            publisher: publisher,
            listRoot: listRoot,
            flagRoot: flagRoot
        });
        p.startTime = uint64(block.timestamp);
        p.endTime = uint64(block.timestamp + VOTING_PERIOD);

        emit ProposalCreated(proposalId, msg.sender, ProposalType.AddProvider);
    }

    function proposeRemoveProvider(
        address gateContract,
        uint8 providerId
    ) external returns (uint256 proposalId) {
        if (stakedBalance[msg.sender] < MIN_PROPOSAL_STAKE) revert InsufficientStakeToPropose();
        if (gateContract == address(0)) revert ZeroAddress();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.pType = ProposalType.RemoveProvider;
        p.targetContract = gateContract;
        p.provider.providerId = providerId;
        p.startTime = uint64(block.timestamp);
        p.endTime = uint64(block.timestamp + VOTING_PERIOD);

        emit ProposalCreated(proposalId, msg.sender, ProposalType.RemoveProvider);
    }

    function proposeRelayTarget(
        address adaptContract,
        address target,
        bool allowed
    ) external returns (uint256 proposalId) {
        if (stakedBalance[msg.sender] < MIN_PROPOSAL_STAKE) revert InsufficientStakeToPropose();
        if (adaptContract == address(0) || target == address(0)) revert ZeroAddress();

        ProposalType pType = allowed ? ProposalType.AddRelayTarget : ProposalType.RemoveRelayTarget;
        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.pType = pType;
        p.targetContract = adaptContract;
        p.relayTarget = target;
        p.startTime = uint64(block.timestamp);
        p.endTime = uint64(block.timestamp + VOTING_PERIOD);

        emit ProposalCreated(proposalId, msg.sender, pType);
    }

    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0 || block.timestamp > p.endTime || p.executed || p.canceled) {
            revert ProposalNotActive();
        }
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        uint256 weight = stakedBalance[msg.sender];
        if (weight == 0) revert NoVotingPower();

        hasVoted[proposalId][msg.sender] = true;
        if (support) {
            p.forVotes += weight;
        } else {
            p.againstVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    function executeProposal(uint256 proposalId) external nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.id == 0) revert ProposalNotActive();
        if (block.timestamp <= p.endTime) revert ProposalNotEnded();
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.forVotes <= p.againstVotes) revert ProposalFailed();

        p.executed = true;

        if (p.pType == ProposalType.SetFeeBps) {
            currentFeeBps = p.proposedFeeBps;
            emit FeeBpsUpdated(p.proposedFeeBps);
        } else if (p.pType == ProposalType.AddProvider) {
            IScreeningGateGov(p.targetContract).addProvider(
                p.provider.providerId,
                p.provider.publisher,
                p.provider.listRoot,
                p.provider.flagRoot
            );
        } else if (p.pType == ProposalType.RemoveProvider) {
            IScreeningGateGov(p.targetContract).removeProvider(p.provider.providerId);
        } else if (p.pType == ProposalType.AddRelayTarget) {
            IRelayAdaptGov(p.targetContract).setAllowedTarget(p.relayTarget, true);
        } else if (p.pType == ProposalType.RemoveRelayTarget) {
            IRelayAdaptGov(p.targetContract).setAllowedTarget(p.relayTarget, false);
        }

        emit ProposalExecuted(proposalId);
    }
}
