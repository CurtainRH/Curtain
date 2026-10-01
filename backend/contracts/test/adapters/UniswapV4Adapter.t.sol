// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {UniswapV4Adapter} from "../../src/adapters/UniswapV4Adapter.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// The adapter against Uniswap's real v4 PoolManager (v4-core v4.0.0), alone and inside a
/// full CurtainVault settlement.
contract UniswapV4AdapterTest is Test {
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    PoolManager manager;
    UniswapV4Adapter adapter;
    MockERC20 usdg;
    MockERC20 nvda;
    PoolKey key;
    bool usdgIsToken0;

    function setUp() public {
        manager = new PoolManager(address(this));
        adapter = new UniswapV4Adapter(address(manager));
        usdg = new MockERC20("USD Global", "USDG");
        nvda = new MockERC20("NVIDIA", "NVDA");
        usdgIsToken0 = address(usdg) < address(nvda);
        (address c0, address c1) = usdgIsToken0 ? (address(usdg), address(nvda)) : (address(nvda), address(usdg));
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        manager.initialize(key, SQRT_PRICE_1_1);

        // Deep liquidity around price 1:1.
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        usdg.mint(address(this), 1e30);
        nvda.mint(address(this), 1e30);
        usdg.approve(address(lp), type(uint256).max);
        nvda.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity(key, IPoolManager.ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 1e24, salt: 0}), "");
    }

    function test_swapExactIn_sendsOutputToRecipient() public {
        address payer = address(0xA11CE);
        usdg.mint(payer, 1_000 ether);
        vm.startPrank(payer);
        usdg.approve(address(adapter), 1_000 ether);
        uint256 out = adapter.swapExactIn(key, usdgIsToken0, 1_000 ether, 990 ether, address(0xB0B));
        vm.stopPrank();

        assertGt(out, 990 ether, "about 1:1 minus the 0.30% fee and a little impact");
        assertEq(nvda.balanceOf(address(0xB0B)), out);
        assertEq(usdg.balanceOf(payer), 0);
        assertEq(usdg.balanceOf(address(adapter)), 0, "adapter keeps nothing");
        assertEq(nvda.balanceOf(address(adapter)), 0);
    }

    function test_swapExactIn_revertsBelowMinOut() public {
        usdg.mint(address(this), 1_000 ether);
        usdg.approve(address(adapter), 1_000 ether);
        vm.expectRevert();
        adapter.swapExactIn(key, usdgIsToken0, 1_000 ether, 1_000 ether, address(0xB0B)); // fee makes 1:1 impossible
    }

    function test_unlockCallback_onlyPoolManager() public {
        vm.expectRevert(UniswapV4Adapter.NotPoolManager.selector);
        adapter.unlockCallback("");
    }

    /// End to end: a CurtainVault settlement routed through the adapter.
    function test_vaultSettlementThroughV4() public {
        uint256 operatorKey = 0x0FE8A70;
        address operator = vm.addr(operatorKey);
        CurtainVault vault = new CurtainVault(address(this), operator, address(0x7EA5));
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(nvda), true);
        vault.setAllowedRouter(address(adapter), true);

        address alice = address(0xA11CE);
        usdg.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        usdg.approve(address(vault), 1_000 ether);
        uint256 id = vault.deposit(address(usdg), 1_000 ether, keccak256(abi.encode(uint256(1), bytes32("salt"))));
        vm.stopPrank();

        uint256 minOut = 980 ether;
        CurtainVault.Swap memory s = CurtainVault.Swap({
            router: address(adapter), tokenIn: address(usdg), amountIn: 1_000 ether, tokenOut: address(nvda), minOut: minOut,
            data: abi.encodeCall(UniswapV4Adapter.swapExactIn, (key, usdgIsToken0, 1_000 ether, minOut, address(vault)))
        });
        CurtainVault.Payout[] memory ps = new CurtainVault.Payout[](1);
        uint256 protocolFee = (minOut * 20) / 10_000;
        ps[0] = CurtainVault.Payout(address(0xB0B), minOut - protocolFee, protocolFee, 0, keccak256(abi.encode(id, bytes32("secret"))));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(operatorKey, vault.settlementDigest(s, ps, deadline, 1));

        vault.settle(s, ps, deadline, 1, abi.encodePacked(r, sg, v));

        assertEq(nvda.balanceOf(address(0xB0B)), minOut - protocolFee);
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(IERC20(address(usdg)).allowance(address(vault), address(adapter)), 0);
        assertGt(nvda.balanceOf(address(vault)), 0, "positive slippage above minOut stays in the vault");
    }
}
