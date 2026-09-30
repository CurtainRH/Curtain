// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {RelayAdapt} from "../../src/adapt/RelayAdapt.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {Guardian} from "../../src/guardian/Guardian.sol";
import {ScreeningGate} from "../../src/gate/ScreeningGate.sol";
import {CrtnStaking} from "../../src/staking/CrtnStaking.sol";
import {CRTN} from "../../src/token/CRTN.sol";
import {PoseidonT2Deployer} from "../../src/lib/PoseidonT2.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract StubFeeSource {
    uint16 public bps;
    bool public broken;

    function set(uint16 b, bool br) external {
        bps = b;
        broken = br;
    }

    function currentFeeBps() external view returns (uint16) {
        require(!broken, "broken");
        return bps;
    }
}

/// Fixes #3 (unshield fee enforced), #4 (broadcaster paid), #5 (guardian pause), #6 (governed fee).
contract PoolFixesTest is Test {
    CurtainPool pool;
    RelayAdapt adapt;
    Guardian guardian;
    StubFeeSource feeSource;
    MockERC20 usdg;
    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address pauser = address(0x9A05E);

    function setUp() public {
        address t3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address t5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();
        AssetGate ag = new AssetGate(address(this));
        MockJoinSplitVerifier v = new MockJoinSplitVerifier();
        feeSource = new StubFeeSource();
        feeSource.set(20, false);
        guardian = new Guardian(address(this), pauser);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pool = new CurtainPool(t3, t5, address(ag), address(new MockScreeningGate()), address(v), address(v),
            address(new MockUnshieldVerifier()), predicted, treasury, address(feeSource), 20, address(0), address(guardian));
        adapt = new RelayAdapt(address(pool), address(this));

        usdg = new MockERC20("USDG", "USDG");
        ag.register(address(usdg), false, address(0));
        usdg.mint(alice, 1_000 ether);
        vm.prank(alice);
        usdg.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        pool.shield(address(usdg), 500 ether, 1, 1, "", "");
    }

    function _args(uint256 unshield, uint256 fee, address recipient) internal view returns (CurtainPool.TransactArgs memory a) {
        a.token = address(usdg);
        a.root = pool.currentRoot();
        a.clearedRoot = pool.currentClearedRoot();
        a.nullifiers = new bytes32[](2);
        a.nullifiers[0] = keccak256(abi.encode(unshield, fee, 1));
        a.nullifiers[1] = keccak256(abi.encode(unshield, fee, 2));
        a.newCommits = new bytes32[](2);
        a.ephemeralPks = new bytes[](2);
        a.cts = new bytes[](2);
        a.unshieldTo = alice;
        a.unshieldAmount = unshield;
        a.feeAmount = fee;
        a.feeRecipient = recipient;
    }

    function test_transact_revertsWhenFeeBelowProtocolFee() public {
        CurtainPool.TransactArgs memory a = _args(100 ether, 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(CurtainPool.FeeTooLow.selector, 0, 0.2 ether));
        pool.transact(a);
    }

    function test_transact_splitsProtocolAndBroadcasterFee() public {
        address broadcaster = address(0xB0);
        pool.transact(_args(100 ether, 0.2 ether + 3 ether, broadcaster));
        assertEq(usdg.balanceOf(broadcaster), 3 ether);
        assertEq(usdg.balanceOf(treasury), 1 ether /* shield fee */ + 0.2 ether);
    }

    function test_transact_withoutRecipientSendsWholeFeeToTreasury() public {
        pool.transact(_args(100 ether, 0.5 ether, address(0)));
        assertEq(usdg.balanceOf(treasury), 1 ether + 0.5 ether);
    }

    function test_feeBps_followsGovernanceWithinBounds() public {
        feeSource.set(25, false);
        assertEq(pool.feeBps(), 25);
        feeSource.set(5, false);
        assertEq(pool.feeBps(), 10, "clamped to MIN_FEE_BPS");
        feeSource.set(99, false);
        assertEq(pool.feeBps(), 30, "clamped to MAX_FEE_BPS");
        feeSource.set(25, true);
        assertEq(pool.feeBps(), 20, "broken source falls back to default");
    }

    function test_guardianShieldPause_blocksShieldOnly() public {
        vm.prank(pauser);
        guardian.setShieldPaused(true);

        vm.prank(alice);
        vm.expectRevert(CurtainPool.ShieldPausedByGuardian.selector);
        pool.shield(address(usdg), 1 ether, 1, 2, "", "");

        // transact still works while shield is paused
        pool.transact(_args(10 ether, 0.02 ether, address(0)));
    }

    function test_unshieldToOrigin_worksWhilePausedAndWithBrokenFeeSource() public {
        vm.prank(pauser);
        guardian.setShieldPaused(true);
        vm.prank(pauser);
        guardian.setRelayPaused(true);
        feeSource.set(0, true);

        bytes32 commit = bytes32(pool.commitHasher().poseidon([pool.tokenIdOf(address(usdg)), uint256(499 ether), 1, 1]));
        uint256 before = usdg.balanceOf(alice);
        pool.unshieldToOrigin(commit, address(usdg), 499 ether, 1, 1, 42, "");
        assertEq(usdg.balanceOf(alice) - before, 499 ether - (499 ether * 20) / 10000);
    }

    function test_guardianRelayPause_blocksRelay() public {
        vm.prank(pauser);
        guardian.setRelayPaused(true);
        CurtainPool.TransactArgs memory a = _args(10 ether, 0.02 ether, address(0));
        a.unshieldTo = address(adapt);
        a.extData = adapt.relayDataHash(new RelayAdapt.Call[](0), new RelayAdapt.ReshieldOutput[](0), alice);
        vm.expectRevert(RelayAdapt.RelayPausedByGuardian.selector);
        adapt.relay(a, new RelayAdapt.Call[](0), new RelayAdapt.ReshieldOutput[](0), alice);
    }

    function test_guardian_onlyGuardianOrOwner() public {
        vm.prank(alice);
        vm.expectRevert(Guardian.NotGuardian.selector);
        guardian.setShieldPaused(true);
        guardian.setShieldPaused(true); // owner (timelock) may also flip it
        assertTrue(guardian.shieldPaused());
    }
}

/// ScreeningGate medium fixes: stale exclusion, previous-root window, no overwrite.
contract GateFixesTest is Test {
    ScreeningGate gate;

    function setUp() public {
        address t2 = PoseidonT2Deployer(address(new PoseidonT2Deployer())).hasher();
        address t3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        gate = new ScreeningGate(t2, t3, address(0), address(this));
        vm.warp(1_000_000);
        gate.addProvider(0, address(this), bytes32(uint256(10)), bytes32(0));
        gate.addProvider(1, address(this), bytes32(uint256(11)), bytes32(0));
        gate.addProvider(2, address(this), bytes32(uint256(12)), bytes32(0));
    }

    function test_addProvider_cannotOverwriteActiveProvider() public {
        vm.expectRevert(ScreeningGate.ProviderAlreadyActive.selector);
        gate.addProvider(0, address(0xBAD), bytes32(0), bytes32(0));
        vm.expectRevert(ScreeningGate.ProviderIdOutOfRange.selector);
        gate.addProvider(3, address(this), bytes32(0), bytes32(0));
    }

    function test_removedAndStaleProvidersAreExcludedFromRootSet() public {
        gate.removeProvider(1);
        bytes32[3] memory roots = gate.ppoiRoots(0);
        assertEq(roots[0], bytes32(uint256(10)));
        assertEq(roots[1], bytes32(0), "removed provider must be the empty root");
        assertEq(roots[2], bytes32(uint256(12)));

        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        roots = gate.ppoiRoots(0);
        assertEq(roots[0], bytes32(0), "stale provider must be the empty root");
        assertEq(gate.standby(), 60 minutes);
    }

    function test_ppoiVerify_requiresAFreshProvider() public {
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        vm.expectRevert(ScreeningGate.NoFreshProvider.selector);
        gate.ppoiVerify(bytes32(uint256(1)), "");
    }

    function test_previousRootAcceptedOnlyShortlyAfterUpdate() public {
        vm.expectRevert(abi.encodeWithSelector(ScreeningGate.PreviousRootUnavailable.selector, uint8(0)));
        gate.ppoiRoots(1); // no previous root yet

        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        gate.updateRoot(0, bytes32(uint256(20)), bytes32(0));
        bytes32[3] memory roots = gate.ppoiRoots(1);
        assertEq(roots[0], bytes32(uint256(10)), "previous root usable right after an update");
        assertEq(gate.ppoiRoots(0)[0], bytes32(uint256(20)));

        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(ScreeningGate.PreviousRootUnavailable.selector, uint8(0)));
        gate.ppoiRoots(1);
    }
}

/// Fix #2: governance can't be captured by recycled stake; passed proposals go via the timelock.
contract GovernanceFixesTest is Test {
    CRTN crtn;
    CrtnStaking staking;
    TimelockController timelock;
    ScreeningGate gate;
    address multisig = address(0x5AFE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address mallory = address(0xBAD);
    address mallory2 = address(0xBAD2);

    function setUp() public {
        crtn = new CRTN(address(this), address(0x2), address(0x3), address(0x4));
        staking = new CrtnStaking(address(crtn), address(0x7EA5));

        address[] memory proposers = new address[](2);
        proposers[0] = multisig;
        proposers[1] = address(staking);
        address[] memory executors = new address[](1); // address(0): anyone may execute after the delay
        timelock = new TimelockController(24 hours, proposers, executors, address(0));
        staking.setTimelock(address(timelock));

        address t2 = PoseidonT2Deployer(address(new PoseidonT2Deployer())).hasher();
        address t3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        gate = new ScreeningGate(t2, t3, address(0), address(timelock));

        crtn.transfer(alice, 1_000_000 ether);
        crtn.transfer(bob, 1_000_000 ether);
        crtn.transfer(mallory, 150_000 ether);
        vm.prank(alice);
        crtn.approve(address(staking), type(uint256).max);
        vm.prank(alice);
        staking.stake(1_000_000 ether);
        vm.prank(bob);
        crtn.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        staking.stake(1_000_000 ether);
    }

    function test_votingLocksStake_soTokensCantVoteTwice() public {
        vm.startPrank(mallory);
        crtn.approve(address(staking), type(uint256).max);
        staking.stake(150_000 ether);
        uint256 pid = staking.proposeRelayTarget(address(0xADA), address(0xEE), true);
        staking.castVote(pid, true);
        vm.expectPartialRevert(CrtnStaking.StakeLocked.selector);
        staking.unstake(150_000 ether); // can't recycle the same tokens into another wallet
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        vm.prank(mallory);
        staking.unstake(150_000 ether); // unlocked once voting is over
    }

    function test_proposalNeedsQuorum() public {
        // A tiny staker (1k of ~2M staked, well under the 4% quorum) is the only voter.
        crtn.transfer(mallory2, 1_000 ether);
        vm.startPrank(mallory2);
        crtn.approve(address(staking), type(uint256).max);
        staking.stake(1_000 ether);
        vm.stopPrank();
        vm.prank(alice);
        uint256 pid = staking.proposeRelayTarget(address(0xADA), address(0xFF), true);
        vm.prank(mallory2);
        staking.castVote(pid, true);

        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        vm.expectPartialRevert(CrtnStaking.QuorumNotReached.selector);
        staking.executeProposal(pid);
    }

    function test_passedProposalIsQueuedOnTimelock_thenExecutedAfterDelay() public {
        vm.prank(alice);
        uint256 pid = staking.proposeAddProvider(address(gate), 0, address(0x9), bytes32(uint256(7)), bytes32(0));
        vm.prank(alice);
        staking.castVote(pid, true);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        staking.executeProposal(pid);

        (,,,, bool active,,,) = gate.providers(0);
        assertFalse(active, "must not apply before the timelock delay");

        bytes memory data = abi.encodeCall(ScreeningGate.addProvider, (0, address(0x9), bytes32(uint256(7)), bytes32(0)));
        vm.expectRevert();
        timelock.execute(address(gate), 0, data, bytes32(0), bytes32(pid));

        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        timelock.execute(address(gate), 0, data, bytes32(0), bytes32(pid));
        (,,,, active,,,) = gate.providers(0);
        assertTrue(active);
    }

    function test_multisigCanVetoQueuedProposal() public {
        vm.prank(alice);
        uint256 pid = staking.proposeSetFeeBps(30);
        vm.prank(alice);
        staking.castVote(pid, true);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        staking.executeProposal(pid);

        bytes memory data = abi.encodeCall(CrtnStaking.setFeeBps, (uint16(30)));
        bytes32 id = timelock.hashOperation(address(staking), 0, data, bytes32(0), bytes32(pid));
        vm.prank(multisig);
        timelock.cancel(id);

        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        vm.expectRevert();
        timelock.execute(address(staking), 0, data, bytes32(0), bytes32(pid));
        assertEq(staking.currentFeeBps(), 20);
    }

    function test_feeChange_appliesOnlyThroughTimelock() public {
        vm.expectRevert(CrtnStaking.NotTimelock.selector);
        staking.setFeeBps(25);

        vm.prank(alice);
        uint256 pid = staking.proposeSetFeeBps(25);
        vm.prank(alice);
        staking.castVote(pid, true);
        vm.warp(vm.getBlockTimestamp() + 3 days + 1);
        staking.executeProposal(pid);
        vm.warp(vm.getBlockTimestamp() + 24 hours + 1);
        timelock.execute(address(staking), 0, abi.encodeCall(CrtnStaking.setFeeBps, (uint16(25))), bytes32(0), bytes32(pid));
        assertEq(staking.currentFeeBps(), 25);
    }

    function test_setTimelock_onlyOnceByDeployer() public {
        vm.expectRevert(CrtnStaking.TimelockAlreadySet.selector);
        staking.setTimelock(address(0x1234));
        vm.prank(alice);
        vm.expectRevert(CrtnStaking.NotDeployer.selector);
        staking.setTimelock(address(0x1234));
    }
}
