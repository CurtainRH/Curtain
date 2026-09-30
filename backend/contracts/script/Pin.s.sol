// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {CurtainPool} from "../src/pool/CurtainPool.sol";
import {CrtnStaking} from "../src/staking/CrtnStaking.sol";

/// @notice Verifies a live deployment against deployments/<chainid>.json (written by
/// Deploy.s.sol), per Curtain_Build.md §6 / §7 step 10 and the §9 launch gates. Reverts on
/// the first mismatch:
/// - every recorded contract still has the recorded code hash (bytecode pinning);
/// - CurtainPool exposes none of the forbidden admin/upgrade/pause selectors;
/// - CurtainPool's treasury and fee source are CrtnStaking, and its guardian is Guardian;
/// - ScreeningGate, RelayAdapt, AssetGate, BroadcasterBond and Guardian are owned by the
///   timelock, the timelock delay is at least 24h, and CrtnStaking is wired to it.
///
/// Run: forge script script/Pin.s.sol --rpc-url $RPC_HTTP
contract PinScript is Script {
    uint256 internal constant MIN_DELAY = 24 hours;

    bytes4[] private forbiddenSelectors = [
        bytes4(keccak256("owner()")),
        bytes4(keccak256("transferOwnership(address)")),
        bytes4(keccak256("renounceOwnership()")),
        bytes4(keccak256("pause()")),
        bytes4(keccak256("unpause()")),
        bytes4(keccak256("paused()")),
        bytes4(keccak256("upgradeTo(address)")),
        bytes4(keccak256("upgradeToAndCall(address,bytes)")),
        bytes4(keccak256("setFee(uint256)")),
        bytes4(keccak256("setFeeBps(uint16)")),
        bytes4(keccak256("setTreasury(address)")),
        bytes4(keccak256("mint(address,uint256)")),
        bytes4(keccak256("burn(uint256)"))
    ];

    string[15] internal names = [
        "CurtainPool", "RelayAdapt", "ScreeningGate", "AssetGate", "Guardian", "TimelockController",
        "CrtnStaking", "CRTN", "BroadcasterBond", "SolvencyVerifier", "DisclosureRegistry",
        "StealthRegistry", "StealthAnnouncer", "ERC2771Forwarder", "PpoiVerifierAdapter"
    ];

    function verifyPoolImmutability(address poolAddr) public view returns (bool) {
        require(poolAddr.code.length > 0, "PinScript: pool has no code");
        for (uint256 i = 0; i < forbiddenSelectors.length; i++) {
            (bool success,) = poolAddr.staticcall(abi.encodeWithSelector(forbiddenSelectors[i]));
            require(!success, "PinScript: FORBIDDEN ADMIN SELECTOR DETECTED ON POOL");
        }
        return true;
    }

    function run() external view {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        console.log("--- PIN SCRIPT VERIFICATION ---", path);

        for (uint256 i = 0; i < names.length; i++) {
            address a = _addr(json, names[i]);
            bytes32 expected = vm.parseJsonBytes32(json, string.concat(".contracts.", names[i], ".codehash"));
            require(a.codehash == expected, string.concat("PinScript: code hash mismatch for ", names[i]));
        }
        console.log("Code hashes match for all pinned contracts");

        CurtainPool pool = CurtainPool(_addr(json, "CurtainPool"));
        verifyPoolImmutability(address(pool));
        address staking = _addr(json, "CrtnStaking");
        address timelock = _addr(json, "TimelockController");
        require(pool.treasury() == staking, "PinScript: pool treasury is not CrtnStaking");
        require(address(pool.feeSource()) == staking, "PinScript: pool fee source is not CrtnStaking");
        require(address(pool.guardian()) == _addr(json, "Guardian"), "PinScript: pool guardian mismatch");
        require(pool.relayAdapt() == _addr(json, "RelayAdapt"), "PinScript: pool relayAdapt mismatch");
        console.log("CurtainPool: no admin selectors; treasury/fee source/guardian/relayAdapt wired");

        string[5] memory owned = ["ScreeningGate", "RelayAdapt", "AssetGate", "BroadcasterBond", "Guardian"];
        for (uint256 i = 0; i < owned.length; i++) {
            require(Ownable(_addr(json, owned[i])).owner() == timelock, string.concat("PinScript: timelock must own ", owned[i]));
        }
        require(TimelockController(payable(timelock)).getMinDelay() >= MIN_DELAY, "PinScript: timelock delay < 24h");
        require(address(CrtnStaking(staking).timelock()) == timelock, "PinScript: staking not wired to timelock");
        console.log("Governed contracts owned by the 24h timelock; staking wired to it");
    }

    function _addr(string memory json, string memory name) internal pure returns (address) {
        return vm.parseJsonAddress(json, string.concat(".contracts.", name, ".address"));
    }
}
