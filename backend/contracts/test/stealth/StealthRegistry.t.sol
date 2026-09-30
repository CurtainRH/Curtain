// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StealthRegistry} from "../../src/stealth/StealthRegistry.sol";

contract StealthRegistryTest is Test {
    StealthRegistry internal registry;

    // Fixed test key so we can sign registerKeysOnBehalf payloads deterministically.
    uint256 internal constant REGISTRANT_PK = 0xA11CE;
    address internal registrant;

    function setUp() public {
        registry = new StealthRegistry();
        registrant = vm.addr(REGISTRANT_PK);
    }

    function test_registerKeys_storesAndEmits() public {
        bytes memory metaAddress = hex"0203040506";

        vm.expectEmit(true, true, false, true);
        emit StealthRegistry.StealthMetaAddressSet(address(this), 1, metaAddress);

        registry.registerKeys(1, metaAddress);

        assertEq(registry.stealthMetaAddressOf(address(this), 1), metaAddress);
    }

    function test_registerKeys_isPerSchemeId() public {
        bytes memory metaA = hex"aa";
        bytes memory metaB = hex"bb";

        registry.registerKeys(1, metaA);
        registry.registerKeys(2, metaB);

        assertEq(registry.stealthMetaAddressOf(address(this), 1), metaA);
        assertEq(registry.stealthMetaAddressOf(address(this), 2), metaB);
    }

    function test_registerKeysOnBehalf_validSignature() public {
        bytes memory metaAddress = hex"0203040506";
        uint256 schemeId = 1;
        uint256 nonce = registry.nonceOf(registrant);

        bytes32 digest = _entryDigest(schemeId, metaAddress, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(REGISTRANT_PK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        registry.registerKeysOnBehalf(registrant, schemeId, signature, metaAddress);

        assertEq(registry.stealthMetaAddressOf(registrant, schemeId), metaAddress);
        assertEq(registry.nonceOf(registrant), nonce + 1);
    }

    function test_registerKeysOnBehalf_revertsOnBadSignature() public {
        bytes memory metaAddress = hex"0203040506";
        uint256 wrongPk = 0xB0B;
        bytes32 digest = _entryDigest(1, metaAddress, registry.nonceOf(registrant));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.expectRevert(StealthRegistry.StealthRegistry__InvalidSignature.selector);
        registry.registerKeysOnBehalf(registrant, 1, signature, metaAddress);
    }

    function test_registerKeysOnBehalf_signatureNotReplayable() public {
        bytes memory metaAddress = hex"0203040506";
        uint256 nonce = registry.nonceOf(registrant);
        bytes32 digest = _entryDigest(1, metaAddress, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(REGISTRANT_PK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        registry.registerKeysOnBehalf(registrant, 1, signature, metaAddress);

        // Same signature (built against the now-stale nonce) must not work twice.
        vm.expectRevert(StealthRegistry.StealthRegistry__InvalidSignature.selector);
        registry.registerKeysOnBehalf(registrant, 1, signature, metaAddress);
    }

    function _entryDigest(uint256 schemeId, bytes memory metaAddress, uint256 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                registry.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        registry.ERC6538REGISTRY_ENTRY_TYPE_HASH(), schemeId, keccak256(metaAddress), nonce
                    )
                )
            )
        );
    }
}
