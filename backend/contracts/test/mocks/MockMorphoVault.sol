// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only stand-in for a Morpho / MetaMorpho ERC-4626 vault,
/// exercising RelayAdapt's yield-in-shield deposit/withdraw flow.
///
/// Labeled as a test mock following the established pattern from M6's
/// MockDexRouter.sol — testing against real Morpho mainnet contracts requires
/// a mainnet-fork RPC not available in this dev environment.
contract MockMorphoVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable underlyingAsset;
    uint256 public rateWad = 1e18; // 1 share = rateWad / 1e18 assets

    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    constructor(address asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        underlyingAsset = IERC20(asset_);
    }

    function asset() external view returns (address) {
        return address(underlyingAsset);
    }

    function setRate(uint256 newRateWad) external {
        rateWad = newRateWad;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * rateWad) / 1e18;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return (assets * 1e18) / rateWad;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(shares > 0, "MockMorphoVault: 0 shares");
        underlyingAsset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = convertToShares(assets);
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        underlyingAsset.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        assets = convertToAssets(shares);
        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        underlyingAsset.safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }
}
