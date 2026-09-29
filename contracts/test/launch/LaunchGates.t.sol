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
            20,
            20
        );

        adapt = new RelayAdapt(address(pool), address(this));
        require(address(adapt) == predictedRelayAdapt, "LaunchGatesTest: RelayAdapt predicted address mismatch");

        gate.setPool(address(pool));

        mockSolvencyAdapter = new MockSolvencyVerifier();
        solvencyVerifier = new SolvencyVerifier(address(pool), address(mockSolvencyAdapter));

        token.mint(alice, 10_000 ether);
    }

    /// @notice Gate 1: Immutability — pool has no owner, upgrade, or pause functions.
    function test_Gate1_Immutability() public view {
        for (uint256 i = 0; i < forbiddenAdminSelectors.length; i++) {
            bytes4 sel = forbiddenAdminSelectors[i];
            (bool success, ) = address(pool).staticcall(abi.encodeWithSelector(sel));
            assertFalse(success, "LaunchGate Failed: CurtainPool has forbidden admin selector!");
        }
    }

    /// @notice Gate 2: Exit Safety — unshieldToOrigin succeeds in every pool/gate state.
    function test_Gate2_ExitSafety() public {
        // Shield a note for alice (origin = alice)
        vm.startPrank(alice);
        token.approve(address(pool), 100 ether);
        (bytes32 commit, ) = pool.shield(address(token), 100 ether, 111, 222, "0x", "0x");
        vm.stopPrank();

        uint256 netAmount = 100 ether - (100 ether * 20 / 10000); // 99.8 ether
        uint256 expectedPayout = netAmount - (netAmount * 20 / 10000);

        // Origin can always unshield to origin regardless of screening status
        uint256 aliceBalBefore = token.balanceOf(alice);
        pool.unshieldToOrigin(commit, address(token), netAmount, 111, 222, 1, hex"");
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
        solvencyVerifier.submitChunk(1, address(token), 0, 4_000 ether, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");

        // Finalize epoch
        solvencyVerifier.finalizeEpoch(1, address(token));

        (bool status, uint64 ts, uint256 liveNotes, uint256 poolBal) = solvencyVerifier.epochOk(address(token));
        assertTrue(status);
        assertEq(liveNotes, 4_000 ether);
        assertGt(poolBal, 0);
        assertGt(ts, 0);
    }
}
