// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CRTN} from "../../src/token/CRTN.sol";
import {CrtnStaking} from "../../src/staking/CrtnStaking.sol";
import {ScreeningGate} from "../../src/gate/ScreeningGate.sol";
import {RelayAdapt} from "../../src/adapt/RelayAdapt.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {PoseidonT2Deployer} from "../../src/lib/PoseidonT2.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";

contract CrtnStakingTest is Test {
    CRTN internal crtn;
    CrtnStaking internal staking;
    MockERC20 internal feeToken;
    ScreeningGate internal gate;
    RelayAdapt internal adapt;

    address internal community = address(0xC001);
    address internal team = address(0x7EA7);
    address internal backers = address(0xBAC0);
    address internal subsidies = address(0x5080);
    address internal treasury = address(0x7EA5);

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        crtn = new CRTN(community, team, backers, subsidies);
        staking = new CrtnStaking(address(crtn), treasury);

        feeToken = new MockERC20("USD Global", "USDG");

        address poseidonT2 = address(new PoseidonT2Deployer());
        address poseidonT3 = address(new PoseidonT3Deployer());

        gate = new ScreeningGate(
            PoseidonT2Deployer(poseidonT2).hasher(),
            PoseidonT3Deployer(poseidonT3).hasher(),
            address(0), // ppoiVerifier
            address(this) // initialOwner
        );

        // Deploy RelayAdapt (CurtainPool set to address(this) for mock target tests)
        adapt = new RelayAdapt(address(this), address(this));

        // Transfer gate & adapt ownership to staking contract for governance execution
        gate.transferOwnership(address(staking));
        adapt.transferOwnership(address(staking));

        // Distribute CRTN to Alice & Bob for staking
        vm.startPrank(community);
        crtn.transfer(alice, 500_000 ether);
        crtn.transfer(bob, 500_000 ether);
        vm.stopPrank();

        // Mint USDG feeToken to Alice for fee sending
        feeToken.mint(alice, 10_000 ether);
    }

    // --- STAKING & UNSTAKING TESTS ---

    function test_StakeAndUnstake() public {
        vm.startPrank(alice);
        crtn.approve(address(staking), 200_000 ether);
        staking.stake(200_000 ether);
        vm.stopPrank();

        assertEq(staking.stakedBalance(alice), 200_000 ether);
        assertEq(staking.totalStaked(), 200_000 ether);

        vm.startPrank(alice);
        staking.unstake(50_000 ether);
        vm.stopPrank();

        assertEq(staking.stakedBalance(alice), 150_000 ether);
        assertEq(staking.totalStaked(), 150_000 ether);
        assertEq(crtn.balanceOf(alice), 350_000 ether);
    }

    function test_StakeZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(CrtnStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    function test_UnstakeExcessReverts() public {
        vm.startPrank(alice);
        crtn.approve(address(staking), 100_000 ether);
        staking.stake(100_000 ether);

        vm.expectRevert(CrtnStaking.InsufficientStake.selector);
        staking.unstake(100_001 ether);
        vm.stopPrank();
    }

    // --- FEE ROUTER & 60/40 SPLIT TESTS ---

    function test_FeeDistribution60_40() public {
        // Alice stakes 300k, Bob stakes 100k (3:1 ratio)
        vm.startPrank(alice);
        crtn.approve(address(staking), 300_000 ether);
        staking.stake(300_000 ether);
        vm.stopPrank();

        vm.startPrank(bob);
        crtn.approve(address(staking), 100_000 ether);
        staking.stake(100_000 ether);
        vm.stopPrank();

        // Alice sends 1,000 USDG in pool fees
        vm.startPrank(alice);
        feeToken.approve(address(staking), 1_000 ether);
        staking.receiveFees(address(feeToken), 1_000 ether);
        vm.stopPrank();

        // Treasury receives 40% = 400 USDG
        assertEq(feeToken.balanceOf(treasury), 400 ether);

        // Remaining 60% = 600 USDG allocated to stakers:
        // Alice (75% of stake) -> 450 USDG
        // Bob (25% of stake) -> 150 USDG
        assertEq(staking.pendingFees(alice, address(feeToken)), 450 ether);
        assertEq(staking.pendingFees(bob, address(feeToken)), 150 ether);

        // Alice claims fees
        vm.prank(alice);
        staking.claimFees(address(feeToken));
        assertEq(feeToken.balanceOf(alice), 9_000 ether + 450 ether);

        // Bob claims fees via claimAllFees
        vm.prank(bob);
        staking.claimAllFees();
        assertEq(feeToken.balanceOf(bob), 150 ether);
    }

    // --- GOVERNANCE PROPOSALS & VOTING TESTS ---

    function test_Governance_SetFeeBps() public {
        // Alice stakes 200k CRTN (> 100k required to propose)
        vm.startPrank(alice);
        crtn.approve(address(staking), 200_000 ether);
        staking.stake(200_000 ether);

        uint256 pid = staking.proposeSetFeeBps(25); // Set fee to 0.25% (25 BPS)
        vm.stopPrank();

        assertEq(staking.currentFeeBps(), 20);

        // Alice votes FOR
        vm.prank(alice);
        staking.castVote(pid, true);

        // Advance time past voting period (3 days)
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);

        // Execute proposal
        staking.executeProposal(pid);

        assertEq(staking.currentFeeBps(), 25);
    }

    function test_Governance_FeeBpsOutOfBoundsReverts() public {
        vm.startPrank(alice);
        crtn.approve(address(staking), 200_000 ether);
        staking.stake(200_000 ether);

        vm.expectRevert(CrtnStaking.FeeBpsOutOfBounds.selector);
        staking.proposeSetFeeBps(5); // < 10 BPS

        vm.expectRevert(CrtnStaking.FeeBpsOutOfBounds.selector);
        staking.proposeSetFeeBps(35); // > 30 BPS
        vm.stopPrank();
    }

    function test_Governance_AddAndRemoveProvider() public {
        vm.startPrank(alice);
        crtn.approve(address(staking), 200_000 ether);
        staking.stake(200_000 ether);

        uint8 providerId = 1;
        address publisher = address(0x999);
        bytes32 listRoot = bytes32(uint256(0x111));
        bytes32 flagRoot = bytes32(uint256(0x222));

        uint256 pid = staking.proposeAddProvider(address(gate), providerId, publisher, listRoot, flagRoot);
        staking.castVote(pid, true);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        staking.executeProposal(pid);

        // Verify provider added on ScreeningGate contract
        (bytes32 currentListRoot, bytes32 currentFlagRoot, uint64 updatedAt, address currentPublisher, bool active,,,) = gate.providers(providerId);
        assertTrue(active);
        assertEq(currentPublisher, publisher);
        assertEq(currentListRoot, listRoot);
        assertEq(currentFlagRoot, flagRoot);
        assertGt(updatedAt, 0);

        // Remove provider via governance
        vm.startPrank(alice);
        uint256 pid2 = staking.proposeRemoveProvider(address(gate), providerId);
        staking.castVote(pid2, true);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        staking.executeProposal(pid2);

        (,,,, active,,,) = gate.providers(providerId);
        assertFalse(active);
    }

    function test_Governance_AddRelayTarget() public {
        vm.startPrank(alice);
        crtn.approve(address(staking), 200_000 ether);
        staking.stake(200_000 ether);

        address target = address(0x7426);
        uint256 pid = staking.proposeRelayTarget(address(adapt), target, true);
        staking.castVote(pid, true);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        staking.executeProposal(pid);

        assertTrue(adapt.allowedTarget(target));
    }
}
