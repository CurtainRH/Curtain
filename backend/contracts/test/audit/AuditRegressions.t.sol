// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {CurtainStaking} from "../../src/staking/CurtainStaking.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {VaultBase} from "../vault/CurtainVault.t.sol";

/// Regression tests for the 2026-10-01 audit findings. Each one reproduced the issue before
/// the fix (see git history for the original proofs of concept).
contract VaultAuditRegressions is VaultBase {
    address attacker = address(0xBAD);

    /// H-01: a deposit is never left swapped-but-unpaid. If a settlement doesn't land before
    /// its deadline, the input tokens are still in the vault and the refund pays out.
    function test_H01_unsettledDepositIsAlwaysRefundable() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);

        // Operator signs a settlement, but no keeper submits it before the deadline.
        CurtainVault.Swap memory s = _swap(1_000 ether, 5 ether);
        CurtainVault.Payout[] memory ps = _payouts(id, 5 ether);
        bytes memory sig = _sign(s, ps, deadline, 1, operatorKey);

        vm.warp(deadline + 3 minutes);
        vm.expectRevert(CurtainVault.SettlementExpired.selector);
        vault.settle(s, ps, deadline, 1, sig);

        vm.prank(alice);
        vault.requestRefund(id, deadline, SALT);
        vm.warp(vm.getBlockTimestamp() + 10 minutes + 1);
        vault.finalizeRefund(id);
        assertEq(usdg.balanceOf(alice), 10_000 ether, "full deposit back");
    }

    /// M-01: reusing someone else's deadline hash no longer blocks their deposit.
    function test_M01_frontRunningAHashDoesNotBlockTheDepositor() public {
        uint256 deadline = _deadline();
        bytes32 h = keccak256(abi.encode(deadline, SALT));
        usdg.mint(attacker, 1);
        vm.startPrank(attacker);
        usdg.approve(address(vault), 1);
        vault.deposit(address(usdg), 1, h);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = vault.deposit(address(usdg), 1_000 ether, h);
        (address depositor,, uint256 amount,,,) = vault.deposits(id);
        assertEq(depositor, alice);
        assertEq(amount, 1_000 ether);
    }

    /// L-01: fees above the caps are rejected.
    function test_L01_feesAboveCapsRejected() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        CurtainVault.Swap memory s = _swap(1_000 ether, 5 ether);
        uint256 deadline = _deadline();

        CurtainVault.Payout[] memory greedy = _payouts(id, 5 ether);
        greedy[0].protocolFee = 1 ether; // 20% protocol fee vs a 0.20% setting
        greedy[0].amount = 5 ether - 1 ether - greedy[0].keeperFee;
        bytes memory sig = _sign(s, greedy, deadline, 1, operatorKey);
        vm.expectRevert(CurtainVault.FeeAboveCap.selector);
        vault.settle(s, greedy, deadline, 1, sig);

        CurtainVault.Payout[] memory greedyKeeper = _payouts(id, 5 ether);
        greedyKeeper[0].keeperFee = 1 ether; // 20% keeper fee vs a 1% cap
        greedyKeeper[0].amount = 5 ether - greedyKeeper[0].protocolFee - 1 ether;
        sig = _sign(s, greedyKeeper, deadline, 2, operatorKey);
        vm.expectRevert(CurtainVault.FeeAboveCap.selector);
        vault.settle(s, greedyKeeper, deadline, 2, sig);
    }

    /// L-02: payouts to the zero address or to the vault itself are rejected.
    function test_L02_badRecipientsRejected() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        CurtainVault.Swap memory s = _swap(1_000 ether, 5 ether);
        uint256 deadline = _deadline();
        address[2] memory bad = [address(0), address(vault)];
        for (uint256 i = 0; i < 2; i++) {
            CurtainVault.Payout[] memory ps = _payouts(id, 5 ether);
            ps[0].recipient = bad[i];
            bytes memory sig = _sign(s, ps, deadline, 10 + i, operatorKey);
            vm.expectRevert(abi.encodeWithSelector(CurtainVault.BadRecipient.selector, bad[i]));
            vault.settle(s, ps, deadline, 10 + i, sig);
        }
    }
}

contract StakingAuditRegressions is Test {
    CurtainStaking staking;
    MockERC20 crtn;
    address admin = address(0xAD);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_000_000);
        staking = new CurtainStaking(admin);
        crtn = new MockERC20("Curtain", "CRTN");
        crtn.mint(admin, 1_000_000 ether);
        for (uint256 i = 0; i < 2; i++) {
            address u = i == 0 ? alice : bob;
            crtn.mint(u, 1_000 ether);
            vm.prank(u);
            crtn.approve(address(staking), type(uint256).max);
        }
        vm.startPrank(admin);
        crtn.approve(address(staking), type(uint256).max);
        staking.setTokens(address(crtn), address(crtn));
        vm.stopPrank();
    }

    /// M-03: an unlocked 180-day position can be kicked back to 1x by anyone.
    function test_M03_unlockedPositionKickedTo1x() public {
        vm.prank(alice);
        uint256 a = staking.stake(100 ether, 2);
        vm.expectRevert(CurtainStaking.NotKickable.selector);
        staking.kick(a); // still locked

        vm.warp(vm.getBlockTimestamp() + 181 days);
        staking.kick(a); // anyone
        vm.expectRevert(CurtainStaking.NotKickable.selector);
        staking.kick(a); // already 1x

        vm.prank(bob);
        uint256 b = staking.stake(100 ether, 0);
        vm.prank(admin);
        staking.notifyRewardAmount(3_000 ether, 30 days);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertApproxEqRel(staking.earned(a), 1_500 ether, 1e12, "kicked alice now earns 1x");
        assertApproxEqRel(staking.earned(b), 1_500 ether, 1e12);
    }

    /// M-03: rewards earned at 2x before the kick are kept.
    function test_M03_kickKeepsRewardsEarnedBeforeIt() public {
        vm.prank(alice);
        uint256 a = staking.stake(100 ether, 2);
        vm.prank(admin);
        staking.notifyRewardAmount(1_800 ether, 180 days);
        vm.warp(vm.getBlockTimestamp() + 180 days);
        uint256 before = staking.earned(a);
        staking.kick(a);
        assertEq(staking.earned(a), before);
        assertApproxEqRel(before, 1_800 ether, 1e12);
    }

    /// L-04: rewards are paused, not lost, while nobody is staked.
    function test_L04_rewardsPauseWhileNobodyStaked() public {
        vm.prank(admin);
        staking.notifyRewardAmount(1_000 ether, 10 days);
        vm.warp(vm.getBlockTimestamp() + 5 days); // nobody staked yet

        vm.prank(alice);
        uint256 a = staking.stake(100 ether, 0);
        vm.warp(vm.getBlockTimestamp() + 40 days);
        assertApproxEqRel(staking.earned(a), 1_000 ether, 1e12, "all 1,000 reach the staker");

        vm.prank(alice);
        staking.withdraw(a);
        assertLe(crtn.balanceOf(address(staking)), 1e6, "nothing stranded");
    }

    /// L-04: rewards are paused again if everyone leaves mid-period, and resume for the next staker.
    function test_L04_pauseWhenEveryoneLeavesMidPeriod() public {
        vm.prank(alice);
        uint256 a = staking.stake(100 ether, 0);
        vm.prank(admin);
        staking.notifyRewardAmount(600 ether, 60 days);
        vm.warp(vm.getBlockTimestamp() + 30 days); // 300 streamed to alice
        vm.prank(alice);
        staking.withdraw(a);

        vm.warp(vm.getBlockTimestamp() + 100 days); // nobody staked: paused
        vm.prank(bob);
        uint256 b = staking.stake(100 ether, 0);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertApproxEqRel(staking.earned(b), 300 ether, 1e12, "bob gets the remaining 300, not more");
    }

    /// L-03: two-step ownership.
    function test_L03_twoStepOwnership() public {
        vm.prank(admin);
        staking.transferOwnership(bob);
        assertEq(staking.owner(), admin);
        vm.prank(bob);
        staking.acceptOwnership();
        assertEq(staking.owner(), bob);
    }
}
