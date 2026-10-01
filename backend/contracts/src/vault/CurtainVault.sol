// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Curtain private-swap vault (docs/CURTAIN_V2_SPEC.md).
///
/// Users deposit token X with an opaque `deadlineHash`; everything else about the swap (output
/// token, recipient, minimum output, delay) lives in the operator's database. At payout time
/// the operator signs a *settlement*: one swap of pooled funds through an allowlisted router
/// plus the payouts it funds. Any keeper can submit it and earns the keeper fees. The swap and
/// its payouts happen in one transaction, so a deposit is never left swapped but unpaid — if a
/// settlement doesn't land before its deadline, the input tokens are still in the vault and
/// the escape hatch can return them (audit H-01).
///
/// Payouts carry a `tag` — keccak256(depositId, secret) — instead of the deposit id, so the
/// chain never links a deposit to its payout.
///
/// Escape hatch: if a deposit isn't paid, its depositor can request a refund 3 minutes after
/// their own (hidden) deadline. Anyone holding the payout secret can block it within 10
/// minutes by proving the deposit was already paid; otherwise the refund finalizes and the
/// full deposit goes back to the depositor.
///
/// Trust model (MVP): the operator key signs settlements, so it chooses swap prices and
/// recipients. A stolen operator key puts pooled funds at risk, and a malicious operator can
/// block a refund by paying 1 wei under that deposit's tag (audit M-02). The escape hatch
/// protects users from operator downtime, not from key theft. On-chain limits that do hold:
/// a settlement can't pay out more than its own swap produced, fees are capped, the swap
/// output must land in this vault, and router approvals are reset after every swap.
contract CurtainVault is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint64 public constant REFUND_DELAY = 3 minutes; // after the depositor's deadline
    uint64 public constant CHALLENGE_WINDOW = 10 minutes;
    uint16 public constant MAX_FEE_BPS = 100; // protocol fee cap: 1%
    uint16 public constant MAX_KEEPER_FEE_BPS = 100; // keeper fee cap: 1%
    uint256 private constant BPS = 10_000;

    bytes32 public constant SETTLEMENT_TYPEHASH =
        keccak256("Settlement(bytes32 swapHash,bytes32 payoutsHash,uint256 deadline,uint256 nonce)");

    enum Status {
        None,
        Active,
        RefundRequested,
        Settled,
        Refunded
    }

    struct Deposit {
        address depositor;
        address token;
        uint256 amount;
        bytes32 deadlineHash;
        uint64 refundRequestedAt;
        Status status;
    }

    /// @dev One swap of pooled funds. If tokenIn == tokenOut nothing is swapped (a private
    /// transfer) and `router`/`data` must be empty.
    struct Swap {
        address router;
        address tokenIn;
        uint256 amountIn;
        address tokenOut;
        uint256 minOut;
        bytes data;
    }

    /// @dev One payout in the swap's output token.
    struct Payout {
        address recipient;
        uint256 amount; // to the recipient
        uint256 protocolFee; // to the treasury
        uint256 keeperFee; // to whoever submits the settlement
        bytes32 tag; // keccak256(abi.encode(depositId, secret))
    }

    address public operator;
    address public treasury;
    uint16 public feeBps = 20;
    bool public depositsPaused;

    mapping(address => bool) public allowedToken;
    mapping(address => bool) public allowedRouter;

    uint256 public depositCount;
    mapping(uint256 => Deposit) public deposits;
    /// @dev depositor => deadlineHash => used. Per depositor so nobody can front-run a
    /// deposit by reusing its hash (audit M-01).
    mapping(address => mapping(bytes32 => bool)) public deadlineHashUsed;
    mapping(uint256 => bool) public nonceUsed;
    mapping(bytes32 => bool) public tagUsed;

    event Deposited(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, bytes32 deadlineHash);
    event Settled(uint256 indexed nonce, address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 amountOut, uint256 paid, address keeper);
    event PaidOut(bytes32 indexed tag, address indexed recipient, address indexed token, uint256 amount, uint256 protocolFee, uint256 keeperFee, address keeper);
    event RefundRequested(uint256 indexed depositId, uint256 deadline);
    event RefundChallenged(uint256 indexed depositId);
    event Refunded(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount);
    event OperatorSet(address operator);
    event TreasurySet(address treasury);
    event FeeSet(uint16 feeBps);
    event TokenAllowed(address indexed token, bool allowed);
    event RouterAllowed(address indexed router, bool allowed);
    event DepositsPaused(bool paused);

    error TokenNotAllowed(address token);
    error RouterNotAllowed(address router);
    error ZeroAmount();
    error DeadlineHashReused();
    error DepositsArePaused();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error SwapCallFailed();
    error InputMismatch(uint256 spent, uint256 amountIn);
    error BadSignature();
    error SettlementExpired();
    error NonceUsed();
    error TagUsed();
    error BadRecipient(address recipient);
    error FeeAboveCap();
    error PaysMoreThanSwapped(uint256 paid, uint256 amountOut);
    error NoPayouts();
    error NotSwap();
    error NotDepositor();
    error WrongStatus(Status status);
    error WrongDeadline();
    error TooEarly(uint256 availableAt);
    error ChallengeClosed();
    error NotPaid();
    error FeeTooHigh();
    error ZeroAddress();

    constructor(address admin, address operator_, address treasury_) Ownable(admin) EIP712("CurtainVault", "1") {
        if (operator_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        operator = operator_;
        treasury = treasury_;
        emit OperatorSet(operator_);
        emit TreasurySet(treasury_);
    }

    // ---- admin ----

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeSet(feeBps_);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function setAllowedRouter(address router, bool allowed) external onlyOwner {
        allowedRouter[router] = allowed;
        emit RouterAllowed(router, allowed);
    }

    /// @notice Stops new deposits (e.g. while investigating a bug). Settlements and the escape
    /// hatch keep working, so funds already in the vault can always leave.
    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPaused(paused);
    }

    // ---- deposit ----

    /// @notice Deposits `amount` of `token` for a swap described off-chain.
    /// `deadlineHash = keccak256(abi.encode(deadline, salt))` from the operator's intent; the
    /// depositor keeps (deadline, salt) to use the escape hatch.
    function deposit(address token, uint256 amount, bytes32 deadlineHash) external nonReentrant returns (uint256 depositId) {
        if (depositsPaused) revert DepositsArePaused();
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        if (deadlineHashUsed[msg.sender][deadlineHash]) revert DeadlineHashReused();
        deadlineHashUsed[msg.sender][deadlineHash] = true;

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;

        depositId = ++depositCount;
        deposits[depositId] = Deposit({
            depositor: msg.sender,
            token: token,
            amount: received,
            deadlineHash: deadlineHash,
            refundRequestedAt: 0,
            status: Status.Active
        });
        emit Deposited(depositId, msg.sender, token, received, deadlineHash);
    }

    // ---- settlements (any keeper) ----

    function hashSwap(Swap calldata s) public pure returns (bytes32) {
        return keccak256(abi.encode(s.router, s.tokenIn, s.amountIn, s.tokenOut, s.minOut, keccak256(s.data)));
    }

    function hashPayouts(Payout[] calldata payouts) public pure returns (bytes32) {
        return keccak256(abi.encode(payouts));
    }

    function settlementDigest(Swap calldata s, Payout[] calldata payouts, uint256 deadline, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, hashSwap(s), hashPayouts(payouts), deadline, nonce)));
    }

    /// @notice Executes an operator-signed settlement: the swap, then every payout, atomically.
    /// Callable by anyone; the caller receives the keeper fees. Everything is fixed by the
    /// signature, and the payouts can't exceed what the swap produced.
    function settle(Swap calldata s, Payout[] calldata payouts, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SettlementExpired();
        if (nonceUsed[nonce]) revert NonceUsed();
        if (payouts.length == 0) revert NoPayouts();
        if (ECDSA.recover(settlementDigest(s, payouts, deadline, nonce), signature) != operator) revert BadSignature();
        nonceUsed[nonce] = true;

        uint256 amountOut = _swap(s);

        IERC20 token = IERC20(s.tokenOut);
        uint256 paid;
        uint256 keeperTotal;
        uint256 protocolTotal;
        for (uint256 i = 0; i < payouts.length; i++) {
            Payout calldata p = payouts[i];
            if (p.recipient == address(0) || p.recipient == address(this)) revert BadRecipient(p.recipient);
            if (tagUsed[p.tag]) revert TagUsed();
            tagUsed[p.tag] = true;

            uint256 gross = p.amount + p.protocolFee + p.keeperFee;
            if (p.protocolFee * BPS > gross * feeBps || p.keeperFee * BPS > gross * MAX_KEEPER_FEE_BPS) revert FeeAboveCap();
            paid += gross;
            protocolTotal += p.protocolFee;
            keeperTotal += p.keeperFee;

            if (p.amount > 0) token.safeTransfer(p.recipient, p.amount);
            emit PaidOut(p.tag, p.recipient, s.tokenOut, p.amount, p.protocolFee, p.keeperFee, msg.sender);
        }
        if (paid > amountOut) revert PaysMoreThanSwapped(paid, amountOut);
        if (protocolTotal > 0) token.safeTransfer(treasury, protocolTotal);
        if (keeperTotal > 0) token.safeTransfer(msg.sender, keeperTotal);

        emit Settled(nonce, s.tokenIn, s.amountIn, s.tokenOut, amountOut, paid, msg.sender);
    }

    /// @dev Swaps through an allowlisted router; the output must land here, the router may pull
    /// at most `amountIn`, and the approval is reset. Same-token settlements skip the swap.
    function _swap(Swap calldata s) internal returns (uint256 amountOut) {
        if (!allowedToken[s.tokenIn]) revert TokenNotAllowed(s.tokenIn);
        if (!allowedToken[s.tokenOut]) revert TokenNotAllowed(s.tokenOut);
        if (s.tokenIn == s.tokenOut) {
            if (s.router != address(0) || s.data.length != 0) revert NotSwap();
            return s.amountIn;
        }
        if (!allowedRouter[s.router]) revert RouterNotAllowed(s.router);
        if (s.minOut == 0) revert InsufficientOutput(0, 0);

        IERC20 tokenIn = IERC20(s.tokenIn);
        uint256 inBefore = tokenIn.balanceOf(address(this));
        uint256 outBefore = IERC20(s.tokenOut).balanceOf(address(this));

        tokenIn.forceApprove(s.router, s.amountIn);
        (bool ok,) = s.router.call(s.data);
        if (!ok) revert SwapCallFailed();
        tokenIn.forceApprove(s.router, 0);

        uint256 spent = inBefore - tokenIn.balanceOf(address(this));
        if (spent > s.amountIn) revert InputMismatch(spent, s.amountIn); // defensive: approval already bounds this
        amountOut = IERC20(s.tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < s.minOut) revert InsufficientOutput(amountOut, s.minOut);
    }

    // ---- escape hatch ----

    function requestRefund(uint256 depositId, uint256 deadline, bytes32 salt) external {
        Deposit storage d = deposits[depositId];
        if (msg.sender != d.depositor) revert NotDepositor();
        if (d.status != Status.Active) revert WrongStatus(d.status);
        if (keccak256(abi.encode(deadline, salt)) != d.deadlineHash) revert WrongDeadline();
        if (block.timestamp < deadline + REFUND_DELAY) revert TooEarly(deadline + REFUND_DELAY);

        d.status = Status.RefundRequested;
        d.refundRequestedAt = uint64(block.timestamp);
        emit RefundRequested(depositId, deadline);
    }

    /// @notice Blocks a refund by proving a payout for this deposit already happened. Reveals
    /// the deposit/payout link, which is only needed when someone tries to be paid twice.
    function challengeRefund(uint256 depositId, bytes32 secret) external {
        Deposit storage d = deposits[depositId];
        if (d.status != Status.RefundRequested) revert WrongStatus(d.status);
        if (block.timestamp > d.refundRequestedAt + CHALLENGE_WINDOW) revert ChallengeClosed();
        if (!tagUsed[keccak256(abi.encode(depositId, secret))]) revert NotPaid();

        d.status = Status.Settled;
        emit RefundChallenged(depositId);
    }

    function finalizeRefund(uint256 depositId) external nonReentrant {
        Deposit storage d = deposits[depositId];
        if (d.status != Status.RefundRequested) revert WrongStatus(d.status);
        uint256 availableAt = uint256(d.refundRequestedAt) + CHALLENGE_WINDOW;
        if (block.timestamp <= availableAt) revert TooEarly(availableAt + 1);

        d.status = Status.Refunded;
        IERC20(d.token).safeTransfer(d.depositor, d.amount);
        emit Refunded(depositId, d.depositor, d.token, d.amount);
    }

    /// @notice keccak256(abi.encode(depositId, secret)) — the tag a payout for this deposit carries.
    function tagFor(uint256 depositId, bytes32 secret) external pure returns (bytes32) {
        return keccak256(abi.encode(depositId, secret));
    }
}
