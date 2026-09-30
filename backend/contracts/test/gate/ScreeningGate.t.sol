// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ScreeningGate} from "../../src/gate/ScreeningGate.sol";
import {PpoiDevGroth16Verifier} from "../../src/gate/generated/PpoiDevGroth16Verifier.sol";
import {PpoiDevVerifierAdapter} from "../../src/gate/PpoiDevVerifierAdapter.sol";
import {PoseidonT2Deployer} from "../../src/lib/PoseidonT2.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Exercises the REAL ScreeningGate wired to a REAL CurtainPool,
/// using genuine M2 PPOI proofs (circuits/scripts/prove-ppoi-gate-fixture.cjs)
/// and a genuine plain Merkle inclusion proof for flag()
/// (prove-flag-fixture.cjs) — the actual M4 acceptance surface, not a mock.
contract ScreeningGateTest is Test {
    uint16 internal constant FEE_BPS = 20;
    uint256 internal constant SHIELD_TIMESTAMP = 1_000_000;

    // Must match circuits/scripts/prove-ppoi-gate-fixture.cjs exactly.
    address internal constant TOKEN_ADDR = 0x000000000000000000000000000000000000FEeD;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    ScreeningGate internal gate;
    CurtainPool internal pool;
    AssetGate internal assetGate;

    function setUp() public {
        address hasherT2 = PoseidonT2Deployer(address(new PoseidonT2Deployer())).hasher();
        address hasherT3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address hasherT5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();

        PpoiDevGroth16Verifier ppoiVerifier = new PpoiDevGroth16Verifier();
        PpoiDevVerifierAdapter ppoiAdapter = new PpoiDevVerifierAdapter(address(ppoiVerifier));

        gate = new ScreeningGate(hasherT2, hasherT3, address(ppoiAdapter), address(this));

        assetGate = new AssetGate(address(this));
        MockJoinSplitVerifier v2 = new MockJoinSplitVerifier();
        MockJoinSplitVerifier v3 = new MockJoinSplitVerifier();
        MockUnshieldVerifier unshieldVerifier = new MockUnshieldVerifier();

        pool = new CurtainPool(
            hasherT3, hasherT5, address(assetGate), address(gate), address(v2), address(v3),
            address(unshieldVerifier), address(0), address(0x7EA5), address(0) /* feeSource */, FEE_BPS, address(0), address(0) /* guardian */
        );
        gate.setPool(address(pool));

        // Deploy a token at the exact fixed address the JS fixture used, so
        // the on-chain tokenId derivation matches what was proven against.
        MockERC20 template = new MockERC20("USD Global", "USDG");
        vm.etch(TOKEN_ADDR, address(template).code);
        assetGate.register(TOKEN_ADDR, false, address(0));
        MockERC20(TOKEN_ADDR).mint(alice, 1_000 ether);
        MockERC20(TOKEN_ADDR).mint(bob, 1_000 ether);
        vm.prank(alice);
        MockERC20(TOKEN_ADDR).approve(address(pool), type(uint256).max);
        vm.prank(bob);
        MockERC20(TOKEN_ADDR).approve(address(pool), type(uint256).max);

        vm.warp(SHIELD_TIMESTAMP);
    }

    function _readFixture(string memory path) internal view returns (string memory) {
        return vm.readFile(path);
    }

    function _registerProvidersFromFixture() internal returns (bytes32 commit, bytes memory proof) {
        string memory json = _readFixture("test/fixtures/ppoi_gate_proof.json");

        bytes32 root0 = vm.parseJsonBytes32(json, ".providerRoots[0]");
        bytes32 root1 = vm.parseJsonBytes32(json, ".providerRoots[1]");
        bytes32 root2 = vm.parseJsonBytes32(json, ".providerRoots[2]");
        gate.addProvider(0, address(this), root0, bytes32(0));
        gate.addProvider(1, address(this), root1, bytes32(0));
        gate.addProvider(2, address(this), root2, bytes32(0));

        commit = vm.parseJsonBytes32(json, ".commit");

        uint256[2] memory a;
        uint256[2][2] memory b;
        uint256[2] memory c;
        a[0] = vm.parseJsonUint(json, ".a[0]");
        a[1] = vm.parseJsonUint(json, ".a[1]");
        b[0][0] = vm.parseJsonUint(json, ".b[0][0]");
        b[0][1] = vm.parseJsonUint(json, ".b[0][1]");
        b[1][0] = vm.parseJsonUint(json, ".b[1][0]");
        b[1][1] = vm.parseJsonUint(json, ".b[1][1]");
        c[0] = vm.parseJsonUint(json, ".c[0]");
        c[1] = vm.parseJsonUint(json, ".c[1]");
        proof = abi.encode(a, b, c);
    }

    function _shieldAliceNote() internal returns (bytes32 commit) {
        vm.prank(alice);
        (commit,) = pool.shield(TOKEN_ADDR, 10 ether, 111, 222, hex"", hex"");
    }

    // ---- ppoiVerify (real proof) ----

    function test_ppoiVerify_realProof_clearsNote() public {
        (bytes32 fixtureCommit, bytes memory proof) = _registerProvidersFromFixture();
        bytes32 commit = _shieldAliceNote();
        assertEq(commit, fixtureCommit, "fixture must match the real shield() commitment");

        gate.ppoiVerify(commit, proof);

        assertTrue(gate.cleared(commit));
        assertTrue(gate.spendable(commit));
    }

    function test_ppoiVerify_thenMarkCleared_insertsIntoPoolClearedTree() public {
        (, bytes memory proof) = _registerProvidersFromFixture();
        bytes32 commit = _shieldAliceNote();

        gate.ppoiVerify(commit, proof);
        pool.markCleared(commit);

        assertTrue(pool.clearedTreeMember(commit));
    }

    function test_ppoiVerify_revertsForUnshieldedCommit() public {
        _registerProvidersFromFixture();
        vm.expectRevert(ScreeningGate.NoteNotShielded.selector);
        gate.ppoiVerify(bytes32(uint256(0xdead)), hex"");
    }

    function test_ppoiVerify_cannotBeCalledTwice() public {
        (, bytes memory proof) = _registerProvidersFromFixture();
        bytes32 commit = _shieldAliceNote();

        gate.ppoiVerify(commit, proof);

        vm.expectRevert(ScreeningGate.AlreadyCleared.selector);
        gate.ppoiVerify(commit, proof);
    }

    // ---- standby (no explicit clearing) ----

    function test_spendable_falseDuringStandby() public {
        _registerProvidersFromFixture();
        bytes32 commit = _shieldAliceNote();

        assertFalse(gate.spendable(commit));
    }

    function test_spendable_trueAfterStandbyElapses() public {
        _registerProvidersFromFixture();
        bytes32 commit = _shieldAliceNote();

        vm.warp(SHIELD_TIMESTAMP + 15 minutes + 1);
        assertTrue(gate.spendable(commit));
    }

    function test_standby_degradesTo60MinWhenProvidersStale() public {
        _registerProvidersFromFixture();
        assertEq(gate.standby(), 15 minutes);

        // Let 2 of 3 providers go stale (> 24h without an update).
        vm.warp(SHIELD_TIMESTAMP + 25 hours);
        assertEq(gate.standby(), 60 minutes);
    }

    // ---- flag (plain Merkle proof) ----

    function test_flag_realMerkleProof_flagsNoteWithinStandby() public {
        _registerProvidersFromFixture();

        string memory flagJson = _readFixture("test/fixtures/flag_proof.json");
        bytes32 flagRoot = vm.parseJsonBytes32(flagJson, ".flagRoot");
        (bytes32 existingListRoot,,,,,,,) = gate.providers(0);
        gate.removeProvider(0); // addProvider can't overwrite an active provider
        gate.addProvider(0, address(this), existingListRoot, flagRoot);

        // bob's note (address 0xB0B) is the one listed in the flag fixture.
        vm.prank(bob);
        (bytes32 commit,) = pool.shield(TOKEN_ADDR, 5 ether, 5, 6, hex"", hex"");

        uint256[32] memory pathElements;
        uint8[32] memory pathIndices;
        for (uint256 i = 0; i < 32; i++) {
            pathElements[i] = vm.parseJsonUint(flagJson, string.concat(".pathElements[", vm.toString(i), "]"));
            pathIndices[i] = uint8(vm.parseJsonUint(flagJson, string.concat(".pathIndices[", vm.toString(i), "]")));
        }

        gate.flag(commit, 0, pathElements, pathIndices);

        assertTrue(gate.flagged(commit));
        assertFalse(gate.spendable(commit));
    }

    function test_flag_notePermanentlyUnspendable_evenAfterStandby() public {
        _registerProvidersFromFixture();
        string memory flagJson = _readFixture("test/fixtures/flag_proof.json");
        bytes32 flagRoot = vm.parseJsonBytes32(flagJson, ".flagRoot");
        (bytes32 existingListRoot,,,,,,,) = gate.providers(0);
        gate.removeProvider(0); // addProvider can't overwrite an active provider
        gate.addProvider(0, address(this), existingListRoot, flagRoot);

        vm.prank(bob);
        (bytes32 commit,) = pool.shield(TOKEN_ADDR, 5 ether, 5, 6, hex"", hex"");

        uint256[32] memory pathElements;
        uint8[32] memory pathIndices;
        for (uint256 i = 0; i < 32; i++) {
            pathElements[i] = vm.parseJsonUint(flagJson, string.concat(".pathElements[", vm.toString(i), "]"));
            pathIndices[i] = uint8(vm.parseJsonUint(flagJson, string.concat(".pathIndices[", vm.toString(i), "]")));
        }
        gate.flag(commit, 0, pathElements, pathIndices);

        vm.warp(SHIELD_TIMESTAMP + 365 days);
        assertFalse(gate.spendable(commit), "flagged notes never become spendable, even long after standby");
    }

    function test_flag_revertsIfAlreadyCleared() public {
        (, bytes memory proof) = _registerProvidersFromFixture();
        bytes32 commit = _shieldAliceNote();
        gate.ppoiVerify(commit, proof);

        string memory flagJson = _readFixture("test/fixtures/flag_proof.json");
        bytes32 flagRoot = vm.parseJsonBytes32(flagJson, ".flagRoot");
        (bytes32 existingListRoot,,,,,,,) = gate.providers(0);
        gate.removeProvider(0); // addProvider can't overwrite an active provider
        gate.addProvider(0, address(this), existingListRoot, flagRoot);

        uint256[32] memory pathElements;
        uint8[32] memory pathIndices;
        for (uint256 i = 0; i < 32; i++) {
            pathElements[i] = vm.parseJsonUint(flagJson, string.concat(".pathElements[", vm.toString(i), "]"));
            pathIndices[i] = uint8(vm.parseJsonUint(flagJson, string.concat(".pathIndices[", vm.toString(i), "]")));
        }

        vm.expectRevert(ScreeningGate.AlreadyCleared.selector);
        gate.flag(commit, 0, pathElements, pathIndices);
    }

    // ---- provider admin ----

    function test_updateRoot_rateLimitedToOncePerHour() public {
        gate.addProvider(0, address(this), bytes32(uint256(1)), bytes32(0));

        // addProvider itself sets updatedAt=now, so updateRoot is rate
        // limited immediately too — advance past that window first.
        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        gate.updateRoot(0, bytes32(uint256(2)), bytes32(0));

        vm.expectRevert(ScreeningGate.RateLimited.selector);
        gate.updateRoot(0, bytes32(uint256(3)), bytes32(0));

        vm.warp(vm.getBlockTimestamp() + 1 hours + 1);
        gate.updateRoot(0, bytes32(uint256(3)), bytes32(0)); // now succeeds
    }

    function test_updateRoot_revertsForNonPublisher() public {
        gate.addProvider(0, alice, bytes32(uint256(1)), bytes32(0));

        vm.prank(bob);
        vm.expectRevert(ScreeningGate.NotPublisher.selector);
        gate.updateRoot(0, bytes32(uint256(2)), bytes32(0));
    }

    function test_setPool_cannotBeCalledTwice() public {
        vm.expectRevert(ScreeningGate.PoolAlreadySet.selector);
        gate.setPool(address(0x1234));
    }
}
