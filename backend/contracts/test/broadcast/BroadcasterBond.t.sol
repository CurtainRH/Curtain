// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BroadcasterBond} from "../../src/broadcast/BroadcasterBond.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice M7 acceptance: bond/unbond/fee mechanics plus the slash path
/// (threshold EIP-712 attestations over censorship evidence — see
/// BroadcasterBond.sol's header for why attestors work this way).
contract BroadcasterBondTest is Test {
    BroadcasterBond internal bond_;
    MockERC20 internal token; // stand-in for CRTN — see BroadcasterBond.sol's header

    address internal treasury = address(0x7EA5);
    address internal owner = address(this);

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA401);

    address internal attestor1;
    uint256 internal attestor1Key;
    address internal attestor2;
    uint256 internal attestor2Key;
    address internal attestor3;
    uint256 internal attestor3Key;

    uint256 internal constant MIN_BOND = 25_000 ether;

    function setUp() public {
        token = new MockERC20("Curtain (test stand-in)", "CRTN");
        bond_ = new BroadcasterBond(address(token), treasury, owner);

        (attestor1, attestor1Key) = makeAddrAndKey("attestor1");
        (attestor2, attestor2Key) = makeAddrAndKey("attestor2");
        (attestor3, attestor3Key) = makeAddrAndKey("attestor3");
        bond_.setAttestor(attestor1, true);
        bond_.setAttestor(attestor2, true);
        bond_.setAttestor(attestor3, true);
        bond_.setAttestorThreshold(2);

        for (uint256 i = 0; i < 3; i++) {
            address who = [alice, bob, carol][i];
            token.mint(who, 100_000 ether);
            vm.prank(who);
            token.approve(address(bond_), type(uint256).max);
        }
    }

    function _slashDigest(address broadcaster, uint256 amount, bytes32 evidenceRoot) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(bond_.SLASH_TYPE_HASH(), broadcaster, amount, evidenceRoot));
        return keccak256(abi.encodePacked("\x19\x01", bond_.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ---- bonding ----

    function test_bond_belowMinBond_doesNotJoinBondedSet() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND - 1);

        address[] memory active = bond_.bondedBroadcasters();
        assertEq(active.length, 0);
    }

    function test_bond_atMinBond_joinsBondedSet() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        address[] memory active = bond_.bondedBroadcasters();
        assertEq(active.length, 1);
        assertEq(active[0], alice);
    }

    function test_bond_threeBroadcasters_allAppearInBondedSet() public {
        vm.prank(alice); bond_.bond(MIN_BOND);
        vm.prank(bob); bond_.bond(MIN_BOND);
        vm.prank(carol); bond_.bond(MIN_BOND);

        address[] memory active = bond_.bondedBroadcasters();
        assertEq(active.length, 3);
    }

    function test_setFees_revertsAboveMaxFeeBps() public {
        vm.startPrank(alice);
        bond_.bond(MIN_BOND);
        vm.expectRevert(BroadcasterBond.FeeTooHigh.selector);
        bond_.setFees(31, 0);
        vm.stopPrank();
    }

    function test_setFees_revertsIfNeverBonded() public {
        vm.prank(alice);
        vm.expectRevert(BroadcasterBond.NotActive.selector);
        bond_.setFees(10, 0);
    }

    // ---- unbonding ----

    function test_requestUnbond_removesFromBondedSetImmediately() public {
        vm.startPrank(alice);
        bond_.bond(MIN_BOND);
        bond_.requestUnbond();
        vm.stopPrank();

        assertEq(bond_.bondedBroadcasters().length, 0);
    }

    function test_unbond_revertsBeforeDelayElapses() public {
        vm.startPrank(alice);
        bond_.bond(MIN_BOND);
        bond_.requestUnbond();
        vm.expectRevert(BroadcasterBond.UnbondStillLocked.selector);
        bond_.unbond();
        vm.stopPrank();
    }

    function test_unbond_returnsFundsAfterDelay() public {
        vm.startPrank(alice);
        bond_.bond(MIN_BOND);
        bond_.requestUnbond();
        vm.warp(block.timestamp + 14 days);
        uint256 balBefore = token.balanceOf(alice);
        bond_.unbond();
        vm.stopPrank();

        assertEq(token.balanceOf(alice), balBefore + MIN_BOND);
    }

    function test_unbond_revertsWithoutRequest() public {
        vm.startPrank(alice);
        bond_.bond(MIN_BOND);
        vm.expectRevert(BroadcasterBond.UnbondNotRequested.selector);
        bond_.unbond();
        vm.stopPrank();
    }

    // ---- slashing (censorship path) ----

    function test_slash_withThresholdAttestations_reducesBondAndPaysTreasury() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("alice missed her assignment window");
        uint256 slashAmount = 5_000 ether;
        bytes32 digest = _slashDigest(alice, slashAmount, evidenceRoot);

        address[] memory attestors = new address[](2);
        attestors[0] = attestor1;
        attestors[1] = attestor2;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestor1Key, digest);
        sigs[1] = _sign(attestor2Key, digest);

        uint256 treasuryBefore = token.balanceOf(treasury);
        bond_.slash(alice, slashAmount, evidenceRoot, attestors, sigs);

        (uint256 bonded,,,,) = bond_.broadcasters(alice);
        assertEq(bonded, MIN_BOND - slashAmount);
        assertEq(token.balanceOf(treasury), treasuryBefore + slashAmount);
    }

    function test_slash_dropsBroadcasterFromBondedSetIfBelowMinAfterSlash() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("evidence");
        uint256 slashAmount = 10_000 ether; // leaves 15,000 < MIN_BOND
        bytes32 digest = _slashDigest(alice, slashAmount, evidenceRoot);
        address[] memory attestors = new address[](2);
        attestors[0] = attestor1; attestors[1] = attestor2;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestor1Key, digest); sigs[1] = _sign(attestor2Key, digest);

        bond_.slash(alice, slashAmount, evidenceRoot, attestors, sigs);

        assertEq(bond_.bondedBroadcasters().length, 0);
    }

    function test_slash_revertsWithFewerThanThresholdAttestations() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("evidence");
        bytes32 digest = _slashDigest(alice, 1 ether, evidenceRoot);
        address[] memory attestors = new address[](1);
        attestors[0] = attestor1;
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(attestor1Key, digest);

        vm.expectRevert(BroadcasterBond.InsufficientAttestations.selector);
        bond_.slash(alice, 1 ether, evidenceRoot, attestors, sigs);
    }

    function test_slash_revertsOnDuplicateAttestorSignature() public {
        // Same attestor signing "twice" must not count as two distinct attestations.
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("evidence");
        bytes32 digest = _slashDigest(alice, 1 ether, evidenceRoot);
        address[] memory attestors = new address[](2);
        attestors[0] = attestor1; attestors[1] = attestor1;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestor1Key, digest); sigs[1] = _sign(attestor1Key, digest);

        vm.expectRevert(BroadcasterBond.InsufficientAttestations.selector);
        bond_.slash(alice, 1 ether, evidenceRoot, attestors, sigs);
    }

    function test_slash_revertsWithNonAttestorSignature() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("evidence");
        (, uint256 randoKey) = makeAddrAndKey("rando");
        bytes32 digest = _slashDigest(alice, 1 ether, evidenceRoot);
        address[] memory attestors = new address[](2);
        attestors[0] = attestor1; attestors[1] = vm.addr(randoKey);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestor1Key, digest); sigs[1] = _sign(randoKey, digest);

        vm.expectRevert(BroadcasterBond.InsufficientAttestations.selector);
        bond_.slash(alice, 1 ether, evidenceRoot, attestors, sigs);
    }

    function test_slash_revertsIfEvidenceRootAlreadyUsed() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("evidence");
        bytes32 digest = _slashDigest(alice, 1 ether, evidenceRoot);
        address[] memory attestors = new address[](2);
        attestors[0] = attestor1; attestors[1] = attestor2;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestor1Key, digest); sigs[1] = _sign(attestor2Key, digest);

        bond_.slash(alice, 1 ether, evidenceRoot, attestors, sigs);

        vm.expectRevert(BroadcasterBond.EvidenceAlreadyUsed.selector);
        bond_.slash(alice, 1 ether, evidenceRoot, attestors, sigs);
    }

    function test_slash_isPermissionless() public {
        vm.prank(alice);
        bond_.bond(MIN_BOND);

        bytes32 evidenceRoot = keccak256("evidence");
        bytes32 digest = _slashDigest(alice, 1 ether, evidenceRoot);
        address[] memory attestors = new address[](2);
        attestors[0] = attestor1; attestors[1] = attestor2;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(attestor1Key, digest); sigs[1] = _sign(attestor2Key, digest);

        vm.prank(bob); // not the owner, not an attestor
        bond_.slash(alice, 1 ether, evidenceRoot, attestors, sigs);
    }

    function test_setAttestorThreshold_revertsAboveAttestorCount() public {
        vm.expectRevert(BroadcasterBond.InvalidThreshold.selector);
        bond_.setAttestorThreshold(10);
    }

    function test_setAttestor_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        bond_.setAttestor(alice, true);
    }
}
