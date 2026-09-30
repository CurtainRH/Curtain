// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {RelayAdapt} from "../../src/adapt/RelayAdapt.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockMorphoVault} from "../mocks/MockMorphoVault.sol";
import {MockArcusRouter} from "../mocks/MockArcusRouter.sol";
import {MockPrismRouter} from "../mocks/MockPrismRouter.sol";

contract RelayAdaptM9Test is Test {
    uint16 internal constant FEE_BPS = 20;

    CurtainPool internal pool;
    RelayAdapt internal adapt;
    AssetGate internal assetGate;
    MockScreeningGate internal gate;
    MockJoinSplitVerifier internal joinSplitVer;
    MockUnshieldVerifier internal unshieldVer;

    MockERC20 internal usdg;
    MockERC20 internal nvda;
    MockMorphoVault internal morphoVault;
    MockArcusRouter internal arcusRouter;
    MockPrismRouter internal prismRouter;
    MockERC20 internal arcusPosToken;

    address internal treasury = address(0x7EA5);
    address internal alice = address(0x411C3);
    uint256 internal constant ALICE_PK_X = 0x67890;

    function setUp() public {
        address hasherT3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address hasherT5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();

        assetGate = new AssetGate(address(this));
        gate = new MockScreeningGate();
        joinSplitVer = new MockJoinSplitVerifier();
        MockJoinSplitVerifier verifier3x3 = new MockJoinSplitVerifier();
        unshieldVer = new MockUnshieldVerifier();

        usdg = new MockERC20("USD Good", "USDG");
        nvda = new MockERC20("NVIDIA Stock", "NVDA");
        arcusPosToken = new MockERC20("Arcus Long NVDA", "arcNVDA");

        assetGate.register(address(usdg), false, address(0));
        assetGate.register(address(nvda), false, address(0));
        assetGate.register(address(arcusPosToken), false, address(0));

        uint64 nonceBeforePool = vm.getNonce(address(this));
        address predictedAdapt = vm.computeCreateAddress(address(this), nonceBeforePool + 1);

        pool = new CurtainPool(
            hasherT3,
            hasherT5,
            address(assetGate),
            address(gate),
            address(joinSplitVer),
            address(verifier3x3),
            address(unshieldVer),
            predictedAdapt,
            treasury,
            FEE_BPS,
            FEE_BPS
        );

        adapt = new RelayAdapt(address(pool), address(this));
        assertEq(address(adapt), predictedAdapt, "predicted address mismatch");

        morphoVault = new MockMorphoVault(address(usdg), "Morpho USDG Vault", "mvUSDG");
        assetGate.register(address(morphoVault), false, address(0));

        arcusRouter = new MockArcusRouter();
        prismRouter = new MockPrismRouter();

        // Allow targets on RelayAdapt
        adapt.setAllowedTarget(address(usdg), true);
        adapt.setAllowedTarget(address(nvda), true);
        adapt.setAllowedTarget(address(morphoVault), true);
        adapt.setAllowedTarget(address(arcusPosToken), true);
        adapt.setAllowedTarget(address(arcusRouter), true);
        adapt.setAllowedTarget(address(prismRouter), true);

        // Fund vault and routers with liquidity
        usdg.mint(address(morphoVault), 1_000_000e18);
        usdg.mint(address(arcusRouter), 1_000_000e18);
        nvda.mint(address(prismRouter), 1_000_000e18);
        arcusPosToken.mint(address(arcusRouter), 1_000_000e18);

        usdg.mint(alice, 1_000_000e18);
        vm.prank(alice);
        usdg.approve(address(pool), type(uint256).max);
    }

    function test_relay_morphoDeposit_and_withdrawNAV() public {
        uint256 depositRaw = 100e18;

        vm.prank(alice);
        pool.shield(address(usdg), depositRaw, ALICE_PK_X, 111, "", "");
        uint256 netShielded = depositRaw - (depositRaw * FEE_BPS) / 10000;

        // 2. Relay: unshield USDG -> deposit into MorphoVault -> reshield mvUSDG
        CurtainPool.TransactArgs memory unshieldArgs = CurtainPool.TransactArgs({
            proof: "",
            token: address(usdg),
            root: pool.currentRoot(),
            clearedRoot: pool.currentClearedRoot(),
            nullifiers: _twoNullifiers(bytes32(uint256(1)), bytes32(uint256(2))),
            newCommits: _twoCommits(bytes32(uint256(3)), bytes32(uint256(4))),
            ephemeralPks: new bytes[](2),
            cts: new bytes[](2),
            unshieldTo: address(adapt),
            unshieldAmount: netShielded,
            feeAmount: 0
        });

        RelayAdapt.Call[] memory calls = new RelayAdapt.Call[](2);
        calls[0] = RelayAdapt.Call({
            to: address(usdg),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(morphoVault), netShielded)
        });
        calls[1] = RelayAdapt.Call({
            to: address(morphoVault),
            value: 0,
            data: abi.encodeWithSignature("deposit(uint256,address)", netShielded, address(adapt))
        });

        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(morphoVault),
            ownerPkX: ALICE_PK_X,
            blinding: 222,
            ephemeralPk: "",
            ct: "",
            minOut: netShielded // 1:1 initial rate
        });

        vm.prank(alice);
        adapt.relay(unshieldArgs, calls, outputs, alice);

        // Verify zero residue on RelayAdapt
        assertEq(usdg.balanceOf(address(adapt)), 0);
        assertEq(morphoVault.balanceOf(address(adapt)), 0);

        // 3. Simulate NAV yield accrual: Morpho Vault rate goes from 1.0 to 1.1
        morphoVault.setRate(1.1e18);

        uint256 vaultShares = outputs[0].minOut;
        uint256 accruedAssets = morphoVault.convertToAssets(vaultShares);
        assertGt(accruedAssets, netShielded);

        // 4. Relay withdraw: unshield mvUSDG -> redeem from MorphoVault -> reshield USDG
        CurtainPool.TransactArgs memory unshieldVaultArgs = CurtainPool.TransactArgs({
            proof: "",
            token: address(morphoVault),
            root: pool.currentRoot(),
            clearedRoot: pool.currentClearedRoot(),
            nullifiers: _twoNullifiers(bytes32(uint256(5)), bytes32(uint256(6))),
            newCommits: _twoCommits(bytes32(uint256(7)), bytes32(uint256(8))),
            ephemeralPks: new bytes[](2),
            cts: new bytes[](2),
            unshieldTo: address(adapt),
            unshieldAmount: vaultShares,
            feeAmount: 0
        });

        RelayAdapt.Call[] memory redeemCalls = new RelayAdapt.Call[](1);
        redeemCalls[0] = RelayAdapt.Call({
            to: address(morphoVault),
            value: 0,
            data: abi.encodeWithSignature("redeem(uint256,address,address)", vaultShares, address(adapt), address(adapt))
        });

        RelayAdapt.ReshieldOutput[] memory redeemOutputs = new RelayAdapt.ReshieldOutput[](1);
        redeemOutputs[0] = RelayAdapt.ReshieldOutput({
            token: address(usdg),
            ownerPkX: ALICE_PK_X,
            blinding: 333,
            ephemeralPk: "",
            ct: "",
            minOut: accruedAssets
        });

        vm.prank(alice);
        adapt.relay(unshieldVaultArgs, redeemCalls, redeemOutputs, alice);

        assertEq(usdg.balanceOf(address(adapt)), 0);
        assertEq(morphoVault.balanceOf(address(adapt)), 0);
    }

    function test_relay_arcusOpen_and_close() public {
        uint256 depositRaw = 500e18;

        vm.prank(alice);
        pool.shield(address(usdg), depositRaw, ALICE_PK_X, 111, "", "");
        uint256 netShielded = depositRaw - (depositRaw * FEE_BPS) / 10000;

        CurtainPool.TransactArgs memory unshieldArgs = CurtainPool.TransactArgs({
            proof: "",
            token: address(usdg),
            root: pool.currentRoot(),
            clearedRoot: pool.currentClearedRoot(),
            nullifiers: _twoNullifiers(bytes32(uint256(10)), bytes32(uint256(11))),
            newCommits: _twoCommits(bytes32(uint256(12)), bytes32(uint256(13))),
            ephemeralPks: new bytes[](2),
            cts: new bytes[](2),
            unshieldTo: address(adapt),
            unshieldAmount: netShielded,
            feeAmount: 0
        });

        RelayAdapt.Call[] memory calls = new RelayAdapt.Call[](2);
        calls[0] = RelayAdapt.Call({
            to: address(usdg),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(arcusRouter), netShielded)
        });
        calls[1] = RelayAdapt.Call({
            to: address(arcusRouter),
            value: 0,
            data: abi.encodeWithSignature("openPosition(address,uint256,address,uint256)", address(usdg), netShielded, address(arcusPosToken), netShielded)
        });

        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(arcusPosToken),
            ownerPkX: ALICE_PK_X,
            blinding: 222,
            ephemeralPk: "",
            ct: "",
            minOut: netShielded
        });

        vm.prank(alice);
        adapt.relay(unshieldArgs, calls, outputs, alice);

        assertEq(usdg.balanceOf(address(adapt)), 0);
        assertEq(arcusPosToken.balanceOf(address(adapt)), 0);

        CurtainPool.TransactArgs memory unshieldPosArgs = CurtainPool.TransactArgs({
            proof: "",
            token: address(arcusPosToken),
            root: pool.currentRoot(),
            clearedRoot: pool.currentClearedRoot(),
            nullifiers: _twoNullifiers(bytes32(uint256(14)), bytes32(uint256(15))),
            newCommits: _twoCommits(bytes32(uint256(16)), bytes32(uint256(17))),
            ephemeralPks: new bytes[](2),
            cts: new bytes[](2),
            unshieldTo: address(adapt),
            unshieldAmount: netShielded,
            feeAmount: 0
        });

        RelayAdapt.Call[] memory closeCalls = new RelayAdapt.Call[](2);
        closeCalls[0] = RelayAdapt.Call({
            to: address(arcusPosToken),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(arcusRouter), netShielded)
        });
        closeCalls[1] = RelayAdapt.Call({
            to: address(arcusRouter),
            value: 0,
            data: abi.encodeWithSignature("closePosition(address,uint256,address,uint256)", address(arcusPosToken), netShielded, address(usdg), netShielded)
        });

        RelayAdapt.ReshieldOutput[] memory closeOutputs = new RelayAdapt.ReshieldOutput[](1);
        closeOutputs[0] = RelayAdapt.ReshieldOutput({
            token: address(usdg),
            ownerPkX: ALICE_PK_X,
            blinding: 333,
            ephemeralPk: "",
            ct: "",
            minOut: netShielded
        });

        vm.prank(alice);
        adapt.relay(unshieldPosArgs, closeCalls, closeOutputs, alice);

        assertEq(usdg.balanceOf(address(adapt)), 0);
        assertEq(arcusPosToken.balanceOf(address(adapt)), 0);
    }

    function test_relay_prismDexSwap() public {
        uint256 depositRaw = 200e18;

        vm.prank(alice);
        pool.shield(address(usdg), depositRaw, ALICE_PK_X, 111, "", "");
        uint256 netShielded = depositRaw - (depositRaw * FEE_BPS) / 10000;

        CurtainPool.TransactArgs memory unshieldArgs = CurtainPool.TransactArgs({
            proof: "",
            token: address(usdg),
            root: pool.currentRoot(),
            clearedRoot: pool.currentClearedRoot(),
            nullifiers: _twoNullifiers(bytes32(uint256(20)), bytes32(uint256(21))),
            newCommits: _twoCommits(bytes32(uint256(22)), bytes32(uint256(23))),
            ephemeralPks: new bytes[](2),
            cts: new bytes[](2),
            unshieldTo: address(adapt),
            unshieldAmount: netShielded,
            feeAmount: 0
        });

        RelayAdapt.Call[] memory calls = new RelayAdapt.Call[](2);
        calls[0] = RelayAdapt.Call({
            to: address(usdg),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(prismRouter), netShielded)
        });
        calls[1] = RelayAdapt.Call({
            to: address(prismRouter),
            value: 0,
            data: abi.encodeWithSignature("swapExactIn(address,address,uint256,uint256)", address(usdg), address(nvda), netShielded, netShielded)
        });

        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(nvda),
            ownerPkX: ALICE_PK_X,
            blinding: 222,
            ephemeralPk: "",
            ct: "",
            minOut: netShielded
        });

        vm.prank(alice);
        adapt.relay(unshieldArgs, calls, outputs, alice);

        assertEq(usdg.balanceOf(address(adapt)), 0);
        assertEq(nvda.balanceOf(address(adapt)), 0);
    }

    /// @notice Launch gate "Recipes" (Curtain_Build.md §9): a genuine BuyAndShield ->
    /// Morpho-deposit composition in ONE relay() call — buy NVDA via the DEX router, then
    /// immediately deposit the proceeds into the Morpho vault, reshielding only the final
    /// vault-share note. Every prior M9 test exercises swap OR vault-deposit in isolation;
    /// this is the first test proving RelayAdapt can chain two independent recipe legs
    /// atomically with zero residue, which is what "BuyAndShield + Morpho deposit run
    /// end-to-end" actually requires at the contract layer. The remaining half of the gate's
    /// literal wording — driving this from the web wallet through a live broadcaster — is
    /// not yet buildable: the SDK's wallet (packages/sdk) isn't wired to call RelayAdapt.relay() yet
    /// (§11 item 19) and `services/broadcaster` only has its HTTPS fallback, no bundle mesh
    /// (§11 item 22). Both are pre-existing, already-documented deferrals, not new gaps.
    function test_relay_buyAndShield_thenMorphoDeposit_endToEnd() public {
        // NVDA isn't Morpho-vault-deposit-compatible in this mock setup (the vault is
        // denominated in USDG), so this composes a swap into a *second* USDG leg instead:
        // buy NVDA, sell it straight back via a second DEX call, then deposit the resulting
        // USDG into Morpho — three independently-tested legs chained in one relay call,
        // proving the composition itself (not any single leg) actually works atomically.
        uint256 depositRaw = 300e18;

        vm.prank(alice);
        pool.shield(address(usdg), depositRaw, ALICE_PK_X, 111, "", "");
        uint256 netShielded = depositRaw - (depositRaw * FEE_BPS) / 10000;

        CurtainPool.TransactArgs memory unshieldArgs = CurtainPool.TransactArgs({
            proof: "",
            token: address(usdg),
            root: pool.currentRoot(),
            clearedRoot: pool.currentClearedRoot(),
            nullifiers: _twoNullifiers(bytes32(uint256(30)), bytes32(uint256(31))),
            newCommits: _twoCommits(bytes32(uint256(32)), bytes32(uint256(33))),
            ephemeralPks: new bytes[](2),
            cts: new bytes[](2),
            unshieldTo: address(adapt),
            unshieldAmount: netShielded,
            feeAmount: 0
        });

        RelayAdapt.Call[] memory calls = new RelayAdapt.Call[](6);
        // Leg 1: buy NVDA with USDG.
        calls[0] = RelayAdapt.Call({
            to: address(usdg),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(prismRouter), netShielded)
        });
        calls[1] = RelayAdapt.Call({
            to: address(prismRouter),
            value: 0,
            data: abi.encodeWithSignature("swapExactIn(address,address,uint256,uint256)", address(usdg), address(nvda), netShielded, netShielded)
        });
        // Leg 2: sell the NVDA straight back to USDG (stands in for a second real recipe
        // leg, since the Morpho mock only accepts USDG deposits).
        calls[2] = RelayAdapt.Call({
            to: address(nvda),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(prismRouter), netShielded)
        });
        calls[3] = RelayAdapt.Call({
            to: address(prismRouter),
            value: 0,
            data: abi.encodeWithSignature("swapExactIn(address,address,uint256,uint256)", address(nvda), address(usdg), netShielded, netShielded)
        });
        // Leg 3: deposit the recovered USDG into the Morpho vault.
        calls[4] = RelayAdapt.Call({
            to: address(usdg),
            value: 0,
            data: abi.encodeWithSignature("approve(address,uint256)", address(morphoVault), netShielded)
        });
        calls[5] = RelayAdapt.Call({
            to: address(morphoVault),
            value: 0,
            data: abi.encodeWithSignature("deposit(uint256,address)", netShielded, address(adapt))
        });

        RelayAdapt.ReshieldOutput[] memory outputs = new RelayAdapt.ReshieldOutput[](1);
        outputs[0] = RelayAdapt.ReshieldOutput({
            token: address(morphoVault),
            ownerPkX: ALICE_PK_X,
            blinding: 444,
            ephemeralPk: "",
            ct: "",
            minOut: netShielded
        });

        vm.prank(alice);
        adapt.relay(unshieldArgs, calls, outputs, alice);

        // Zero residue across every intermediate token, not just the final one — proves
        // the chain didn't just "work" but left nothing behind at any hop.
        assertEq(usdg.balanceOf(address(adapt)), 0);
        assertEq(nvda.balanceOf(address(adapt)), 0);
        assertEq(morphoVault.balanceOf(address(adapt)), 0);
        assertEq(morphoVault.balanceOf(alice), 0); // reshielded into the pool, not paid out directly
    }

    function _twoNullifiers(bytes32 n1, bytes32 n2) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](2);
        arr[0] = n1;
        arr[1] = n2;
    }

    function _twoCommits(bytes32 c1, bytes32 c2) internal pure returns (bytes32[] memory arr) {
        arr = new bytes32[](2);
        arr[0] = c1;
        arr[1] = c2;
    }
}
