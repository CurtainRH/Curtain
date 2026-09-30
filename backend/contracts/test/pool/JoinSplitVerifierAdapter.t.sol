// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {JoinSplit2x2Groth16Verifier} from "../../src/pool/generated/JoinSplit2x2Groth16Verifier.sol";
import {JoinSplit2x2VerifierAdapter} from "../../src/pool/JoinSplit2x2VerifierAdapter.sol";

/// @notice Proves the M2 -> M3 integration boundary works with a genuine
/// proof: the real Groth16 verifier snarkjs generated from circuits/
/// joinsplit2x2.circom (circuits/scripts/prove-joinsplit2x2.cjs), wired
/// through CurtainPool's arity-agnostic adapter. This is the actual new
/// risk surface beyond CurtainPool.t.sol's mock-verifier tests, which only
/// cover the pool's own bookkeeping (root/nullifier tracking, fees, tree
/// updates) — not whether the adapter correctly forwards to real Groth16
/// verification.
///
/// The fixture's public signals use a synthetic tokenId (12345) from the
/// proof-generation script, not a real deployed token's address-derived
/// tokenId — so this test exercises the adapter directly rather than a full
/// CurtainPool.transact() call (which would additionally require
/// regenerating a proof on the fly for a specific deployed address, e.g.
/// via FFI — left for when M4+'s indexer/relayer services exist to do that
/// kind of dynamic proving anyway).
contract JoinSplitVerifierAdapterTest is Test {
    JoinSplit2x2VerifierAdapter internal adapter;

    uint256[2] internal a;
    uint256[2][2] internal b;
    uint256[2] internal c;
    uint256[] internal pubSignals;

    function setUp() public {
        JoinSplit2x2Groth16Verifier verifier = new JoinSplit2x2Groth16Verifier();
        adapter = new JoinSplit2x2VerifierAdapter(address(verifier));

        string memory json = vm.readFile("test/fixtures/joinsplit2x2_proof.json");

        a[0] = vm.parseJsonUint(json, ".a[0]");
        a[1] = vm.parseJsonUint(json, ".a[1]");
        b[0][0] = vm.parseJsonUint(json, ".b[0][0]");
        b[0][1] = vm.parseJsonUint(json, ".b[0][1]");
        b[1][0] = vm.parseJsonUint(json, ".b[1][0]");
        b[1][1] = vm.parseJsonUint(json, ".b[1][1]");
        c[0] = vm.parseJsonUint(json, ".c[0]");
        c[1] = vm.parseJsonUint(json, ".c[1]");

        pubSignals = new uint256[](11);
        for (uint256 i = 0; i < 11; i++) {
            pubSignals[i] = vm.parseJsonUint(json, string.concat(".pubSignals[", vm.toString(i), "]"));
        }
    }

    function test_realGrothProof_verifiesThroughAdapter() public view {
        bytes memory proof = abi.encode(a, b, c);
        bool ok = adapter.verifyProof(proof, pubSignals);
        assertTrue(ok, "genuine M2 proof must verify through the adapter");
    }

    function test_tamperedPublicSignal_failsVerification() public view {
        uint256[] memory tampered = pubSignals;
        tampered[6] = tampered[6] + 1; // corrupt tokenId (index 6: root, clearedRoot, 2 nullifiers, 2 newCommitments, tokenId)

        bytes memory proof = abi.encode(a, b, c);
        bool ok = adapter.verifyProof(proof, tampered);
        assertFalse(ok, "tampered public signals must not verify");
    }

    function test_wrongSignalCount_reverts() public {
        uint256[] memory tooFew = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) tooFew[i] = pubSignals[i];

        bytes memory proof = abi.encode(a, b, c);
        vm.expectRevert("JoinSplit2x2VerifierAdapter: expected 11 public signals");
        adapter.verifyProof(proof, tooFew);
    }
}
