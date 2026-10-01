// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Stake-to-earn with lock tiers (docs/CURTAIN_V2_SPEC.md).
///
/// - Stake and reward tokens are plugged in once by the admin (`setTokens`), so the contract
///   can ship before $CRTN launches. Staking is disabled until then.
/// - Each stake is a position locked for 30 / 90 / 180 days, earning on amount × 1 / 1.5 / 2.
/// - Emissions are funded per period (`notifyRewardAmount(amount, duration)`), Synthetix
///   style: rewards stream linearly over the period, and any unstreamed remainder rolls into
///   the next period. No fixed schedule is baked in.
/// - Rewards can be claimed any time; principal only after unlock.
/// - If stake and reward are the same token, principal is tracked separately (`totalStaked`),
///   so funding checks never count stakers' principal as rewards.
/// - Once a position unlocks it no longer earns its lock multiplier: anyone can `kick` it back
///   to 1x (audit M-03). Withdrawing still requires the unlock.
/// - While nobody is staked, the reward period is paused (extended) instead of streaming to
///   no one, so funded rewards are never stranded (audit L-04).
contract CurtainStaking is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TIER_COUNT = 3;
    uint256 private constant PRECISION = 1e18;
    uint256 private constant BPS = 10_000;

    struct Position {
        address owner;
        uint256 amount;
        uint256 weighted; // amount × multiplier
        uint64 unlockAt;
        uint256 rewardPerWeightPaid;
        uint256 pending;
        bool closed;
    }

    IERC20 public stakeToken;
    IERC20 public rewardToken;

    uint256 public totalStaked;
    uint256 public totalWeighted;

    uint256 public rewardRate; // reward tokens per second, scaled by PRECISION
    uint256 public periodFinish;
    uint256 public lastUpdate;
    uint256 public rewardPerWeightStored; // scaled by PRECISION

    uint256 public positionCount;
    mapping(uint256 => Position) public positions;

    event TokensSet(address stakeToken, address rewardToken);
    event Staked(uint256 indexed positionId, address indexed owner, uint256 amount, uint8 tier, uint64 unlockAt);
    event Withdrawn(uint256 indexed positionId, address indexed owner, uint256 amount);
    event RewardPaid(uint256 indexed positionId, address indexed owner, uint256 reward);
    event RewardAdded(uint256 amount, uint256 duration, uint256 periodFinish);
    event Kicked(uint256 indexed positionId, uint256 newWeighted);

    error TokensAlreadySet();
    error TokensNotSet();
    error ZeroAddress();
    error ZeroAmount();
    error BadTier(uint8 tier);
    error NotOwner();
    error Locked(uint64 unlockAt);
    error PositionClosed();
    error ZeroDuration();
    error RewardTooHigh();
    error NotKickable();

    constructor(address admin) Ownable(admin) {}

    // ---- tiers ----

    function tier(uint8 t) public pure returns (uint64 lockSeconds, uint256 multiplierBps) {
        if (t == 0) return (30 days, 10_000);
        if (t == 1) return (90 days, 15_000);
        if (t == 2) return (180 days, 20_000);
        revert BadTier(t);
    }

    // ---- admin ----

    function setTokens(address stakeToken_, address rewardToken_) external onlyOwner {
        if (address(stakeToken) != address(0)) revert TokensAlreadySet();
        if (stakeToken_ == address(0) || rewardToken_ == address(0)) revert ZeroAddress();
        stakeToken = IERC20(stakeToken_);
        rewardToken = IERC20(rewardToken_);
        emit TokensSet(stakeToken_, rewardToken_);
    }

    /// @notice Funds a reward period: pulls `amount` of the reward token and streams it (plus
    /// any unstreamed remainder of the current period) over `duration` seconds.
    function notifyRewardAmount(uint256 amount, uint256 duration) external onlyOwner nonReentrant {
        if (address(rewardToken) == address(0)) revert TokensNotSet();
        if (duration == 0) revert ZeroDuration();
        _updateGlobal();

        rewardToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 remaining = block.timestamp < periodFinish ? (periodFinish - block.timestamp) * rewardRate : 0;
        rewardRate = (amount * PRECISION + remaining) / duration;
        lastUpdate = block.timestamp;
        periodFinish = block.timestamp + duration;

        // Everything promised must be backed by tokens actually held (net of staked principal).
        uint256 held = rewardToken.balanceOf(address(this));
        if (address(rewardToken) == address(stakeToken)) held -= totalStaked;
        if (rewardRate * duration > held * PRECISION) revert RewardTooHigh();

        emit RewardAdded(amount, duration, periodFinish);
    }

    // ---- views ----

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerWeight() public view returns (uint256) {
        if (totalWeighted == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + ((lastTimeRewardApplicable() - lastUpdate) * rewardRate) / totalWeighted;
    }

    function earned(uint256 positionId) public view returns (uint256) {
        Position storage p = positions[positionId];
        return p.pending + (p.weighted * (rewardPerWeight() - p.rewardPerWeightPaid)) / PRECISION;
    }

    // ---- staking ----

    function stake(uint256 amount, uint8 t) external nonReentrant returns (uint256 positionId) {
        if (address(stakeToken) == address(0)) revert TokensNotSet();
        if (amount == 0) revert ZeroAmount();
        (uint64 lockSeconds, uint256 multiplierBps) = tier(t);
        _updateGlobal();

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 weighted = (amount * multiplierBps) / BPS;
        positionId = ++positionCount;
        positions[positionId] = Position({
            owner: msg.sender,
            amount: amount,
            weighted: weighted,
            unlockAt: uint64(block.timestamp) + lockSeconds,
            rewardPerWeightPaid: rewardPerWeightStored,
            pending: 0,
            closed: false
        });
        totalStaked += amount;
        totalWeighted += weighted;
        emit Staked(positionId, msg.sender, amount, t, uint64(block.timestamp) + lockSeconds);
    }

    /// @notice Drops an unlocked position's weight to 1x. Callable by anyone; rewards earned
    /// so far at the old weight are kept.
    function kick(uint256 positionId) external nonReentrant {
        Position storage p = positions[positionId];
        if (p.closed || block.timestamp < p.unlockAt || p.weighted <= p.amount) revert NotKickable();
        _updateGlobal();
        p.pending = earned(positionId);
        p.rewardPerWeightPaid = rewardPerWeightStored;
        totalWeighted = totalWeighted - p.weighted + p.amount;
        p.weighted = p.amount;
        emit Kicked(positionId, p.amount);
    }

    function claim(uint256 positionId) public nonReentrant returns (uint256 reward) {
        reward = _claim(positionId);
    }

    /// @notice Withdraws principal (after unlock) and any unclaimed rewards; closes the position.
    function withdraw(uint256 positionId) external nonReentrant {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.closed) revert PositionClosed();
        if (block.timestamp < p.unlockAt) revert Locked(p.unlockAt);

        _claim(positionId);
        p.closed = true;
        totalStaked -= p.amount;
        totalWeighted -= p.weighted;
        stakeToken.safeTransfer(msg.sender, p.amount);
        emit Withdrawn(positionId, msg.sender, p.amount);
    }

    function _claim(uint256 positionId) internal returns (uint256 reward) {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.closed) revert PositionClosed();
        _updateGlobal();
        reward = earned(positionId);
        p.rewardPerWeightPaid = rewardPerWeightStored;
        p.pending = 0;
        if (reward > 0) {
            rewardToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(positionId, msg.sender, reward);
        }
    }

    function _updateGlobal() internal {
        if (totalWeighted == 0) {
            // Nobody to stream to: keep the unstreamed remainder of the period for later
            // instead of streaming it to no one.
            if (lastUpdate < periodFinish && block.timestamp > lastUpdate) {
                periodFinish = block.timestamp + (periodFinish - lastUpdate);
            }
            lastUpdate = block.timestamp < periodFinish ? block.timestamp : periodFinish;
            return;
        }
        rewardPerWeightStored = rewardPerWeight();
        lastUpdate = lastTimeRewardApplicable();
    }
}
