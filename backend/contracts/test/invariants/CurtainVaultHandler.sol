// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDexRouter} from "../mocks/MockDexRouter.sol";

/// @notice Handler contract driving stateful invariant campaigns on CurtainVault.
/// Acts as an autonomous adversary and ecosystem, executing randomized sequences
/// of deposits, settlements, refunds, challenges, and fee configurations.
contract CurtainVaultHandler is Test {
    CurtainVault public vault;
    MockERC20 public usdg;
    MockERC20 public nvda;
    MockDexRouter public router;

    address public admin;
    uint256 public operatorKey = 0x0FE8A70;
    address public operator;
    address public treasury;
    address public keeper;

    address[3] public actors;
    address[2] public recipients;

    struct DepositRecord {
        uint256 id;
        address depositor;
        uint256 amount;
        uint256 deadline;
        bytes32 salt;
        bytes32 secret;
        uint256 refundRequestedAt;
    }

    // Ghost tracking variables
    uint256 public ghost_activeDepositBalanceUSDG;
    uint256 public ghost_totalDeposits;
    uint256 public ghost_totalSettled;
    uint256 public ghost_totalRefunded;
    uint256 public ghost_totalChallenged;
    uint256 public ghost_settlementCount;

    mapping(uint256 => bool) public ghost_depositSettled;
    mapping(uint256 => bool) public ghost_depositRefunded;
    mapping(uint256 => bool) public ghost_depositChallenged;
    mapping(uint256 => DepositRecord) public ghost_deposits;

    uint256[] public activeDepositIds;
    uint256[] public refundRequestedIds;

    constructor(
        CurtainVault vault_,
        MockERC20 usdg_,
        MockERC20 nvda_,
        MockDexRouter router_,
        address admin_,
        address treasury_,
        address keeper_
    ) {
        vault = vault_;
        usdg = usdg_;
        nvda = nvda_;
        router = router_;
        admin = admin_;
        operator = vm.addr(operatorKey);
        treasury = treasury_;
        keeper = keeper_;

        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("charlie");

        recipients[0] = makeAddr("recipient1");
        recipients[1] = makeAddr("recipient2");

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(actors[i]);
            usdg.approve(address(vault), type(uint256).max);
        }
    }

    // -------------------------------------------------------------
    // Actions
    // -------------------------------------------------------------

    /// @notice Randomized user deposit into CurtainVault
    function deposit(uint256 actorSeed, uint256 amountSeed, uint256 deadlineSeed) external {
        if (vault.depositsPaused()) return;

        address actor = actors[actorSeed % 3];
        uint256 amount = bound(amountSeed, 1 ether, 5_000 ether);
        uint256 deadline = block.timestamp + bound(deadlineSeed, 10 minutes, 30 days);

        bytes32 salt = keccak256(abi.encode(ghost_totalDeposits + 1, actor, block.timestamp, amount));
        bytes32 secret = keccak256(abi.encode("secret", ghost_totalDeposits + 1, salt));
        bytes32 deadlineHash = keccak256(abi.encode(deadline, salt));

        usdg.mint(actor, amount);

        vm.prank(actor);
        uint256 id = vault.deposit(address(usdg), amount, deadlineHash);

        ghost_deposits[id] = DepositRecord({
            id: id,
            depositor: actor,
            amount: amount,
            deadline: deadline,
            salt: salt,
            secret: secret,
            refundRequestedAt: 0
        });

        activeDepositIds.push(id);
        ghost_activeDepositBalanceUSDG += amount;
        ghost_totalDeposits++;
    }

    /// @notice Randomized atomic settlement of an active deposit
    function settle(uint256 indexSeed, uint256 recipientSeed, uint256 pFeeBpsSeed, uint256 kFeeBpsSeed) external {
        if (activeDepositIds.length == 0) return;

        uint256 idx = indexSeed % activeDepositIds.length;
        uint256 id = activeDepositIds[idx];
        if (ghost_depositSettled[id] || ghost_depositRefunded[id]) return;

        DepositRecord storage dep = ghost_deposits[id];
        if (block.timestamp > dep.deadline) return;

        uint256 gross = (dep.amount * router.rateWad(address(usdg), address(nvda))) / 1e18;
        if (gross == 0) return;

        uint256 pBps = bound(pFeeBpsSeed, 0, uint256(vault.feeBps()));
        uint256 kBps = bound(kFeeBpsSeed, 0, uint256(vault.MAX_KEEPER_FEE_BPS()));

        CurtainVault.Payout[] memory payouts = _buildPayout(id, dep.secret, recipients[recipientSeed % 2], gross, pBps, kBps);
        CurtainVault.Swap memory swap = _buildSwap(dep.amount, gross);

        uint256 nonce = ++ghost_settlementCount;
        bytes memory sig = _signSettlement(swap, payouts, dep.deadline, nonce);

        nvda.mint(address(router), gross);

        vm.prank(keeper);
        vault.settle(swap, payouts, dep.deadline, nonce, sig);

        ghost_depositSettled[id] = true;
        ghost_totalSettled++;
        ghost_activeDepositBalanceUSDG -= dep.amount;

        _removeActiveDeposit(idx);
    }

    function _buildPayout(
        uint256 id,
        bytes32 secret,
        address recipient,
        uint256 gross,
        uint256 pBps,
        uint256 kBps
    ) internal pure returns (CurtainVault.Payout[] memory ps) {
        uint256 protocolFee = (gross * pBps) / 10_000;
        uint256 keeperFee = (gross * kBps) / 10_000;
        ps = new CurtainVault.Payout[](1);
        ps[0] = CurtainVault.Payout({
            recipient: recipient,
            amount: gross - protocolFee - keeperFee,
            protocolFee: protocolFee,
            keeperFee: keeperFee,
            tag: keccak256(abi.encode(id, secret))
        });
    }

    function _buildSwap(uint256 amountIn, uint256 minOut) internal view returns (CurtainVault.Swap memory) {
        return CurtainVault.Swap({
            router: address(router),
            tokenIn: address(usdg),
            amountIn: amountIn,
            tokenOut: address(nvda),
            minOut: minOut,
            data: abi.encodeCall(MockDexRouter.swapExactIn, (address(usdg), address(nvda), amountIn, minOut))
        });
    }

    function _signSettlement(
        CurtainVault.Swap memory swap,
        CurtainVault.Payout[] memory payouts,
        uint256 deadline,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 digest = vault.settlementDigest(swap, payouts, deadline, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Randomized escape-hatch refund request after deadline
    function requestRefund(uint256 indexSeed) external {
        if (activeDepositIds.length == 0) return;

        uint256 idx = indexSeed % activeDepositIds.length;
        uint256 id = activeDepositIds[idx];

        if (ghost_depositSettled[id] || ghost_depositRefunded[id]) return;

        DepositRecord storage dep = ghost_deposits[id];
        uint256 unlockTime = dep.deadline + vault.REFUND_DELAY();

        if (block.timestamp < unlockTime) {
            vm.warp(unlockTime + 1);
        }

        vm.prank(dep.depositor);
        vault.requestRefund(id, dep.deadline, dep.salt);

        dep.refundRequestedAt = block.timestamp;
        refundRequestedIds.push(id);
    }

    /// @notice Operator challenges an unjustified refund on an already settled deposit
    function challengeRefund(uint256 indexSeed) external {
        if (refundRequestedIds.length == 0) return;

        uint256 idx = indexSeed % refundRequestedIds.length;
        uint256 id = refundRequestedIds[idx];

        if (!ghost_depositSettled[id]) return; // Only challenge if actually paid
        if (ghost_depositChallenged[id]) return;

        DepositRecord storage dep = ghost_deposits[id];
        if (block.timestamp > dep.refundRequestedAt + vault.CHALLENGE_WINDOW()) return;

        vault.challengeRefund(id, dep.secret);
        ghost_depositChallenged[id] = true;
        ghost_totalChallenged++;
    }

    /// @notice Finalizes an unchallenged refund after the 10-minute window
    function finalizeRefund(uint256 indexSeed) external {
        if (refundRequestedIds.length == 0) return;

        uint256 idx = indexSeed % refundRequestedIds.length;
        uint256 id = refundRequestedIds[idx];

        if (ghost_depositRefunded[id] || ghost_depositChallenged[id] || ghost_depositSettled[id]) return;

        DepositRecord storage dep = ghost_deposits[id];
        uint256 finalizeTime = dep.refundRequestedAt + vault.CHALLENGE_WINDOW() + 1;

        if (block.timestamp <= finalizeTime) {
            vm.warp(finalizeTime + 1);
        }

        vault.finalizeRefund(id);

        ghost_depositRefunded[id] = true;
        ghost_totalRefunded++;
        ghost_activeDepositBalanceUSDG -= dep.amount;

        _removeActiveDepositById(id);
        _removeRefundRequested(idx);
    }

    /// @notice Warps time forward within reasonable bounds
    function warpTime(uint256 jumpSeed) external {
        uint256 jump = bound(jumpSeed, 1, 2 days);
        vm.warp(block.timestamp + jump);
    }

    /// @notice Admin adjusts fee within allowable cap
    function setFeeBps(uint16 newFeeBps) external {
        uint16 capped = uint16(bound(uint256(newFeeBps), 0, uint256(vault.MAX_FEE_BPS())));
        vm.prank(admin);
        vault.setFeeBps(capped);
    }

    /// @notice Admin pause/unpause deposits
    function togglePause(bool paused) external {
        vm.prank(admin);
        vault.setDepositsPaused(paused);
    }

    // -------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------

    function _removeActiveDeposit(uint256 index) internal {
        if (index >= activeDepositIds.length) return;
        activeDepositIds[index] = activeDepositIds[activeDepositIds.length - 1];
        activeDepositIds.pop();
    }

    function _removeActiveDepositById(uint256 id) internal {
        for (uint256 i = 0; i < activeDepositIds.length; i++) {
            if (activeDepositIds[i] == id) {
                _removeActiveDeposit(i);
                break;
            }
        }
    }

    function _removeRefundRequested(uint256 index) internal {
        if (index >= refundRequestedIds.length) return;
        refundRequestedIds[index] = refundRequestedIds[refundRequestedIds.length - 1];
        refundRequestedIds.pop();
    }
}
