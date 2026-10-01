// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Mimics tokens with transfer restrictions (blocklists, compliance hooks):
/// - `blocked[to]`: every transfer to `to` reverts, even of 0 (USDC-style blocklist)
/// - `noReceive[to]`: non-zero transfers to `to` revert, zero transfers pass (a restriction a
///   zero-amount probe can't see)
contract RestrictedERC20 is ERC20 {
    mapping(address => bool) public blocked;
    mapping(address => bool) public noReceive;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function setNoReceive(address who, bool b) external {
        noReceive[who] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "RestrictedERC20: recipient blocked");
        require(!(noReceive[to] && value > 0), "RestrictedERC20: recipient cannot receive");
        super._update(from, to, value);
    }
}
