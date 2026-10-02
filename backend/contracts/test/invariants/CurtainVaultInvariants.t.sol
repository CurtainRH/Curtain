// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainVault} from "../../src/vault/CurtainVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDexRouter} from "../mocks/MockDexRouter.sol";
import {CurtainVaultHandler} from "./CurtainVaultHandler.sol";

/// @notice Invariant test suite for CurtainVault, verifying system-wide mathematical truths
/// across randomized, multi-actor state transitions.
contract CurtainVaultInvariants is Test {
    CurtainVault public vault;
    MockERC20 public usdg;
    MockERC20 public nvda;
    MockDexRouter public router;
    CurtainVaultHandler public handler;

    address public admin = address(0xAD);
    uint256 public operatorKey = 0x0FE8A70;
    address public operator;
    address public treasury = address(0x7EA5);
    address public keeper = address(0x6EE9);

    function setUp() public {
        vm.warp(1_000_000);
        operator = vm.addr(operatorKey);

        vault = new CurtainVault(admin, operator, treasury);
        usdg = new MockERC20("USD Global", "USDG");
        nvda = new MockERC20("NVIDIA", "NVDA");
        router = new MockDexRouter();

        // 200 USDG = 1 NVDA (rate = 0.005e18)
        router.setRate(address(usdg), address(nvda), 0.005e18);

        vm.startPrank(admin);
        vault.setAllowedToken(address(usdg), true);
        vault.setAllowedToken(address(nvda), true);
        vault.setAllowedRouter(address(router), true);
        vm.stopPrank();

        handler = new CurtainVaultHandler(vault, usdg, nvda, router, admin, treasury, keeper);

        targetContract(address(handler));
    }

    /// @notice Invariant 1: Vault Solvency
    /// The vault's balance of deposit tokens must always be greater than or equal to
    /// the sum of all active, unfinalized deposits. The vault can never be insolvent.
    function invariant_vaultSolvency() public view {
        uint256 vaultBal = usdg.balanceOf(address(vault));
        uint256 activeExpected = handler.ghost_activeDepositBalanceUSDG();
        assertGe(vaultBal, activeExpected, "SOLVENCY_VIOLATION: Vault balance below active deposit obligation");
    }

    /// @notice Invariant 2: Double-Claim / Double-Refund Prevention
    /// No deposit can EVER both have its payout settled and its escape-hatch refund finalized.
    function invariant_noDoubleClaim() public view {
        uint256 total = handler.ghost_totalDeposits();
        for (uint256 i = 1; i <= total; i++) {
            bool settled = handler.ghost_depositSettled(i);
            bool refunded = handler.ghost_depositRefunded(i);
            assertFalse(
                settled && refunded,
                string.concat("DOUBLE_CLAIM_VIOLATION: Deposit ", vm.toString(i), " both settled and refunded")
            );
        }
    }

    /// @notice Invariant 3: Conservation of Deposit States
    /// The count of settled deposits + refunded deposits must never exceed total deposits created.
    function invariant_conservationOfDeposits() public view {
        uint256 settled = handler.ghost_totalSettled();
        uint256 refunded = handler.ghost_totalRefunded();
        uint256 total = handler.ghost_totalDeposits();

        assertLe(settled + refunded, total, "CONSERVATION_VIOLATION: Terminal deposits exceed total created");
    }

    /// @notice Invariant 4: Protocol Fee Upper Bound
    /// Protocol fee setting must never exceed MAX_FEE_BPS (100 = 1%).
    function invariant_feeCaps() public view {
        assertLe(vault.feeBps(), vault.MAX_FEE_BPS(), "FEE_CAP_VIOLATION: Protocol fee exceeds maximum cap");
    }

    /// @notice Invariant 5: Settled Status Reflection
    /// Any deposit marked settled in ghost tracking must have status == Status.Settled or a tagUsed.
    function invariant_settledConsistency() public view {
        uint256 total = handler.ghost_totalDeposits();
        for (uint256 i = 1; i <= total; i++) {
            if (handler.ghost_depositSettled(i)) {
                (, , , , , CurtainVault.Status status) = vault.deposits(i);
                // Status must either be Active (default before challenge) or Settled (if challenged)
                assertTrue(
                    status != CurtainVault.Status.Refunded,
                    "SETTLED_CONSISTENCY_VIOLATION: Settled deposit marked as Refunded in contract"
                );
            }
        }
    }
}
