// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "../../src/disclosure/DisclosureRegistry.sol";

contract DisclosureRegistryTest is Test {
    DisclosureRegistry internal registry;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    bytes32 internal constant SCOPE = keccak256("SCOPE_2026_Q3");
    bytes internal viewerEk = hex"12345678";
    bytes internal encryptedVk = hex"abcdef0123456789";

    function setUp() public {
        registry = new DisclosureRegistry();
    }

    function test_grant_createsActiveGrant() public {
        vm.prank(alice);
        bytes32 grantId = registry.grant(SCOPE, viewerEk, encryptedVk, uint64(block.timestamp + 3600));

        assertTrue(registry.isGrantActive(grantId));

        DisclosureRegistry.Grant memory g = registry.getGrant(grantId);
        assertEq(g.granter, alice);
        assertEq(g.scopeHash, SCOPE);
        assertEq(g.viewerEk, viewerEk);
        assertEq(g.encryptedVk, encryptedVk);
        assertEq(g.until, block.timestamp + 3600);
        assertFalse(g.revoked);
    }

    function test_grant_expiresAfterTimestamp() public {
        uint64 until = uint64(block.timestamp + 100);
        vm.prank(alice);
        bytes32 grantId = registry.grant(SCOPE, viewerEk, encryptedVk, until);

        assertTrue(registry.isGrantActive(grantId));

        vm.warp(until + 1);
        assertFalse(registry.isGrantActive(grantId));
    }

    function test_revoke_granterCanRevoke() public {
        vm.prank(alice);
        bytes32 grantId = registry.grant(SCOPE, viewerEk, encryptedVk, 0);

        assertTrue(registry.isGrantActive(grantId));

        vm.prank(alice);
        registry.revoke(grantId);

        assertFalse(registry.isGrantActive(grantId));
    }

    function test_revoke_nonGranterReverts() public {
        vm.prank(alice);
        bytes32 grantId = registry.grant(SCOPE, viewerEk, encryptedVk, 0);

        vm.prank(bob);
        vm.expectRevert(DisclosureRegistry.NotGranter.selector);
        registry.revoke(grantId);
    }
}
