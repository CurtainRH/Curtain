// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {SolvencyVerifier} from "../../src/solvency/SolvencyVerifier.sol";
import {MockSolvencyVerifier} from "../mocks/MockSolvencyVerifier.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";

contract SolvencyVerifierTest is Test {
    CurtainPool internal pool;
    AssetGate internal assetGate;
    SolvencyVerifier internal solvencyVerifier;
    MockSolvencyVerifier internal mockVerifier;
    MockERC20 internal usdg;

    address internal owner = address(0xA11CE);
    address internal alice = address(0x411C3);

    function setUp() public {
        address hasherT3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address hasherT5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();

        assetGate = new AssetGate(owner);
        MockScreeningGate gate = new MockScreeningGate();
        MockJoinSplitVerifier joinSplitVer = new MockJoinSplitVerifier();
        MockUnshieldVerifier unshieldVer = new MockUnshieldVerifier();

        usdg = new MockERC20("USD Good", "USDG");

        vm.startPrank(owner);
        assetGate.register(address(usdg), false, address(0));

        pool = new CurtainPool(
            hasherT3,
            hasherT5,
            address(assetGate),
            address(gate),
            address(joinSplitVer),
            address(joinSplitVer),
            address(unshieldVer),
            address(0xADA7),
            owner,
            20,
            20,
            address(0)
        );

        mockVerifier = new MockSolvencyVerifier();
        solvencyVerifier = new SolvencyVerifier(address(pool), address(mockVerifier));

        usdg.mint(address(pool), 1_000e18); // Pool has 1,000 USDG backing
        vm.stopPrank();
    }

    function test_submitChunk_and_finalizeEpoch_solvent() public {
        uint256 epoch = 1;
        uint256 partialSumChunk0 = 400e18;
        uint256 partialSumChunk1 = 500e18; // Total 900e18 <= 1,000e18 pool balance

        solvencyVerifier.submitChunk(epoch, address(usdg), 0, 2, partialSumChunk0, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");
        solvencyVerifier.submitChunk(epoch, address(usdg), 1, 2, partialSumChunk1, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");

        bool ok = solvencyVerifier.finalizeEpoch(epoch, address(usdg));
        assertTrue(ok);

        (bool status, uint64 ts, uint256 liveNotes, uint256 poolBalance) = solvencyVerifier.epochOk(address(usdg));
        assertTrue(status);
        assertEq(ts, uint64(block.timestamp));
        assertEq(liveNotes, 900e18);
        assertEq(poolBalance, 1_000e18);
    }

    function test_finalizeEpoch_revertsWhenInsolvent() public {
        uint256 epoch = 1;
        uint256 partialSum = 1_200e18; // 1,200e18 > 1,000e18 pool balance

        solvencyVerifier.submitChunk(epoch, address(usdg), 0, 1, partialSum, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");

        vm.expectRevert(abi.encodeWithSelector(SolvencyVerifier.InsolventPool.selector, 1_200e18, 1_000e18));
        solvencyVerifier.finalizeEpoch(epoch, address(usdg));
    }

    function test_submitChunk_revertsOnInvalidProof() public {
        uint256 epoch = 1;
        mockVerifier.setShouldPass(false);

        vm.expectRevert(SolvencyVerifier.InvalidSolvencyProof.selector);
        solvencyVerifier.submitChunk(epoch, address(usdg), 0, 1, 100e18, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");
    }

    function test_finalizeEpoch_revertsWhenChunksIncomplete() public {
        uint256 epoch = 1;
        // Declares a 2-chunk epoch but only submits chunk 0 — the pool's true total
        // (900e18, well within the 1,000e18 balance) would look solvent if finalized
        // early, masking whatever the missing chunk actually contains.
        solvencyVerifier.submitChunk(epoch, address(usdg), 0, 2, 400e18, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");

        vm.expectRevert(abi.encodeWithSelector(SolvencyVerifier.EpochIncomplete.selector, uint32(1), uint32(2)));
        solvencyVerifier.finalizeEpoch(epoch, address(usdg));
    }

    function test_finalizeEpoch_revertsWhenNoChunksSubmitted() public {
        vm.expectRevert(SolvencyVerifier.NoChunksSubmitted.selector);
        solvencyVerifier.finalizeEpoch(1, address(usdg));
    }

    function test_submitChunk_revertsOnTotalChunksMismatch() public {
        uint256 epoch = 1;
        solvencyVerifier.submitChunk(epoch, address(usdg), 0, 2, 400e18, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");

        vm.expectRevert(SolvencyVerifier.TotalChunksMismatch.selector);
        solvencyVerifier.submitChunk(epoch, address(usdg), 1, 3, 500e18, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");
    }

    function test_submitChunk_revertsOnChunkIndexOutOfRange() public {
        vm.expectRevert(SolvencyVerifier.ChunkIndexOutOfRange.selector);
        solvencyVerifier.submitChunk(1, address(usdg), 2, 2, 400e18, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");
    }

    function test_submitChunk_revertsOnZeroTotalChunks() public {
        vm.expectRevert(SolvencyVerifier.InvalidTotalChunks.selector);
        solvencyVerifier.submitChunk(1, address(usdg), 0, 0, 400e18, bytes32(uint256(1)), bytes32(uint256(2)), hex"1234");
    }
}
