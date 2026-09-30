// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CurtainPool} from "../pool/CurtainPool.sol";

/// @notice Atomic unshield -> arbitrary calls -> reshield, per
/// Curtain_Build.md §3.3 ("relay"). Lets a recipe like BuyAndShield unshield
/// a note, swap on a DEX, and shield the proceeds back in — all inside one
/// transaction, so the swapped funds are never visible on-chain as a plain
/// unshielded balance sitting between two separate user transactions.
///
/// TWO DELIBERATE DEVIATIONS FROM SPEC'S PSEUDOCODE, both for the same
/// reason M3's shield() already deviated (see Curtain_Build.md §11 item 7):
///
/// 1. `relay()` takes each reshield output's plaintext opening (ownerPkX,
///    blinding) instead of a pre-built `reshieldCommits[i]`. Accepting an
///    opaque commitment without verifying its internal structure would let
///    a relay claim a reshielded note worth more than the swap actually
///    produced — the same solvency-draining bug class `shield()` already
///    had to avoid. `CurtainPool.reshield()` computes the commitment itself
///    from the real post-swap balance, exactly like `shield()` does from
///    the real net deposit.
///
/// 2. `broadcaster`/`broadcasterFee`/`feeToken` from the spec's IRelayAdapt
///    interface are omitted for M6. Paying a broadcaster fee "inside the
///    proof" only means something once bonded broadcasters exist to
///    receive it (§4.1, M7) — wiring a fee payment with no one to pay it to
///    yet would be untested, unused surface area. `relay()`'s caller pays
///    their own gas directly for now; extending this once M7 lands is a
///    signature addition, not a redesign.
///
/// PROOF BINDING (post-audit fix): the join-split proof's `extDataHash` covers
/// `unshield.extData`, and `relay()` requires `unshield.extData == relayDataHash(calls,
/// outputs, origin)`. Before this, a front-runner or the broadcaster could resend a user's
/// proof with their own calls (e.g. `usdg.transfer(attacker, amount)`) and take the funds —
/// see test/adapt/RelayFrontRun.t.sol. The broadcaster's fee is now paid by the pool from
/// the proved `feeAmount` to `unshield.feeRecipient`, so deviation 2 above no longer applies.
///
/// Approvals made by `approve` calls are reset to zero after the calls run, and the relay
/// reverts if this contract is left holding any ETH (Curtain_Build.md §3.3, §10).
///
/// RESHIELD GATING: see CurtainPool.sol's header for why `relayAdapt` is an
/// immutable set via predicted-address deployment ordering rather than a
/// mutable setter.
///
/// `allowedTarget` is owner-gated (meant to become a TimelockController per
/// the deploy runbook §7 step 9 and §3.9, same pattern as AssetGate) —
/// RelayAdapt makes no claim to being admin-free the way CurtainPool does;
/// spec explicitly calls targets "timelock-managed".
interface IGuardianView {
    function relayPaused() external view returns (bool);
}

contract RelayAdapt is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// @dev Plaintext opening for one reshielded output note — see this
    /// file's header, deviation 1.
    struct ReshieldOutput {
        address token;
        uint256 ownerPkX;
        uint256 blinding;
        bytes ephemeralPk;
        bytes ct;
        uint256 minOut; // reverts if this relay produced less than this of `token`
    }

    CurtainPool public immutable pool;
    mapping(address => bool) public allowedTarget;

    event TargetAllowed(address indexed target, bool allowed);
    event Relayed(address indexed caller, address indexed origin, uint256 callCount, uint256 outputCount);

    error TargetNotAllowed(address target);
    error CallFailed(uint256 index);
    error InsufficientOutput(address token, uint256 balance, uint256 minOut);
    error UnshieldMustTargetThis();
    error Residue(address token, uint256 balance);
    error RelayDataMismatch();
    error RelayPausedByGuardian();
    error EthResidue(uint256 balance);

    constructor(address poolAddr, address initialOwner) Ownable(initialOwner) {
        pool = CurtainPool(poolAddr);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    /// @notice The value a relay proof must put in `unshield.extData`. Binds the exact calls,
    /// reshield outputs (owners included) and origin, plus this contract and chain.
    function relayDataHash(Call[] calldata calls, ReshieldOutput[] calldata outputs, address origin)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), calls, outputs, origin));
    }

    /// @notice Unshields via `unshield` (must set `unshieldTo = address(this)`),
    /// executes `calls` against allowlisted targets only, then reshields the
    /// resulting balance of each `outputs[i].token` back into the pool under
    /// `origin`. Reverts if any target is disallowed, any call fails, any
    /// output falls short of its `minOut`, or any touched token has a
    /// nonzero leftover balance afterward (no dust left behind in this
    /// contract — see this file's header on why full generic residue
    /// checking isn't attempted for tokens the caller never declared).
    function relay(
        CurtainPool.TransactArgs calldata unshield,
        Call[] calldata calls,
        ReshieldOutput[] calldata outputs,
        address origin
    ) external nonReentrant {
        if (unshield.unshieldTo != address(this)) revert UnshieldMustTargetThis();
        if (unshield.extData != relayDataHash(calls, outputs, origin)) revert RelayDataMismatch();
        IGuardianView g = IGuardianView(address(pool.guardian()));
        if (address(g) != address(0) && g.relayPaused()) revert RelayPausedByGuardian();

        pool.transact(unshield);

        for (uint256 i = 0; i < calls.length; i++) {
            if (!allowedTarget[calls[i].to]) revert TargetNotAllowed(calls[i].to);
            (bool ok,) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert CallFailed(i);
        }
        _resetApprovals(calls);

        if (unshield.unshieldAmount > 0) {
            uint256 inputResidue = IERC20(unshield.token).balanceOf(address(this));
            if (inputResidue > 0) revert Residue(unshield.token, inputResidue);
        }

        for (uint256 i = 0; i < outputs.length; i++) {
            ReshieldOutput calldata o = outputs[i];
            uint256 bal = IERC20(o.token).balanceOf(address(this));
            if (bal < o.minOut) revert InsufficientOutput(o.token, bal, o.minOut);

            IERC20(o.token).forceApprove(address(pool), bal);
            pool.reshield(o.token, bal, o.ownerPkX, o.blinding, o.ephemeralPk, o.ct, origin);

            uint256 residue = IERC20(o.token).balanceOf(address(this));
            if (residue > 0) revert Residue(o.token, residue);
        }

        if (address(this).balance > 0) revert EthResidue(address(this).balance);

        emit Relayed(msg.sender, origin, calls.length, outputs.length);
    }

    /// @dev Zeroes every allowance an `approve(spender, amount)` call in `calls` granted, so no
    /// approval outlives the relay that needed it.
    function _resetApprovals(Call[] calldata calls) internal {
        for (uint256 i = 0; i < calls.length; i++) {
            bytes calldata data = calls[i].data;
            if (data.length < 68 || bytes4(data[:4]) != IERC20.approve.selector) continue;
            (address spender,) = abi.decode(data[4:], (address, uint256));
            IERC20(calls[i].to).forceApprove(spender, 0);
        }
    }
}
