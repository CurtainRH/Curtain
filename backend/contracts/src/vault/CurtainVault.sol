// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Curtain private-swap vault (docs/CURTAIN_V2_SPEC.md).
///
/// Users deposit token X with an opaque `deadlineHash`; everything else about the swap (output
/// token, recipient, minimum output, delay) lives in the operator's database. At payout time
/// the operator swaps the vault's pooled funds through an allowlisted router (`executeSwap`)
/// and signs a `Payout` that any keeper can submit for a fee. Payouts carry a `tag` —
/// keccak256(depositId, secret) — instead of the deposit id, so the chain never links a
/// deposit to its payout.
///
/// Escape hatch: if a deposit isn't paid, its depositor can request a refund 3 minutes after
/// their own (hidden) deadline. Anyone holding the payout secret can block it within 10
/// minutes by proving the deposit was already paid; otherwise the refund finalizes and the
/// full deposit goes back to the depositor.
///
/// Trust model (MVP): the operator key signs payouts to any recipient and chooses swap
/// prices, so a stolen operator key puts pooled funds at risk. The escape hatch protects users
/// from operator downtime, not from key theft. Swap output must land in this vault and router
/// approvals are reset after every swap, but pricing (minOut) is the operator's call.
contract CurtainVault is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint64 public constant REFUND_DELAY = 3 minutes; // after the depositor's deadline
    uint64 public constant CHALLENGE_WINDOW = 10 minutes;
    uint16 public constant MAX_FEE_BPS = 100;

    bytes32 public constant PAYOUT_TYPEHASH = keccak256(
        "Payout(address recipient,address token,uint256 amount,uint256 protocolFee,uint256 keeperFee,uint256 deadline,uint256 nonce,bytes32 tag)"
    );

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

    struct Payout {
        address recipient;
        address token;
        uint256 amount; // to the recipient
        uint256 protocolFee; // to the treasury
        uint256 keeperFee; // to whoever submits
        uint256 deadline; // signature expiry
        uint256 nonce;
        bytes32 tag; // keccak256(abi.encode(depositId, secret))
    }

    address public operator;
    address public treasury;
    uint16 public feeBps = 20;

    mapping(address => bool) public allowedToken;
    mapping(address => bool) public allowedRouter;

    uint256 public depositCount;
    mapping(uint256 => Deposit) public deposits;
    mapping(bytes32 => bool) public deadlineHashUsed;
    mapping(uint256 => bool) public nonceUsed;
    mapping(bytes32 => bool) public tagUsed;

    event Deposited(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount, bytes32 deadlineHash);
    event Swapped(address indexed router, address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 amountOut);
    event PaidOut(bytes32 indexed tag, address indexed recipient, address indexed token, uint256 amount, uint256 protocolFee, uint256 keeperFee, address keeper);
    event RefundRequested(uint256 indexed depositId, uint256 deadline);
    event RefundChallenged(uint256 indexed depositId);
    event Refunded(uint256 indexed depositId, address indexed depositor, address indexed token, uint256 amount);
    event OperatorSet(address operator);
    event TreasurySet(address treasury);
    event FeeSet(uint16 feeBps);
    event TokenAllowed(address indexed token, bool allowed);
    event RouterAllowed(address indexed router, bool allowed);

    error NotOperator();
    error TokenNotAllowed(address token);
    error RouterNotAllowed(address router);
    error ZeroAmount();
    error DeadlineHashReused();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error SwapCallFailed();
    error InputMismatch(uint256 spent, uint256 amountIn);
    error BadSignature();
    error PayoutExpired();
    error NonceUsed();
    error TagUsed();
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

    // ---- deposit ----

    /// @notice Deposits `amount` of `token` for a swap described off-chain.
    /// `deadlineHash = keccak256(abi.encode(deadline, salt))` from the operator's intent; the
    /// depositor keeps (deadline, salt) to use the escape hatch.
    function deposit(address token, uint256 amount, bytes32 deadlineHash) external nonReentrant returns (uint256 depositId) {
        if (!allowedToken[token]) revert TokenNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        if (deadlineHashUsed[deadlineHash]) revert DeadlineHashReused();
        deadlineHashUsed[deadlineHash] = true;

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

    // ---- operator: swaps ----

    /// @notice Swaps `amountIn` of the vault's `tokenIn` for at least `minOut` of `tokenOut`
    /// through an allowlisted router. The output must arrive in this vault, the router may
    /// pull at most `amountIn`, and the approval is reset afterwards.
    function executeSwap(address router, address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut, bytes calldata data)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != operator) revert NotOperator();
        if (!allowedRouter[router]) revert RouterNotAllowed(router);
        if (!allowedToken[tokenIn]) revert TokenNotAllowed(tokenIn);
        if (!allowedToken[tokenOut]) revert TokenNotAllowed(tokenOut);
        if (minOut == 0) revert InsufficientOutput(0, 0);

        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(router, amountIn);
        (bool ok,) = router.call(data);
        if (!ok) revert SwapCallFailed();
        IERC20(tokenIn).forceApprove(router, 0);

        uint256 spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        if (spent > amountIn) revert InputMismatch(spent, amountIn);
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        emit Swapped(router, tokenIn, spent, tokenOut, amountOut);
    }

    // ---- payouts (any keeper) ----

    function payoutDigest(Payout calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYOUT_TYPEHASH, p.recipient, p.token, p.amount, p.protocolFee, p.keeperFee, p.deadline, p.nonce, p.tag
                )
            )
        );
    }

    /// @notice Executes an operator-signed payout. Callable by anyone; the caller receives
    /// `keeperFee`. Recipient and amounts are fixed by the signature.
    function payout(Payout calldata p, bytes calldata signature) external nonReentrant {
        if (block.timestamp > p.deadline) revert PayoutExpired();
        if (nonceUsed[p.nonce]) revert NonceUsed();
        if (tagUsed[p.tag]) revert TagUsed();
        if (ECDSA.recover(payoutDigest(p), signature) != operator) revert BadSignature();
        nonceUsed[p.nonce] = true;
        tagUsed[p.tag] = true;

        IERC20 token = IERC20(p.token);
        if (p.amount > 0) token.safeTransfer(p.recipient, p.amount);
        if (p.protocolFee > 0) token.safeTransfer(treasury, p.protocolFee);
        if (p.keeperFee > 0) token.safeTransfer(msg.sender, p.keeperFee);

        emit PaidOut(p.tag, p.recipient, p.token, p.amount, p.protocolFee, p.keeperFee, msg.sender);
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
