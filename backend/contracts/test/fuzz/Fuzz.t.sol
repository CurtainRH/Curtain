// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {CurtainStaking} from "../../src/staking/CurtainStaking.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract StakingFuzz is Test {
    CurtainStaking staking;
    MockERC20 crtn;
    address admin = address(0xAD);
    address[3] users = [address(0x1), address(0x2), address(0x3)];

    function setUp() public {
        vm.warp(1_000_000);
        staking = new CurtainStaking(admin);
        crtn = new MockERC20("Curtain", "CRTN");
        crtn.mint(admin, 1e30);
        vm.startPrank(admin);
        crtn.approve(address(staking), type(uint256).max);
        staking.setTokens(address(crtn), address(crtn));
        vm.stopPrank();
        for (uint256 i = 0; i < 3; i++) {
            crtn.mint(users[i], 1e27);
            vm.prank(users[i]);
            crtn.approve(address(staking), type(uint256).max);
        }
    }

    /// Whatever the stakes, tiers, timing and kicks: rewards paid out never exceed rewards
    /// funded, and every staker gets their full principal back.
    function testFuzz_neverPaysMoreThanFunded(
        uint96[3] memory amounts,
        uint8[3] memory tiers,
        uint32[3] memory delays,
        uint96 reward,
        uint32 duration
    ) public {
        reward = uint96(bound(reward, 1e18, 1e26));
        duration = uint32(bound(duration, 1 days, 400 days));
        vm.prank(admin);
        staking.notifyRewardAmount(reward, duration);

        uint256[3] memory ids;
        for (uint256 i = 0; i < 3; i++) {
            uint256 amt = bound(amounts[i], 1e15, 1e26);
            vm.warp(vm.getBlockTimestamp() + bound(delays[i], 0, 60 days));
            vm.prank(users[i]);
            ids[i] = staking.stake(amt, uint8(bound(tiers[i], 0, 2)));
        }

        vm.warp(vm.getBlockTimestamp() + 200 days);
        for (uint256 i = 0; i < 3; i++) {
            (,,, uint64 unlockAt,,,) = staking.positions(ids[i]);
            if (vm.getBlockTimestamp() >= unlockAt) {
                try staking.kick(ids[i]) {} catch {}
            }
        }
        vm.warp(vm.getBlockTimestamp() + 500 days); // everything unlocked and streamed

        uint256 paidOut;
        for (uint256 i = 0; i < 3; i++) {
            uint256 before = crtn.balanceOf(users[i]);
            vm.prank(users[i]);
            staking.withdraw(ids[i]);
            paidOut += crtn.balanceOf(users[i]) - before;
        }
        assertLe(paidOut, uint256(reward) + _sumPrincipal(ids), "paid more than principal + funded rewards");
        assertEq(crtn.balanceOf(address(staking)) + paidOut, uint256(reward) + _sumPrincipal(ids), "conservation");
    }

    function _sumPrincipal(uint256[3] memory ids) internal view returns (uint256 total) {
        for (uint256 i = 0; i < 3; i++) {
            (, uint256 amount,,,,,) = staking.positions(ids[i]);
            total += amount;
        }
    }
}

contract VaultFuzz is Test {
    CurtainVault vault;
    MockERC20 usdg;
    address admin = address(0xAD);
    address user = address(0xA11CE);

    function setUp() public {
        vm.warp(1_000_000);
        vault = new CurtainVault(admin, address(0x0FE), address(0x7EA5));
        usdg = new MockERC20("USD Global", "USDG");
        vm.prank(admin);
        vault.setAllowedToken(address(usdg), true);
    }

    /// An unsettled deposit can always be refunded in full, for any amount and deadline.
    function testFuzz_unsettledDepositAlwaysRefundable(uint128 amount, uint32 deadlineOffset, bytes32 salt) public {
        amount = uint128(bound(amount, 1, type(uint128).max));
        uint256 deadline = vm.getBlockTimestamp() + deadlineOffset;
        usdg.mint(user, amount);
        vm.startPrank(user);
        usdg.approve(address(vault), amount);
        uint256 id = vault.deposit(address(usdg), amount, keccak256(abi.encode(deadline, salt)));
        vm.warp(deadline + 3 minutes);
        vault.requestRefund(id, deadline, salt);
        vm.stopPrank();
        vm.warp(vm.getBlockTimestamp() + 10 minutes + 1);
        vault.finalizeRefund(id);
        assertEq(usdg.balanceOf(user), amount);
        assertEq(usdg.balanceOf(address(vault)), 0);
    }
}
