// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Registered-token allowlist for CurtainPool, per Curtain_Build.md
/// §3.8. Flags ERC-8056 (rebase-aware, raw-unit) tokens so the pool and
/// wallet SDK know to apply `uiMultiplier()` for display only, never inside
/// note commitments. `owner` is meant to be a TimelockController behind a
/// 2-of-3 multisig per the deploy runbook (§7 step 9) — this contract
/// itself just provides the access-controlled registry those govern.
contract AssetGate is Ownable {
    struct TokenInfo {
        bool registered;
        bool is8056;
        address feed;
    }

    mapping(address => TokenInfo) public tokens;

    event TokenRegistered(address indexed token, bool is8056, address feed);
    event TokenDeregistered(address indexed token);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function register(address token, bool is8056, address feed) external onlyOwner {
        require(token != address(0), "AssetGate: zero token");
        tokens[token] = TokenInfo({registered: true, is8056: is8056, feed: feed});
        emit TokenRegistered(token, is8056, feed);
    }

    function deregister(address token) external onlyOwner {
        delete tokens[token];
        emit TokenDeregistered(token);
    }

    function isRegistered(address token) external view returns (bool) {
        return tokens[token].registered;
    }

    function isRawUnit8056(address token) external view returns (bool) {
        return tokens[token].is8056;
    }
}
