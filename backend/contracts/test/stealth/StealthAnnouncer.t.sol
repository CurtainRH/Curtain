// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StealthAnnouncer} from "../../src/stealth/StealthAnnouncer.sol";

contract StealthAnnouncerTest is Test {
    StealthAnnouncer internal announcer;

    function setUp() public {
        announcer = new StealthAnnouncer();
    }

    function test_announce_emitsExpectedEvent() public {
        address stealthAddress = address(0xBEEF);
        bytes memory ephemeralPubKey = hex"02aabbccdd";
        bytes memory metadata = hex"01"; // view tag byte for scheme 1

        vm.expectEmit(true, true, true, true);
        emit StealthAnnouncer.Announcement(1, stealthAddress, address(this), ephemeralPubKey, metadata);

        announcer.announce(1, stealthAddress, ephemeralPubKey, metadata);
    }

    function test_announce_callerIsMsgSenderNotStealthAddress(address caller, address stealthAddress) public {
        vm.assume(caller != address(0));
        bytes memory ephemeralPubKey = hex"03";
        bytes memory metadata = hex"00";

        vm.prank(caller);
        vm.expectEmit(true, true, true, true);
        emit StealthAnnouncer.Announcement(1, stealthAddress, caller, ephemeralPubKey, metadata);
        announcer.announce(1, stealthAddress, ephemeralPubKey, metadata);
    }
}
