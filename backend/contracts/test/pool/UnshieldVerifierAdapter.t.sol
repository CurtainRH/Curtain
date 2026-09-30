// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {UnshieldGroth16Verifier} from "../../src/pool/generated/UnshieldGroth16Verifier.sol";
import {UnshieldVerifierAdapter} from "../../src/pool/UnshieldVerifierAdapter.sol";

/// @notice Proves the unshield-nullifier-unification fix (see
/// CurtainPool.sol's header and circuits/unshield.circom) works with a
/// genuine proof: the real Groth16 verifier snarkjs generated from
/// circuits/unshield.circom (circuits/scripts/prove-unshield-fixture.cjs),
/// wired through CurtainPool's adapter. Mirrors
/// JoinSplitVerifierAdapter.t.sol's pattern — CurtainPool.t.sol's own
/// unshieldToOrigin tests use a mock verifier for pool bookkeeping; this is
/// the dedicated test for the real cryptography underneath it.
contract UnshieldVerifierAdapterTest is Test {
    UnshieldVerifierAdapter internal adapter;

    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;
    uint256[] internal pubSignals;

    function setUp() public {
        UnshieldGroth16Verifier verifier = new UnshieldGroth16Verifier();
        adapter = new UnshieldVerifierAdapter(address(verifier));

        string memory json = vm.readFile("test/fixtures/unshield_proof.json");

        a[0] = vm.parseJsonUint(json, ".a[0]");
        a[1] = vm.parseJsonUint(json, ".a[1]");
        b[0][0] = vm.parseJsonUint(json, ".b[0][0]");
        b[0][1] = vm.parseJsonUint(json, ".b[0][1]");
        b[1][0] = vm.parseJsonUint(json, ".b[1][0]");
        b[1][1] = vm.parseJsonUint(json, ".b[1][1]");
        c[0] = vm.parseJsonUint(json, ".c[0]");
        c[1] = vm.parseJsonUint(json, ".c[1]");

        pubSignals = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            pubSignals[i] = vm.parseJsonUint(json, string.concat(".pubSignals[", vm.toString(i), "]"));
        }
    }

    function test_realGrothProof_verifiesThroughAdapter() public view {
        bytes memory proof = abi.encode(a, b, c);
        bool ok = adapter.verifyProof(proof, pubSignals);
        assertTrue(ok, "genuine unshield proof must verify through the adapter");
    }

    function test_tamperedNullifier_failsVerification() public view {
        uint256[] memory tampered = pubSignals;
        tampered[2] = tampered[2] + 1; // corrupt nullifier (index 2: ownerPkX, leafIndex, nullifier)

        bytes memory proof = abi.encode(a, b, c);
        bool ok = adapter.verifyProof(proof, tampered);
        assertFalse(ok, "tampered nullifier must not verify");
    }

    function test_tamperedLeafIndex_failsVerification() public view {
        // Proves the contract-supplied leafIndex is genuinely load-bearing:
        // a proof made for leafIndex=5 must not verify against a different
        // leafIndex, which is exactly what stops a caller from picking a
        // fresh leafIndex to mint a new nullifier for the same note.
        uint256[] memory tampered = pubSignals;
        tampered[1] = tampered[1] + 1;

        bytes memory proof = abi.encode(a, b, c);
        bool ok = adapter.verifyProof(proof, tampered);
        assertFalse(ok, "tampered leafIndex must not verify");
    }

    function test_wrongSignalCount_reverts() public {
        uint256[] memory tooFew = new uint256[](2);
        tooFew[0] = pubSignals[0];
        tooFew[1] = pubSignals[1];

        bytes memory proof = abi.encode(a, b, c);
        vm.expectRevert("UnshieldVerifierAdapter: expected 3 public signals");
        adapter.verifyProof(proof, tooFew);
    }
}
