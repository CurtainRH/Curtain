// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDexRouter} from "../mocks/MockDexRouter.sol";
import {StealingRouter} from "../mocks/StealingRouter.sol";

/// Shared setup + helpers for the vault suites.
abstract contract VaultBase is Test {
    CurtainVault vault;
    MockERC20 usdg;
    MockERC20 nvda;
    MockDexRouter router;

    address admin = address(0xAD);
    uint256 operatorKey = 0x0FE8A70;
    address operator;
    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B); // alice's chosen recipient
    address keeper = address(0x6EE9);

    bytes32 constant SALT = keccak256("salt");
    bytes32 constant SECRET = keccak256("payout-secret");
    uint256 nonceCounter;

    function setUp() public virtual {
        vm.warp(1_000_000);
        operator = vm.addr(operatorKey);
        vault = new CurtainVault(admin, operator, treasury);
        usdg = new MockERC20("USD Global", "USDG");
        nvda = new MockERC20("NVIDIA", "NVDA");
        router = new MockDexRouter();
        router.setRate(address(usdg), address(nvda), 0.005e18); // 200 USDG per NVDA
        nvda.mint(address(router), 1_000 ether);

        vm.startPrank(admin);
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(nvda), true);
        vault.setAllowedRouter(address(router), true);
        vm.stopPrank();

        usdg.mint(alice, 10_000 ether);
        vm.prank(alice);
        usdg.approve(address(vault), type(uint256).max);
    }

    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp() + 1 hours;
    }

    function _deposit(uint256 amount, uint256 deadline) internal returns (uint256 id) {
        vm.prank(alice);
        id = vault.deposit(address(usdg), amount, keccak256(abi.encode(deadline, SALT)));
    }

    function _swap(uint256 amountIn, uint256 minOut) internal view returns (CurtainVault.Swap memory) {
        return CurtainVault.Swap({
            router: address(router), tokenIn: address(usdg), amountIn: amountIn, tokenOut: address(nvda), minOut: minOut,
            data: abi.encodeCall(MockDexRouter.swapExactIn, (address(usdg), address(nvda), amountIn, minOut))
        });
    }

    /// One payout of `gross` NVDA to bob for deposit `id`: 0.20% protocol fee, 0.05% keeper fee.
    function _payouts(uint256 id, uint256 gross) internal pure returns (CurtainVault.Payout[] memory ps) {
        ps = new CurtainVault.Payout[](1);
        uint256 protocolFee = (gross * 20) / 10_000;
        uint256 keeperFee = (gross * 5) / 10_000;
        ps[0] = CurtainVault.Payout({
            recipient: address(0xB0B), amount: gross - protocolFee - keeperFee, protocolFee: protocolFee, keeperFee: keeperFee,
            tag: keccak256(abi.encode(id, SECRET))
        });
    }

    function _sign(CurtainVault.Swap memory s, CurtainVault.Payout[] memory ps, uint256 deadline, uint256 nonce, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(key, vault.settlementDigest(s, ps, deadline, nonce));
        return abi.encodePacked(r, sg, v);
    }

    /// Signs and submits a settlement as `keeper`.
    function _settle(CurtainVault.Swap memory s, CurtainVault.Payout[] memory ps, uint256 deadline) internal returns (uint256 nonce) {
        nonce = ++nonceCounter;
        bytes memory sig = _sign(s, ps, deadline, nonce, operatorKey);
        vm.prank(keeper);
        vault.settle(s, ps, deadline, nonce, sig);
    }
}

contract CurtainVaultTest is VaultBase {
    // ---- deposit ----

    function test_deposit_recordsAndHidesSwapDetails() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);
        (address depositor, address token, uint256 amount, bytes32 dh,, CurtainVault.Status status) = vault.deposits(id);
        assertEq(depositor, alice);
        assertEq(token, address(usdg));
        assertEq(amount, 1_000 ether);
        assertEq(dh, keccak256(abi.encode(deadline, SALT)));
        assertEq(uint8(status), uint8(CurtainVault.Status.Active));
    }

    function test_deposit_rejectsUnlistedTokenZeroReusedHashAndPause() public {
        MockERC20 other = new MockERC20("X", "X");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.TokenNotAllowed.selector, address(other)));
        vault.deposit(address(other), 1, bytes32(uint256(1)));

        vm.prank(alice);
        vm.expectRevert(CurtainVault.ZeroAmount.selector);
        vault.deposit(address(usdg), 0, bytes32(uint256(1)));

        _deposit(1 ether, 123);
        vm.prank(alice);
        vm.expectRevert(CurtainVault.DeadlineHashReused.selector);
        vault.deposit(address(usdg), 1 ether, keccak256(abi.encode(uint256(123), SALT)));

        vm.prank(admin);
        vault.setDepositsPaused(true);
        vm.prank(alice);
        vm.expectRevert(CurtainVault.DepositsArePaused.selector);
        vault.deposit(address(usdg), 1 ether, bytes32(uint256(9)));
    }

    // ---- settlements ----

    function test_settle_swapsAndPaysAtomically_keeperEarnsFee() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        CurtainVault.Payout[] memory ps = _payouts(id, 5 ether);
        _settle(_swap(1_000 ether, 5 ether), ps, _deadline());

        assertEq(nvda.balanceOf(bob), ps[0].amount);
        assertEq(nvda.balanceOf(treasury), ps[0].protocolFee);
        assertEq(nvda.balanceOf(keeper), ps[0].keeperFee);
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(usdg.allowance(address(vault), address(router)), 0, "approval must be reset");
        assertTrue(vault.tagUsed(ps[0].tag));
    }

    function test_settle_sameTokenPrivateTransferSkipsSwap() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        CurtainVault.Swap memory s = CurtainVault.Swap(address(0), address(usdg), 1_000 ether, address(usdg), 0, "");
        CurtainVault.Payout[] memory ps = _payouts(id, 1_000 ether);
        _settle(s, ps, _deadline());
        assertEq(usdg.balanceOf(bob), ps[0].amount);
    }

    function test_settle_rejectsTamperingReplayExpiryAndWrongSigner() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        CurtainVault.Swap memory s = _swap(1_000 ether, 5 ether);
        CurtainVault.Payout[] memory ps = _payouts(id, 5 ether);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(s, ps, deadline, 1, operatorKey);

        CurtainVault.Payout[] memory redirected = _payouts(id, 5 ether);
        redirected[0].recipient = keeper;
        vm.expectRevert(CurtainVault.BadSignature.selector);
        vault.settle(s, redirected, deadline, 1, sig);

        bytes memory wrongSig = _sign(s, ps, deadline, 1, 0xBADBAD);
        vm.expectRevert(CurtainVault.BadSignature.selector);
        vault.settle(s, ps, deadline, 1, wrongSig);

        vault.settle(s, ps, deadline, 1, sig);
        vm.expectRevert(CurtainVault.NonceUsed.selector);
        vault.settle(s, ps, deadline, 1, sig);

        bytes memory lateSig = _sign(s, ps, deadline, 2, operatorKey);
        vm.warp(deadline + 1);
        vm.expectRevert(CurtainVault.SettlementExpired.selector);
        vault.settle(s, ps, deadline, 2, lateSig);
    }

    function test_settle_revertsIfSwapOutputGoesElsewhere() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        StealingRouter thief = new StealingRouter();
        nvda.mint(address(thief), 10 ether);
        vm.prank(admin);
        vault.setAllowedRouter(address(thief), true);
        CurtainVault.Swap memory s = CurtainVault.Swap({
            router: address(thief), tokenIn: address(usdg), amountIn: 1_000 ether, tokenOut: address(nvda), minOut: 4 ether,
            data: abi.encodeCall(StealingRouter.swapTo, (address(usdg), address(nvda), 1_000 ether, 5 ether, address(0xBAD)))
        });
        CurtainVault.Payout[] memory ps = _payouts(id, 4 ether);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(s, ps, deadline, 1, operatorKey);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.InsufficientOutput.selector, 0, 4 ether));
        vault.settle(s, ps, deadline, 1, sig);
    }

    function test_settle_routerCannotPullMoreThanAmountIn() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        StealingRouter thief = new StealingRouter();
        vm.prank(admin);
        vault.setAllowedRouter(address(thief), true);
        CurtainVault.Swap memory s = CurtainVault.Swap({
            router: address(thief), tokenIn: address(usdg), amountIn: 10 ether, tokenOut: address(nvda), minOut: 1,
            data: abi.encodeCall(StealingRouter.overpull, (address(usdg), 1_000 ether))
        });
        CurtainVault.Payout[] memory ps = _payouts(id, 1);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(s, ps, deadline, 1, operatorKey);
        vm.expectRevert(CurtainVault.SwapCallFailed.selector);
        vault.settle(s, ps, deadline, 1, sig);
    }

    function test_settle_cannotPayMoreThanItsSwapProduced() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        nvda.mint(address(vault), 100 ether); // other users' NVDA sitting in the pool
        CurtainVault.Swap memory s = _swap(1_000 ether, 5 ether);
        CurtainVault.Payout[] memory ps = _payouts(id, 50 ether); // pays 10x the swap output
        uint256 deadline = _deadline();
        bytes memory sig = _sign(s, ps, deadline, 1, operatorKey);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.PaysMoreThanSwapped.selector, 50 ether, 5 ether));
        vault.settle(s, ps, deadline, 1, sig);
    }

    function test_tagDoesNotRevealDeposit() public view {
        bytes32 tag = keccak256(abi.encode(uint256(1), SECRET));
        assertTrue(tag != keccak256(abi.encode(uint256(1))), "tag must depend on a secret");
        assertEq(vault.tagFor(1, SECRET), tag);
    }

    // ---- escape hatch ----

    function test_refund_afterDeadlinePlusDelayWhenUnpaid() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);

        vm.warp(deadline + 3 minutes - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.TooEarly.selector, deadline + 3 minutes));
        vault.requestRefund(id, deadline, SALT);

        vm.warp(deadline + 3 minutes);
        vm.prank(alice);
        vault.requestRefund(id, deadline, SALT);

        vm.expectPartialRevert(CurtainVault.TooEarly.selector);
        vault.finalizeRefund(id);

        vm.warp(vm.getBlockTimestamp() + 10 minutes + 1);
        vault.finalizeRefund(id);
        assertEq(usdg.balanceOf(alice), 10_000 ether);

        vm.expectRevert(abi.encodeWithSelector(CurtainVault.WrongStatus.selector, CurtainVault.Status.Refunded));
        vault.finalizeRefund(id);
    }

    function test_refund_requiresDepositorAndCorrectHiddenDeadline() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);
        vm.warp(deadline + 1 days);

        vm.prank(bob);
        vm.expectRevert(CurtainVault.NotDepositor.selector);
        vault.requestRefund(id, deadline, SALT);

        vm.prank(alice);
        vm.expectRevert(CurtainVault.WrongDeadline.selector);
        vault.requestRefund(id, deadline - 1 hours, SALT);
    }

    function test_refund_challengedWhenAlreadyPaid() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);
        _settle(_swap(1_000 ether, 5 ether), _payouts(id, 5 ether), deadline);
        usdg.mint(address(vault), 1_000 ether); // so a successful double-dip would be payable

        vm.warp(deadline + 3 minutes);
        vm.prank(alice);
        vault.requestRefund(id, deadline, SALT);

        vm.expectRevert(CurtainVault.NotPaid.selector);
        vault.challengeRefund(id, keccak256("wrong secret"));

        vm.prank(keeper);
        vault.challengeRefund(id, SECRET);

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.WrongStatus.selector, CurtainVault.Status.Settled));
        vault.finalizeRefund(id);
        assertEq(usdg.balanceOf(alice), 9_000 ether);
    }

    function test_refund_challengeWindowCloses() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);
        _settle(_swap(1_000 ether, 5 ether), _payouts(id, 5 ether), deadline);
        usdg.mint(address(vault), 1_000 ether);

        vm.warp(deadline + 3 minutes);
        vm.prank(alice);
        vault.requestRefund(id, deadline, SALT);
        vm.warp(vm.getBlockTimestamp() + 10 minutes + 1);
        vm.expectRevert(CurtainVault.ChallengeClosed.selector);
        vault.challengeRefund(id, SECRET);
    }

    // ---- admin ----

    function test_admin_onlyOwnerFeeCapAndTwoStepTransfer() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setOperator(address(1));

        vm.prank(admin);
        vm.expectRevert(CurtainVault.FeeTooHigh.selector);
        vault.setFeeBps(101);

        vm.prank(admin);
        vault.transferOwnership(address(0x1234));
        assertEq(vault.owner(), admin, "ownership moves only once accepted");
        vm.prank(address(0x1234));
        vault.acceptOwnership();
        assertEq(vault.owner(), address(0x1234));
    }

    function test_admin_rotatingOperatorInvalidatesOldSignatures() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        CurtainVault.Swap memory s = _swap(1_000 ether, 5 ether);
        CurtainVault.Payout[] memory ps = _payouts(id, 5 ether);
        uint256 deadline = _deadline();
        bytes memory sig = _sign(s, ps, deadline, 1, operatorKey);
        vm.prank(admin);
        vault.setOperator(address(0x1234));
        vm.expectRevert(CurtainVault.BadSignature.selector);
        vault.settle(s, ps, deadline, 1, sig);
    }
}
