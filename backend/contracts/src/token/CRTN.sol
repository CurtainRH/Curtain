// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Curtain governance & staking token ($CRTN), per Curtain_Build.md §3.9 & §5.
/// Total supply of 100,000,000 CRTN minted at construction to four designated buckets:
/// - 80% (80,000,000 CRTN): Community / Shield Staking & Rewards
/// - 10% (10,000,000 CRTN): Core Contributors / Team
/// - 5%  (5,000,000 CRTN) : Early Backers / Advisory
/// - 5%  (5,000,000 CRTN) : Broadcaster Subsidies & Protocol Reserve
contract CRTN is ERC20, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 100_000_000 ether;

    uint256 public constant COMMUNITY_SHARE = 80_000_000 ether; // 80%
    uint256 public constant TEAM_SHARE      = 10_000_000 ether; // 10%
    uint256 public constant BACKERS_SHARE   =  5_000_000 ether; // 5%
    uint256 public constant SUBSIDIES_SHARE =  5_000_000 ether; // 5%

    error ZeroAddress();

    constructor(
        address communityBucket,
        address teamBucket,
        address backersBucket,
        address subsidiesBucket
    ) ERC20("Curtain", "CRTN") {
        if (
            communityBucket == address(0) ||
            teamBucket == address(0) ||
            backersBucket == address(0) ||
            subsidiesBucket == address(0)
        ) {
            revert ZeroAddress();
        }

        _mint(communityBucket, COMMUNITY_SHARE);
        _mint(teamBucket, TEAM_SHARE);
        _mint(backersBucket, BACKERS_SHARE);
        _mint(subsidiesBucket, SUBSIDIES_SHARE);
    }
}
