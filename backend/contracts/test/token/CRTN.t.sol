// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CRTN} from "../../src/token/CRTN.sol";

contract CRTNTest is Test {
    CRTN internal crtn;

    address internal community = address(0xC001);
    address internal team = address(0x7EA7);
    address internal backers = address(0xBAC0);
    address internal subsidies = address(0x5080);

    function setUp() public {
        crtn = new CRTN(community, team, backers, subsidies);
    }

    function test_InitialSupplyAndBuckets() public view {
        assertEq(crtn.totalSupply(), 100_000_000 ether);
        assertEq(crtn.balanceOf(community), 80_000_000 ether);
        assertEq(crtn.balanceOf(team), 10_000_000 ether);
        assertEq(crtn.balanceOf(backers), 5_000_000 ether);
        assertEq(crtn.balanceOf(subsidies), 5_000_000 ether);
    }

    function test_ZeroAddressReverts() public {
        vm.expectRevert(CRTN.ZeroAddress.selector);
        new CRTN(address(0), team, backers, subsidies);

        vm.expectRevert(CRTN.ZeroAddress.selector);
        new CRTN(community, address(0), backers, subsidies);

        vm.expectRevert(CRTN.ZeroAddress.selector);
        new CRTN(community, team, address(0), subsidies);

        vm.expectRevert(CRTN.ZeroAddress.selector);
        new CRTN(community, team, backers, address(0));
    }

    function test_Burn() public {
        vm.prank(community);
        crtn.burn(1_000 ether);

        assertEq(crtn.balanceOf(community), 79_999_000 ether);
        assertEq(crtn.totalSupply(), 99_999_000 ether);
    }
}
