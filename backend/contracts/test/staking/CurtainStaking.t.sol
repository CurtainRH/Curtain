// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainStaking} from "../../src/staking/CurtainStaking.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract CurtainStakingTest is Test {
    CurtainStaking staking;
    MockERC20 crtn;
    address admin = address(0xAD);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        vm.warp(1_000_000);
        staking = new CurtainStaking(admin);
        crtn = new MockERC20("Curtain", "CRTN");
        crtn.mint(admin, 10_000_000 ether);
        crtn.mint(alice, 1_000 ether);
        crtn.mint(bob, 1_000 ether);
        vm.prank(alice);
        crtn.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        crtn.approve(address(staking), type(uint256).max);
        vm.prank(admin);
        crtn.approve(address(staking), type(uint256).max);
    }

    function _setTokens() internal {
        vm.prank(admin);
        staking.setTokens(address(crtn), address(crtn));
    }

    function _fund(uint256 amount, uint256 duration) internal {
        vm.prank(admin);
        staking.notifyRewardAmount(amount, duration);
    }

    function test_disabledUntilTokensPluggedIn() public {
        vm.prank(alice);
        vm.expectRevert(CurtainStaking.TokensNotSet.selector);
        staking.stake(100 ether, 0);

        vm.prank(admin);
        vm.expectRevert(CurtainStaking.TokensNotSet.selector);
        staking.notifyRewardAmount(1 ether, 1 days);

        _setTokens();
        vm.prank(admin);
        vm.expectRevert(CurtainStaking.TokensAlreadySet.selector);
        staking.setTokens(address(crtn), address(crtn));
    }

    function test_tiers() public view {
        (uint64 l0, uint256 m0) = staking.tier(0);
        (uint64 l1, uint256 m1) = staking.tier(1);
        (uint64 l2, uint256 m2) = staking.tier(2);
        assertEq(l0, 30 days);
        assertEq(m0, 10_000);
        assertEq(l1, 90 days);
        assertEq(m1, 15_000);
        assertEq(l2, 180 days);
        assertEq(m2, 20_000);
    }

    function test_rewardsSplitByLockMultiplier() public {
        _setTokens();
        vm.prank(alice);
        uint256 a = staking.stake(100 ether, 0); // 30d, 1x -> weight 100
        vm.prank(bob);
        uint256 b = staking.stake(100 ether, 2); // 180d, 2x -> weight 200
        _fund(3_000 ether, 30 days);

        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertApproxEqRel(staking.earned(a), 1_000 ether, 1e12);
        assertApproxEqRel(staking.earned(b), 2_000 ether, 1e12);

        vm.prank(alice);
        uint256 got = staking.claim(a);
        assertApproxEqRel(got, 1_000 ether, 1e12);
        assertEq(staking.earned(a), 0);
    }

    function test_principalLockedUntilUnlock_rewardsClaimableAnytime() public {
        _setTokens();
        vm.prank(alice);
        uint256 id = staking.stake(100 ether, 1); // 90 days
        _fund(900 ether, 90 days);

        vm.warp(vm.getBlockTimestamp() + 10 days);
        vm.prank(alice);
        assertGt(staking.claim(id), 0);

        vm.prank(alice);
        vm.expectPartialRevert(CurtainStaking.Locked.selector);
        staking.withdraw(id);

        vm.warp(vm.getBlockTimestamp() + 80 days);
        uint256 before = crtn.balanceOf(alice);
        vm.prank(alice);
        staking.withdraw(id);
        assertApproxEqRel(crtn.balanceOf(alice) - before, 100 ether + 800 ether, 1e12);

        vm.prank(alice);
        vm.expectRevert(CurtainStaking.PositionClosed.selector);
        staking.withdraw(id);
    }

    function test_onlyOwnerCanClaimOrWithdraw() public {
        _setTokens();
        vm.prank(alice);
        uint256 id = staking.stake(100 ether, 0);
        vm.prank(bob);
        vm.expectRevert(CurtainStaking.NotOwner.selector);
        staking.claim(id);
    }

    function test_rewardsRollIntoNextPeriod() public {
        _setTokens();
        vm.prank(alice);
        uint256 id = staking.stake(100 ether, 0);
        _fund(1_000 ether, 10 days);
        vm.warp(vm.getBlockTimestamp() + 5 days); // 500 streamed, 500 left
        _fund(1_000 ether, 10 days); // 1,500 over the next 10 days
        vm.warp(vm.getBlockTimestamp() + 10 days);
        assertApproxEqRel(staking.earned(id), 2_000 ether, 1e12);
    }

    function test_sameTokenStakeAndReward_principalStaysWhole() public {
        _setTokens();
        vm.prank(alice);
        uint256 id = staking.stake(100 ether, 0);
        _fund(50 ether, 1 days);
        vm.warp(vm.getBlockTimestamp() + 31 days);
        uint256 before = crtn.balanceOf(alice);
        vm.prank(alice);
        staking.withdraw(id);
        assertApproxEqAbs(crtn.balanceOf(alice) - before, 150 ether, 1e6);
        assertLe(crtn.balanceOf(address(staking)), 1e6, "only rounding dust may remain");
    }

    function test_badTierReverts() public {
        _setTokens();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CurtainStaking.BadTier.selector, uint8(3)));
        staking.stake(1 ether, 3);
    }
}
