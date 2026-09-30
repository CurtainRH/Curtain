// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDexRouter} from "../mocks/MockDexRouter.sol";
import {StealingRouter} from "../mocks/StealingRouter.sol";

contract CurtainVaultTest is Test {
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

    uint256 constant DEADLINE_OFFSET = 1 hours;
    bytes32 constant SALT = keccak256("salt");
    bytes32 constant SECRET = keccak256("payout-secret");

    function setUp() public {
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

    // ---- helpers ----

    function _deadline() internal view returns (uint256) {
        return vm.getBlockTimestamp() + DEADLINE_OFFSET;
    }

    function _deposit(uint256 amount, uint256 deadline) internal returns (uint256 id) {
        vm.prank(alice);
        id = vault.deposit(address(usdg), amount, keccak256(abi.encode(deadline, SALT)));
    }

    function _swapUsdgToNvda(uint256 amountIn) internal returns (uint256 out) {
        bytes memory data = abi.encodeCall(MockDexRouter.swapExactIn, (address(usdg), address(nvda), amountIn, 1));
        vm.prank(operator);
        out = vault.executeSwap(address(router), address(usdg), amountIn, address(nvda), 1, data);
    }

    function _payout(uint256 depositId, uint256 amount, uint256 nonce) internal view returns (CurtainVault.Payout memory p) {
        p = CurtainVault.Payout({
            recipient: bob,
            token: address(nvda),
            amount: amount,
            protocolFee: amount / 500, // 0.20%
            keeperFee: 0.001 ether,
            deadline: vm.getBlockTimestamp() + 1 hours,
            nonce: nonce,
            tag: keccak256(abi.encode(depositId, SECRET))
        });
    }

    function _sign(CurtainVault.Payout memory p, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.payoutDigest(p));
        return abi.encodePacked(r, s, v);
    }

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
        assertEq(usdg.balanceOf(address(vault)), 1_000 ether);
    }

    function test_deposit_rejectsUnlistedTokenZeroAndReusedHash() public {
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
    }

    // ---- swaps ----

    function test_executeSwap_swapsPooledFundsInsideTheVault() public {
        _deposit(1_000 ether, _deadline());
        uint256 out = _swapUsdgToNvda(1_000 ether);
        assertEq(out, 5 ether);
        assertEq(nvda.balanceOf(address(vault)), 5 ether);
        assertEq(usdg.balanceOf(address(vault)), 0);
        assertEq(usdg.allowance(address(vault), address(router)), 0, "approval must be reset");
    }

    function test_executeSwap_onlyOperatorAndAllowlistedRouter() public {
        _deposit(1_000 ether, _deadline());
        bytes memory data = abi.encodeCall(MockDexRouter.swapExactIn, (address(usdg), address(nvda), 1 ether, 1));
        vm.expectRevert(CurtainVault.NotOperator.selector);
        vault.executeSwap(address(router), address(usdg), 1 ether, address(nvda), 1, data);

        MockDexRouter rogue = new MockDexRouter();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.RouterNotAllowed.selector, address(rogue)));
        vault.executeSwap(address(rogue), address(usdg), 1 ether, address(nvda), 1, data);
    }

    function test_executeSwap_revertsIfOutputGoesElsewhere() public {
        _deposit(1_000 ether, _deadline());
        StealingRouter thiefRouter = new StealingRouter();
        nvda.mint(address(thiefRouter), 10 ether);
        vm.prank(admin);
        vault.setAllowedRouter(address(thiefRouter), true);

        bytes memory data = abi.encodeCall(StealingRouter.swapTo, (address(usdg), address(nvda), 1_000 ether, 5 ether, address(0xBAD)));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CurtainVault.InsufficientOutput.selector, 0, 4 ether));
        vault.executeSwap(address(thiefRouter), address(usdg), 1_000 ether, address(nvda), 4 ether, data);
    }

    function test_executeSwap_routerCannotPullMoreThanAmountIn() public {
        _deposit(1_000 ether, _deadline());
        StealingRouter thiefRouter = new StealingRouter();
        vm.prank(admin);
        vault.setAllowedRouter(address(thiefRouter), true);
        bytes memory data = abi.encodeCall(StealingRouter.overpull, (address(usdg), 1_000 ether));
        vm.prank(operator);
        vm.expectRevert(CurtainVault.SwapCallFailed.selector);
        vault.executeSwap(address(thiefRouter), address(usdg), 10 ether, address(nvda), 1, data);
    }

    // ---- payouts ----

    function test_payout_anyKeeperSubmitsSignedPayout() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        _swapUsdgToNvda(1_000 ether);
        CurtainVault.Payout memory p = _payout(id, 4.98 ether, 1);
        bytes memory sig = _sign(p, operatorKey);

        vm.prank(keeper);
        vault.payout(p, sig);

        assertEq(nvda.balanceOf(bob), 4.98 ether);
        assertEq(nvda.balanceOf(treasury), p.protocolFee);
        assertEq(nvda.balanceOf(keeper), 0.001 ether);
        assertTrue(vault.tagUsed(p.tag));
    }

    function test_payout_rejectsTamperingReplayExpiryAndWrongSigner() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        _swapUsdgToNvda(1_000 ether);
        CurtainVault.Payout memory p = _payout(id, 1 ether, 7);
        bytes memory sig = _sign(p, operatorKey);

        CurtainVault.Payout memory redirected = _payout(id, 1 ether, 7); // separate copy: memory structs alias
        redirected.recipient = keeper;
        vm.expectRevert(CurtainVault.BadSignature.selector);
        vault.payout(redirected, sig);

        bytes memory wrongSig = _sign(p, 0xBADBAD);
        vm.expectRevert(CurtainVault.BadSignature.selector);
        vault.payout(p, wrongSig);

        vault.payout(p, sig);
        vm.expectRevert(CurtainVault.NonceUsed.selector);
        vault.payout(p, sig);

        CurtainVault.Payout memory late = _payout(id, 1 ether, 8);
        late.tag = keccak256("other");
        bytes memory lateSig = _sign(late, operatorKey);
        vm.warp(late.deadline + 1);
        vm.expectRevert(CurtainVault.PayoutExpired.selector);
        vault.payout(late, lateSig);
    }

    function test_payout_tagDoesNotRevealDeposit() public {
        uint256 id = _deposit(1_000 ether, _deadline());
        bytes32 tag = keccak256(abi.encode(id, SECRET));
        assertTrue(tag != keccak256(abi.encode(id)), "tag must depend on a secret");
        assertEq(vault.tagFor(id, SECRET), tag);
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
        vault.finalizeRefund(id); // anyone can finalize; funds go to the depositor
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

        // Lying about an earlier deadline doesn't match the committed hash.
        vm.prank(alice);
        vm.expectRevert(CurtainVault.WrongDeadline.selector);
        vault.requestRefund(id, deadline - 1 hours, SALT);
    }

    function test_refund_challengedWhenAlreadyPaid() public {
        uint256 deadline = _deadline();
        uint256 id = _deposit(1_000 ether, deadline);
        _swapUsdgToNvda(1_000 ether);
        CurtainVault.Payout memory p = _payout(id, 4.9 ether, 1);
        vault.payout(p, _sign(p, operatorKey));

        // Refill USDG so a successful double-dip would actually be payable.
        usdg.mint(address(vault), 1_000 ether);

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
        _swapUsdgToNvda(1_000 ether);
        CurtainVault.Payout memory p = _payout(id, 4.9 ether, 1);
        vault.payout(p, _sign(p, operatorKey));
        usdg.mint(address(vault), 1_000 ether);

        vm.warp(deadline + 3 minutes);
        vm.prank(alice);
        vault.requestRefund(id, deadline, SALT);
        vm.warp(vm.getBlockTimestamp() + 10 minutes + 1);
        vm.expectRevert(CurtainVault.ChallengeClosed.selector);
        vault.challengeRefund(id, SECRET);
    }

    // ---- admin ----

    function test_admin_onlyOwnerAndFeeCap() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.setOperator(address(1));

        vm.prank(admin);
        vm.expectRevert(CurtainVault.FeeTooHigh.selector);
        vault.setFeeBps(101);

        vm.prank(admin);
        vault.setOperator(address(0x1234));
        CurtainVault.Payout memory p = _payout(1, 1, 1);
        bytes memory oldOperatorSig = _sign(p, operatorKey);
        vm.expectRevert(CurtainVault.BadSignature.selector); // old operator's signatures stop working
        vault.payout(p, oldOperatorSig);
    }
}
