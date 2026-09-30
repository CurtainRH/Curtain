// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer, IPoseidonT5} from "../../src/lib/PoseidonT5.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract CurtainPoolTest is Test {
    uint256 internal constant FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    CurtainPool internal pool;
    AssetGate internal assetGate;
    MockScreeningGate internal screeningGate;
    MockJoinSplitVerifier internal verifier2x2;
    MockJoinSplitVerifier internal verifier3x3;
    MockUnshieldVerifier internal unshieldVerifier;
    MockERC20 internal token;
    IPoseidonT5 internal poseidonT5;

    address internal treasury = address(0x7EA5);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    uint16 internal constant FEE_BPS = 20; // 0.20%

    function setUp() public {
        address hasherT3 = address(new PoseidonT3Deployer());
        address hasherT5Addr = address(new PoseidonT5Deployer());
        poseidonT5 = IPoseidonT5(PoseidonT5Deployer(hasherT5Addr).hasher());

        assetGate = new AssetGate(address(this));
        screeningGate = new MockScreeningGate();
        verifier2x2 = new MockJoinSplitVerifier();
        verifier3x3 = new MockJoinSplitVerifier();
        unshieldVerifier = new MockUnshieldVerifier();

        pool = new CurtainPool(
            PoseidonT3Deployer(hasherT3).hasher(),
            PoseidonT5Deployer(hasherT5Addr).hasher(),
            address(assetGate),
            address(screeningGate),
            address(verifier2x2),
            address(verifier3x3),
            address(unshieldVerifier),
            address(0), // no RelayAdapt in this suite — reshield() is exercised in test/adapt/RelayAdapt.t.sol
            treasury,
            address(0) /* feeSource */,
            FEE_BPS,
            address(0), // no meta-tx forwarder in this suite — exercised in test/pool/CurtainPoolMetaTx.t.sol
            address(0) /* guardian */
        );

        token = new MockERC20("USD Global", "USDG");
        assetGate.register(address(token), false, address(0));

        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
    }

    function _shield(address from, uint256 rawAmount, uint256 ownerPkX, uint256 blinding)
        internal
        returns (bytes32 commit, uint32 leafIndex, uint256 netAmount)
    {
        vm.prank(from);
        (commit, leafIndex) = pool.shield(address(token), rawAmount, ownerPkX, blinding, hex"01", hex"02");
        uint256 fee = (rawAmount * FEE_BPS) / 10000;
        netAmount = rawAmount - fee;
    }

    // ---- shield ----

    function test_shield_pullsTokensChargesFeeAndCreatesNote() public {
        uint256 rawAmount = 100 ether;
        uint256 fee = (rawAmount * FEE_BPS) / 10000;

        (bytes32 commit, uint32 leafIndex, uint256 netAmount) = _shield(alice, rawAmount, 111, 222);

        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(address(pool)), netAmount);
        assertEq(token.balanceOf(alice), 1_000 ether - rawAmount);
        assertEq(leafIndex, 0);
        assertEq(pool.originOf(commit), alice);
        assertGt(pool.shieldedAt(commit), 0);

        uint256 expectedCommit = poseidonT5.poseidon([pool.tokenIdOf(address(token)), netAmount, uint256(111), uint256(222)]);
        assertEq(uint256(commit), expectedCommit);
    }

    function test_shield_revertsForUnregisteredToken() public {
        MockERC20 other = new MockERC20("Other", "OTH");
        other.mint(alice, 10 ether);
        vm.prank(alice);
        other.approve(address(pool), type(uint256).max);

        vm.prank(alice);
        vm.expectRevert(CurtainPool.TokenNotRegistered.selector);
        pool.shield(address(other), 1 ether, 1, 2, hex"", hex"");
    }

    function test_shield_incrementsLeafIndex() public {
        (, uint32 leaf0,) = _shield(alice, 10 ether, 1, 1);
        (, uint32 leaf1,) = _shield(alice, 10 ether, 2, 2);
        assertEq(leaf0, 0);
        assertEq(leaf1, 1);
    }

    // ---- markCleared ----

    function test_markCleared_insertsIntoClearedTreeWhenGateSaysSpendable() public {
        (bytes32 commit,,) = _shield(alice, 10 ether, 1, 1);
        bytes32 clearedRootBefore = pool.currentClearedRoot();

        screeningGate.setSpendable(true);
        uint32 clearedLeafIndex = pool.markCleared(commit);

        assertEq(clearedLeafIndex, 0);
        assertTrue(pool.clearedTreeMember(commit));
        assertTrue(pool.isKnownClearedRoot(pool.currentClearedRoot()));
        assertNotEq(uint256(pool.currentClearedRoot()), uint256(clearedRootBefore));
    }

    function test_markCleared_revertsWhenGateSaysNotSpendable() public {
        (bytes32 commit,,) = _shield(alice, 10 ether, 1, 1);
        screeningGate.setSpendable(false);

        vm.expectRevert(CurtainPool.NotSpendable.selector);
        pool.markCleared(commit);
    }

    function test_markCleared_revertsForNeverShieldedCommit() public {
        vm.expectRevert(CurtainPool.NotShielded.selector);
        pool.markCleared(bytes32(uint256(0xdead)));
    }

    function test_markCleared_cannotBeCalledTwice() public {
        (bytes32 commit,,) = _shield(alice, 10 ether, 1, 1);
        screeningGate.setSpendable(true);
        pool.markCleared(commit);

        vm.expectRevert(CurtainPool.AlreadyClearedTreeMember.selector);
        pool.markCleared(commit);
    }

    function test_markCleared_isPermissionless() public {
        (bytes32 commit,,) = _shield(alice, 10 ether, 1, 1);
        screeningGate.setSpendable(true);

        vm.prank(bob); // not alice, not any privileged address
        pool.markCleared(commit);

        assertTrue(pool.clearedTreeMember(commit));
    }

    // ---- unshieldToOrigin ----

    function test_unshieldToOrigin_paysOriginNetOfUnshieldFee() public {
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 100 ether, 111, 222);

        uint256 unshieldFee = (netAmount * FEE_BPS) / 10000;
        uint256 expectedPayout = netAmount - unshieldFee;
        uint256 treasuryBefore = token.balanceOf(treasury);

        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, 1, hex"");

        assertEq(token.balanceOf(alice), 1_000 ether - 100 ether + expectedPayout);
        assertEq(token.balanceOf(treasury), treasuryBefore + unshieldFee);
        assertEq(token.balanceOf(address(pool)), 0);
    }

    function test_unshieldToOrigin_worksForAnyCaller_notJustOrigin() public {
        // Anyone can submit the tx (e.g. a broadcaster); funds still only
        // ever go to the recorded origin — never a parameter.
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 50 ether, 5, 6);

        vm.prank(bob);
        pool.unshieldToOrigin(commit, address(token), netAmount, 5, 6, 2, hex"");

        assertGt(token.balanceOf(alice), 1_000 ether - 50 ether);
        assertEq(token.balanceOf(bob), 0);
    }

    function test_unshieldToOrigin_revertsForUnknownCommit() public {
        vm.expectRevert(CurtainPool.NotOrigin.selector);
        pool.unshieldToOrigin(bytes32(uint256(0xdead)), address(token), 1 ether, 1, 1, 3, hex"");
    }

    function test_unshieldToOrigin_revertsIfOpeningDoesNotMatchCommit() public {
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 20 ether, 111, 222);

        vm.expectRevert(CurtainPool.InvalidProof.selector);
        pool.unshieldToOrigin(commit, address(token), netAmount, 999, 222, 4, hex""); // wrong ownerPkX
    }

    function test_unshieldToOrigin_cannotBeReplayed() public {
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 20 ether, 111, 222);
        uint256 nullifier = 5;

        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, nullifier, hex"");

        vm.expectRevert(CurtainPool.AlreadyUnshielded.selector);
        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, nullifier, hex"");
    }

    function test_unshieldToOrigin_worksEvenWhenGateSaysNotSpendable() public {
        // The whole point of unshieldToOrigin: it bypasses ScreeningGate
        // entirely, so it works even if a note is flagged/never cleared.
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 20 ether, 111, 222);
        screeningGate.setSpendable(false);

        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, 6, hex"");
        assertEq(token.balanceOf(address(pool)), 0);
    }

    function test_unshieldToOrigin_revertsWhenUnshieldVerifierRejects() public {
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 20 ether, 111, 222);
        unshieldVerifier.setResult(false);

        vm.expectRevert(CurtainPool.InvalidProof.selector);
        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, 7, hex"");
    }

    /// Regression test for the double-spend this milestone's unshield
    /// nullifier unification fixed: a note already spent via transact()'s
    /// join-split nullifier must not also be unshieldable via the origin
    /// escape hatch using that same nullifier.
    function test_unshieldToOrigin_revertsIfNullifierAlreadyUsedByTransact() public {
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 10 ether, 1, 1);

        bytes32 sharedNullifier = bytes32(uint256(42));
        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = sharedNullifier;
        args.nullifiers[1] = bytes32(uint256(43));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(44));
        args.newCommits[1] = bytes32(uint256(45));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);
        pool.transact(args);

        vm.expectRevert(CurtainPool.AlreadyUnshielded.selector);
        pool.unshieldToOrigin(commit, address(token), netAmount, 1, 1, uint256(sharedNullifier), hex"");
    }

    /// The other direction of the same regression: a note already
    /// unshielded via the origin escape hatch must not also be spendable
    /// via transact() using that same nullifier.
    function test_transact_revertsIfNullifierAlreadyUsedByUnshieldToOrigin() public {
        (bytes32 commit,, uint256 netAmount) = _shield(alice, 10 ether, 1, 1);

        bytes32 sharedNullifier = bytes32(uint256(99));
        pool.unshieldToOrigin(commit, address(token), netAmount, 1, 1, uint256(sharedNullifier), hex"");

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = sharedNullifier;
        args.nullifiers[1] = bytes32(uint256(100));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(101));
        args.newCommits[1] = bytes32(uint256(102));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);

        vm.expectRevert(CurtainPool.NullifierAlreadyUsed.selector);
        pool.transact(args);
    }

    // ---- transact (mocked verifier — see MockJoinSplitVerifier header) ----

    function test_transact_revertsForUnknownRoot() public {
        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = bytes32(uint256(0xbad));
        args.clearedRoot = pool.currentClearedRoot();

        vm.expectRevert(CurtainPool.UnknownRoot.selector);
        pool.transact(args);
    }

    function test_transact_revertsForUnknownClearedRoot() public {
        _shield(alice, 10 ether, 1, 1);

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = bytes32(uint256(0xbad));

        vm.expectRevert(CurtainPool.UnknownClearedRoot.selector);
        pool.transact(args);
    }

    function test_transact_withValidProof_marksNullifiersAndInsertsCommitments() public {
        _shield(alice, 10 ether, 1, 1); // establishes a known root

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = bytes32(uint256(1001));
        args.nullifiers[1] = bytes32(uint256(1002));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(2001));
        args.newCommits[1] = bytes32(uint256(2002));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);

        pool.transact(args);

        assertTrue(pool.nullifierUsed(args.nullifiers[0]));
        assertTrue(pool.nullifierUsed(args.nullifiers[1]));
    }

    function test_transact_outputsAreAutomaticallyClearedTreeMembers() public {
        _shield(alice, 10 ether, 1, 1);

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = bytes32(uint256(1101));
        args.nullifiers[1] = bytes32(uint256(1102));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(2101));
        args.newCommits[1] = bytes32(uint256(2102));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);

        pool.transact(args);

        // Outputs inherit cleared status — no markCleared() round trip needed.
        assertTrue(pool.clearedTreeMember(args.newCommits[0]));
        assertTrue(pool.clearedTreeMember(args.newCommits[1]));
    }

    function test_transact_revertsOnNullifierReuse() public {
        _shield(alice, 10 ether, 1, 1);

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = bytes32(uint256(3001));
        args.nullifiers[1] = bytes32(uint256(3002));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(4001));
        args.newCommits[1] = bytes32(uint256(4002));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);

        pool.transact(args);

        args.newCommits[0] = bytes32(uint256(5001));
        args.newCommits[1] = bytes32(uint256(5002));
        vm.expectRevert(CurtainPool.NullifierAlreadyUsed.selector);
        pool.transact(args);
    }

    function test_transact_revertsWhenVerifierRejects() public {
        _shield(alice, 10 ether, 1, 1);
        verifier2x2.setResult(false);

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = bytes32(uint256(6001));
        args.nullifiers[1] = bytes32(uint256(6002));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(7001));
        args.newCommits[1] = bytes32(uint256(7002));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);

        vm.expectRevert(CurtainPool.InvalidProof.selector);
        pool.transact(args);
    }

    function test_transact_withUnshield_paysOutAndChargesFee() public {
        _shield(alice, 100 ether, 1, 1);

        CurtainPool.TransactArgs memory args = _emptyTransactArgs();
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = bytes32(uint256(8001));
        args.nullifiers[1] = bytes32(uint256(8002));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(9001));
        args.newCommits[1] = bytes32(uint256(9002));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);
        args.unshieldTo = bob;
        args.unshieldAmount = 10 ether;
        args.feeAmount = 1 ether;

        uint256 treasuryBefore = token.balanceOf(treasury);
        pool.transact(args);

        assertEq(token.balanceOf(bob), 10 ether);
        assertEq(token.balanceOf(treasury), treasuryBefore + 1 ether);
    }

    function _emptyTransactArgs() internal view returns (CurtainPool.TransactArgs memory args) {
        args.proof = hex"";
        args.token = address(token);
        args.nullifiers = new bytes32[](0);
        args.newCommits = new bytes32[](0);
        args.ephemeralPks = new bytes[](0);
        args.cts = new bytes[](0);
        args.clearedRoot = pool.currentClearedRoot();
    }

    // ---- immutability ----

    function test_immutability_noAdminSelectors() public {
        (bool okOwner,) = address(pool).call(abi.encodeWithSignature("owner()"));
        (bool okTransferOwnership,) = address(pool).call(abi.encodeWithSignature("transferOwnership(address)", address(this)));
        (bool okPause,) = address(pool).call(abi.encodeWithSignature("pause()"));
        (bool okUpgradeTo,) = address(pool).call(abi.encodeWithSignature("upgradeTo(address)", address(this)));

        assertFalse(okOwner, "pool must not have owner()");
        assertFalse(okTransferOwnership, "pool must not have transferOwnership()");
        assertFalse(okPause, "pool must not have pause()");
        assertFalse(okUpgradeTo, "pool must not have upgradeTo()");
    }

    // ---- fuzz: conservation ----

    function testFuzz_shield_balanceConservation(uint96 rawAmountRaw, uint96 ownerPkXRaw, uint96 blindingRaw) public {
        uint256 rawAmount = bound(uint256(rawAmountRaw), 1, 500 ether);
        token.mint(alice, rawAmount);

        uint256 poolBalanceBefore = token.balanceOf(address(pool));
        uint256 treasuryBefore = token.balanceOf(treasury);

        (, , uint256 netAmount) = _shield(alice, rawAmount, ownerPkXRaw, blindingRaw);
        uint256 fee = (rawAmount * FEE_BPS) / 10000;

        assertEq(token.balanceOf(address(pool)), poolBalanceBefore + netAmount);
        assertEq(token.balanceOf(treasury), treasuryBefore + fee);
        assertEq(netAmount + fee, rawAmount);
    }
}
