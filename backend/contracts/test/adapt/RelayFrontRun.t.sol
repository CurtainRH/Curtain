// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {RelayAdapt} from "../../src/adapt/RelayAdapt.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";
import {BindingMockJoinSplitVerifier} from "../mocks/BindingMockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// Regression for the relay front-running theft found in the spec cross-check: before the fix,
/// anyone who saw a relay's proof could resubmit it with `usdg.transfer(attacker, amount)` as
/// the only call and walk off with the unshielded funds. The verifier here only accepts the
/// exact public signals the honest user proved, like a real Groth16 proof.
contract RelayFrontRunTest is Test {
    CurtainPool pool; RelayAdapt adapt; BindingMockJoinSplitVerifier v; MockERC20 usdg;
    address attacker = address(0xBAD);

    function setUp() public {
        address t3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address t5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();
        AssetGate ag = new AssetGate(address(this));
        v = new BindingMockJoinSplitVerifier();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        pool = new CurtainPool(t3, t5, address(ag), address(new MockScreeningGate()), address(v), address(v),
            address(new MockUnshieldVerifier()), predicted, address(0x7EA5), address(0) /* feeSource */, 20, address(0), address(0) /* guardian */);
        adapt = new RelayAdapt(address(pool), address(this));
        usdg = new MockERC20("USDG", "USDG");
        ag.register(address(usdg), false, address(0));
        adapt.setAllowedTarget(address(usdg), true);
        usdg.mint(address(this), 500 ether);
        usdg.approve(address(pool), type(uint256).max);
        pool.shield(address(usdg), 200 ether, 1, 1, "", "");
    }

    function test_frontRunnerCannotReuseRelayProof() public {
        CurtainPool.TransactArgs memory a;
        a.token = address(usdg); a.root = pool.currentRoot(); a.clearedRoot = pool.currentClearedRoot();
        a.nullifiers = new bytes32[](2); a.nullifiers[0] = bytes32(uint256(1)); a.nullifiers[1] = bytes32(uint256(2));
        a.newCommits = new bytes32[](2); a.newCommits[0] = bytes32(uint256(3)); a.newCommits[1] = bytes32(uint256(4));
        a.ephemeralPks = new bytes[](2); a.cts = new bytes[](2);
        a.unshieldTo = address(adapt); a.unshieldAmount = 50 ether;
        a.feeAmount = pool.protocolFeeFor(50 ether);

        // Honest relay: no calls, reshield the USDG back to the user's own note.
        RelayAdapt.ReshieldOutput[] memory honestOut = new RelayAdapt.ReshieldOutput[](1);
        honestOut[0] = RelayAdapt.ReshieldOutput(address(usdg), 111, 222, "", "", 0);
        a.extData = adapt.relayDataHash(new RelayAdapt.Call[](0), honestOut, address(this));

        // The honest proof is bound to exactly these public signals.
        v.lock(keccak256(abi.encode(_signals(a))));

        // Attacker keeps the proof but swaps in a transfer to themselves, and must also
        // rewrite extData to match (otherwise RelayAdapt rejects it outright)...
        RelayAdapt.Call[] memory calls = new RelayAdapt.Call[](1);
        calls[0] = RelayAdapt.Call(address(usdg), 0, abi.encodeCall(IERC20.transfer, (attacker, 50 ether)));
        a.extData = adapt.relayDataHash(calls, new RelayAdapt.ReshieldOutput[](0), attacker);

        // ...which changes extDataHash, so the stolen proof no longer verifies.
        vm.prank(attacker);
        vm.expectRevert(CurtainPool.InvalidProof.selector);
        adapt.relay(a, calls, new RelayAdapt.ReshieldOutput[](0), attacker);
        assertEq(usdg.balanceOf(attacker), 0);
    }

    function _signals(CurtainPool.TransactArgs memory a) internal view returns (uint256[] memory s) {
        s = new uint256[](11);
        s[0] = uint256(a.root); s[1] = uint256(a.clearedRoot);
        s[2] = uint256(a.nullifiers[0]); s[3] = uint256(a.nullifiers[1]);
        s[4] = uint256(a.newCommits[0]); s[5] = uint256(a.newCommits[1]);
        s[6] = pool.tokenIdOf(a.token); s[7] = a.unshieldAmount; s[8] = uint256(uint160(a.unshieldTo));
        s[9] = a.feeAmount;
        s[10] = pool.extDataHashFor(a.unshieldTo, a.unshieldAmount, a.feeAmount, a.feeRecipient, a.extData);
    }
}
