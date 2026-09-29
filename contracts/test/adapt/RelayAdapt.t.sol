// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {RelayAdapt} from "../../src/adapt/RelayAdapt.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDexRouter} from "../mocks/MockDexRouter.sol";

/// @notice M6 acceptance: "Atomicity tests; buy NVDA into shield in one tx
/// on testnet." Uses MockJoinSplitVerifier (like CurtainPool.t.sol) since
/// this suite tests RelayAdapt's OWN mechanics (target allowlisting,
/// unshield->swap->reshield wiring, no-residue enforcement) — real
/// join-split cryptography is already covered by
/// JoinSplitVerifierAdapter.t.sol and the M5 wallet e2e test. MockDexRouter
/// stands in for Uniswap V3/V4 — see its header and Curtain_Build.md §11
/// for why (no mainnet-fork RPC in this environment).
contract RelayAdaptTest is Test {
    uint16 internal constant FEE_BPS = 20;

    CurtainPool internal pool;
    RelayAdapt internal relayAdapt;
    AssetGate internal assetGate;
    MockScreeningGate internal screeningGate;
    MockJoinSplitVerifier internal verifier2x2;
    MockDexRouter internal router;
    MockERC20 internal usdg;
    MockERC20 internal nvda;

    address internal treasury = address(0x7EA5);
    address internal alice = address(0xA11CE);
    address internal relayer = address(0xBEEF); // anyone can submit a relay — not alice, not owner

    function setUp() public {
        address hasherT3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address hasherT5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();

        assetGate = new AssetGate(address(this));
        screeningGate = new MockScreeningGate();
        verifier2x2 = new MockJoinSplitVerifier();
        MockJoinSplitVerifier verifier3x3 = new MockJoinSplitVerifier();
        MockUnshieldVerifier unshieldVerifier = new MockUnshieldVerifier();

        // Deterministic mutual-address wiring — see CurtainPool.sol's header
        // ("RELAYADAPT / reshield"). CurtainPool is deployed at the CURRENT
        // nonce; RelayAdapt is deployed immediately after, at nonce+1. We
        // predict that address now so it can be baked into CurtainPool's
        // constructor before RelayAdapt itself exists.
        uint64 nonceBeforePool = vm.getNonce(address(this));
        address predictedRelayAdapt = vm.computeCreateAddress(address(this), nonceBeforePool + 1);

        pool = new CurtainPool(
            hasherT3, hasherT5, address(assetGate), address(screeningGate),
            address(verifier2x2), address(verifier3x3), address(unshieldVerifier),
            predictedRelayAdapt, treasury, FEE_BPS, FEE_BPS
        );
        relayAdapt = new RelayAdapt(address(pool), address(this));
        assertEq(address(relayAdapt), predictedRelayAdapt, "RelayAdapt landed at an unpredicted address");
        assertEq(pool.relayAdapt(), address(relayAdapt));

        usdg = new MockERC20("USD Global", "USDG");
        nvda = new MockERC20("NVDA Stock Token", "NVDA");
        assetGate.register(address(usdg), false, address(0));
        assetGate.register(address(nvda), false, address(0));

        router = new MockDexRouter();
        router.setRate(address(usdg), address(nvda), 2e18); // 1 USDG -> 2 NVDA, arbitrary fixed test rate
        nvda.mint(address(router), 1_000 ether); // router liquidity

        relayAdapt.setAllowedTarget(address(router), true);
        relayAdapt.setAllowedTarget(address(usdg), true); // needed to call approve() on it via the generic Call mechanism

        usdg.mint(alice, 1_000 ether);
        vm.prank(alice);
        usdg.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        pool.shield(address(usdg), 200 ether, 1, 1, hex"", hex""); // establishes a known root + gives the pool USDG to unshield
    }

    function _unshieldArgs(uint256 amount) internal view returns (CurtainPool.TransactArgs memory args) {
        args.proof = hex""; // MockJoinSplitVerifier ignores this
        args.token = address(usdg);
        args.root = pool.currentRoot();
        args.clearedRoot = pool.currentClearedRoot();
        args.nullifiers = new bytes32[](2);
        args.nullifiers[0] = bytes32(uint256(1));
        args.nullifiers[1] = bytes32(uint256(2));
        args.newCommits = new bytes32[](2);
        args.newCommits[0] = bytes32(uint256(3));
        args.newCommits[1] = bytes32(uint256(4));
        args.ephemeralPks = new bytes[](2);
        args.cts = new bytes[](2);
        args.unshieldTo = address(relayAdapt);
        args.unshieldAmount = amount;
        args.feeAmount = 0;
    }

    function _swapCall(uint256 amountIn, uint256 minOut) internal view returns (RelayAdapt.Call[] memory calls) {
        calls = new RelayAdapt.Call[](2);
        calls[0] = RelayAdapt.Call({
            to: address(usdg), value: 0,
            data: abi.encodeCall(IERC20.approve, (address(router), amountIn))
        });
        calls[1] = RelayAdapt.Call({
            to: address(router), value: 0,
            data: abi.encodeCall(MockDexRouter.swapExactIn, (address(usdg), address(nvda), amountIn, minOut))
        });
    }

    function test_relay_buyAndShield_atomicUnshieldSwapReshield() public {
        uint256 amountIn = 50 ether;
        uint256 expectedOut = 100 ether; // 2x rate

        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(nvda), ownerPkX: 111, blinding: 222,
            ephemeralPk: hex"01", ct: hex"02", minOut: expectedOut
        });

        uint256 poolNvdaBalBefore = nvda.balanceOf(address(pool));

        vm.prank(relayer); // permissionless — not alice, not the RelayAdapt owner
        relayAdapt.relay(_unshieldArgs(amountIn), _swapCall(amountIn, expectedOut), outputs, alice);

        assertEq(nvda.balanceOf(address(pool)), poolNvdaBalBefore + expectedOut, "pool did not receive the reshielded NVDA");
        assertEq(usdg.balanceOf(address(relayAdapt)), 0, "USDG residue left in RelayAdapt");
        assertEq(nvda.balanceOf(address(relayAdapt)), 0, "NVDA residue left in RelayAdapt");

        bytes32 commit = bytes32(pool.commitHasher().poseidon(
            [pool.tokenIdOf(address(nvda)), expectedOut, uint256(111), uint256(222)]
        ));
        assertEq(pool.originOf(commit), alice, "reshielded note's origin must be the relay's declared origin, not RelayAdapt");
        assertTrue(pool.clearedTreeMember(commit), "reshielded note must skip standby (inherit cleared status)");
    }

    function test_relay_revertsForDisallowedTarget() public {
        RelayAdapt.Call[] memory calls = new RelayAdapt.Call[](1);
        calls[0] = RelayAdapt.Call({to: address(0xDEAD), value: 0, data: ""});
        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](0);
        // Precompute args before expectRevert — _unshieldArgs()'s internal
        // pool.currentRoot() view call would otherwise be "the next call"
        // expectRevert actually checks, not relay() itself.
        CurtainPool.TransactArgs memory args = _unshieldArgs(10 ether);

        vm.expectRevert(abi.encodeWithSelector(RelayAdapt.TargetNotAllowed.selector, address(0xDEAD)));
        relayAdapt.relay(args, calls, outputs, alice);
    }

    function test_relay_revertsWhenOutputBelowMinOut() public {
        uint256 amountIn = 50 ether;
        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(nvda), ownerPkX: 1, blinding: 1,
            ephemeralPk: hex"", ct: hex"", minOut: 999 ether // far above the real 100 ether output
        });
        CurtainPool.TransactArgs memory args = _unshieldArgs(amountIn);
        RelayAdapt.Call[] memory calls = _swapCall(amountIn, 0);

        vm.expectRevert(abi.encodeWithSelector(RelayAdapt.InsufficientOutput.selector, address(nvda), 100 ether, 999 ether));
        relayAdapt.relay(args, calls, outputs, alice);
    }

    function test_relay_revertsOnLeftoverInputResidue() public {
        uint256 amountIn = 50 ether;
        uint256 amountActuallySwapped = 30 ether; // leaves 20 ether of USDG stuck in RelayAdapt
        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(nvda), ownerPkX: 1, blinding: 1,
            ephemeralPk: hex"", ct: hex"", minOut: 0
        });
        CurtainPool.TransactArgs memory args = _unshieldArgs(amountIn);
        RelayAdapt.Call[] memory calls = _swapCall(amountActuallySwapped, 0);

        vm.expectRevert(abi.encodeWithSelector(RelayAdapt.Residue.selector, address(usdg), 20 ether));
        relayAdapt.relay(args, calls, outputs, alice);
    }

    function test_setAllowedTarget_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        relayAdapt.setAllowedTarget(address(router), false);
    }

    function test_relay_revertsIfUnshieldToIsNotRelayAdapt() public {
        CurtainPool.TransactArgs memory args = _unshieldArgs(10 ether);
        args.unshieldTo = alice; // wrong — must be address(relayAdapt)
        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](0);

        vm.expectRevert(RelayAdapt.UnshieldMustTargetThis.selector);
        relayAdapt.relay(args, new RelayAdapt.Call[](0), outputs, alice);
    }
}
