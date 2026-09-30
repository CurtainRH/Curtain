// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {ScreeningGate} from "../../src/gate/ScreeningGate.sol";
import {RelayAdapt} from "../../src/adapt/RelayAdapt.sol";
import {SolvencyVerifier} from "../../src/solvency/SolvencyVerifier.sol";
import {MockSolvencyVerifier} from "../mocks/MockSolvencyVerifier.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {PoseidonT2Deployer} from "../../src/lib/PoseidonT2.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";

/// @notice Launch Gates Verification Suite per Curtain_Build.md §9.
/// All 7 launch gates must pass before mainnet deployment.
contract LaunchGatesTest is Test {
    CurtainPool internal pool;
    AssetGate internal assetGate;
    ScreeningGate internal gate;
    RelayAdapt internal adapt;
    SolvencyVerifier internal solvencyVerifier;
    MockSolvencyVerifier internal mockSolvencyAdapter;
    MockERC20 internal token;

    address internal treasury = address(0x7EA5);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B); // must match test/fixtures/flag_proof.json's origin
    address internal origin = address(0x0016);

    bytes4[] private forbiddenAdminSelectors = [
        bytes4(keccak256("owner()")),
        bytes4(keccak256("transferOwnership(address)")),
        bytes4(keccak256("pause()")),
        bytes4(keccak256("unpause()")),
        bytes4(keccak256("upgradeTo(address)")),
        bytes4(keccak256("setFee(uint256)"))
    ];

    function setUp() public {
        address poseidonT2 = address(new PoseidonT2Deployer());
        address poseidonT3 = address(new PoseidonT3Deployer());
        address poseidonT5 = address(new PoseidonT5Deployer());

        assetGate = new AssetGate(address(this));
        token = new MockERC20("USD Global", "USDG");
        assetGate.register(address(token), false, address(0));

        gate = new ScreeningGate(
            PoseidonT2Deployer(poseidonT2).hasher(),
            PoseidonT3Deployer(poseidonT3).hasher(),
            address(0),
            address(this)
        );

        address verifier2x2 = address(new MockJoinSplitVerifier());
        address verifier3x3 = address(new MockJoinSplitVerifier());
        address unshieldVerifier = address(new MockUnshieldVerifier());

        address predictedRelayAdapt = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);

        pool = new CurtainPool(
            PoseidonT3Deployer(poseidonT3).hasher(),
            PoseidonT5Deployer(poseidonT5).hasher(),
            address(assetGate),
            address(gate),
            verifier2x2,
            verifier3x3,
            unshieldVerifier,
            predictedRelayAdapt,
            treasury,
            address(0) /* feeSource */,
            20,
            address(0),
            address(0) /* guardian */
        );

        adapt = new RelayAdapt(address(pool), address(this));
        require(address(adapt) == predictedRelayAdapt, "LaunchGatesTest: RelayAdapt predicted address mismatch");

        gate.setPool(address(pool));

        mockSolvencyAdapter = new MockSolvencyVerifier();
        solvencyVerifier = new SolvencyVerifier(address(pool), address(mockSolvencyAdapter));

        token.mint(alice, 10_000 ether);
        token.mint(bob, 10_000 ether);
    }

    /// @notice Gate 1: Immutability — pool has no owner, upgrade, or pause functions.
    function test_Gate1_Immutability() public view {
        for (uint256 i = 0; i < forbiddenAdminSelectors.length; i++) {
            bytes4 sel = forbiddenAdminSelectors[i];
            (bool success, ) = address(pool).staticcall(abi.encodeWithSelector(sel));
            assertFalse(success, "LaunchGate Failed: CurtainPool has forbidden admin selector!");
        }
    }

    /// @notice Gate 2: Exit Safety — unshieldToOrigin succeeds regardless of the note's
    /// screening state (still-in-standby, flagged, or degraded-provider standby). There is
    /// no guardian-pause mechanism to test here: CurtainPool has zero admin/pause selectors
    /// by design (Gate 1), and Curtain_Build.md §11 item 9 assigns any future guardian pause
    /// to `shield`/`relay` only via an external contract, never to `unshieldToOrigin` — so
    /// "every state" for THIS gate means every ScreeningGate screening outcome, which is what
    /// each sub-test below exercises.
    function _shieldFor(address who, uint256 amount, uint256 pkX, uint256 blinding)
        internal
        returns (bytes32 commit, uint256 netAmount, uint256 expectedPayout)
    {
        vm.startPrank(who);
        token.approve(address(pool), amount);
        (commit, ) = pool.shield(address(token), amount, pkX, blinding, "0x", "0x");
        vm.stopPrank();

        netAmount = amount - (amount * 20 / 10000);
        expectedPayout = netAmount - (netAmount * 20 / 10000);
    }

    function test_Gate2_ExitSafety_duringStandby() public {
        (bytes32 commit, uint256 netAmount, uint256 expectedPayout) = _shieldFor(alice, 100 ether, 111, 222);

        // Still within the 15-minute standby window — not cleared, not flagged.
        assertFalse(gate.spendable(commit));

        uint256 aliceBalBefore = token.balanceOf(alice);
        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, 1, hex"");
        assertEq(token.balanceOf(alice), aliceBalBefore + expectedPayout);
    }

    function test_Gate2_ExitSafety_whenFlagged() public {
        // Uses the same genuine plain-Merkle flag fixture ScreeningGate.t.sol exercises
        // (test/fixtures/flag_proof.json), whose flagRoot lists bob's address (0xB0B) —
        // flag() only checks the origin address against the tree, so the shield's own
        // amount/pk/blinding are irrelevant here.
        (bytes32 commit, uint256 netAmount, uint256 expectedPayout) = _shieldFor(bob, 100 ether, 333, 444);

        string memory flagJson = vm.readFile("test/fixtures/flag_proof.json");
        bytes32 flagRoot = vm.parseJsonBytes32(flagJson, ".flagRoot");
        gate.addProvider(0, address(this), bytes32(0), flagRoot);

        uint256[32] memory pathElements;
        uint8[32] memory pathIndices;
        for (uint256 i = 0; i < 32; i++) {
            pathElements[i] = vm.parseJsonUint(flagJson, string.concat(".pathElements[", vm.toString(i), "]"));
            pathIndices[i] = uint8(vm.parseJsonUint(flagJson, string.concat(".pathIndices[", vm.toString(i), "]")));
        }
        gate.flag(commit, 0, pathElements, pathIndices);
        assertTrue(gate.flagged(commit));
        assertFalse(gate.spendable(commit));

        // Flagged notes still exit fine via unshieldToOrigin — only transact()/relay would
        // ever be denied by ScreeningGate.spendable().
        uint256 bobBalBefore = token.balanceOf(bob);
        pool.unshieldToOrigin(commit, address(token), netAmount, 333, 444, 2, hex"");
        assertEq(token.balanceOf(bob), bobBalBefore + expectedPayout);
    }

    function test_Gate2_ExitSafety_duringDegradedProviderStandby() public {
        // Zero fresh providers => standby() returns the 60-minute degraded window instead of 15.
        assertEq(gate.freshProviderCount(), 0);
        assertEq(gate.standby(), gate.STANDBY_DEGRADED_SECONDS());

        (bytes32 commit, uint256 netAmount, uint256 expectedPayout) = _shieldFor(alice, 100 ether, 555, 666);
        assertFalse(gate.spendable(commit));

        uint256 aliceBalBefore = token.balanceOf(alice);
        pool.unshieldToOrigin(commit, address(token), netAmount, 555, 666, 3, hex"");
        assertEq(token.balanceOf(alice), aliceBalBefore + expectedPayout);
    }

    function test_Gate2_ExitSafety_afterCleared() public {
        (bytes32 commit, uint256 netAmount, uint256 expectedPayout) = _shieldFor(alice, 100 ether, 777, 888);

        // No providers configured => degraded 60-minute standby; warp past it so
        // ScreeningGate.spendable() flips true and markCleared() will accept the commit.
        vm.warp(vm.getBlockTimestamp() + gate.STANDBY_DEGRADED_SECONDS() + 1);
        assertTrue(gate.spendable(commit));
        pool.markCleared(commit);

        // Exit still works identically once a note is fully cleared for transact() too.
        uint256 aliceBalBefore = token.balanceOf(alice);
        pool.unshieldToOrigin(commit, address(token), netAmount, 777, 888, 4, hex"");
        assertEq(token.balanceOf(alice), aliceBalBefore + expectedPayout);
    }

    /// @notice Gate 3: PPOI — provider freshness and standby (15 min standard / 60 min degraded).
    function test_Gate3_PPOI_Standby() public view {
        assertEq(gate.STANDBY_SECONDS(), 15 minutes);
        assertEq(gate.STANDBY_DEGRADED_SECONDS(), 60 minutes);
    }

    /// @notice Gate 4: Solvency — pool balance backing live notes verified on-chain.
    function test_Gate4_Solvency_Epoch() public {
        // Mint pool balance
        token.mint(address(pool), 5_000 ether);

        // Submit valid chunk proof
        mockSolvencyAdapter.setShouldPass(true);
        solvencyVerifier.submitChunk(1, address(token), 0, 1, 4_000 ether, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");

        // Finalize epoch
        solvencyVerifier.finalizeEpoch(1, address(token));

        (bool status, uint64 ts, uint256 liveNotes, uint256 poolBal) = solvencyVerifier.epochOk(address(token));
        assertTrue(status);
        assertEq(liveNotes, 4_000 ether);
        assertGt(poolBal, 0);
        assertGt(ts, 0);
    }
}
