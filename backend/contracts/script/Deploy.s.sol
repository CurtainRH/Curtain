// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CurtainVault} from "../src/vault/CurtainVault.sol";
import {CurtainStaking} from "../src/staking/CurtainStaking.sol";
import {StealthRegistry} from "../src/stealth/StealthRegistry.sol";
import {StealthAnnouncer} from "../src/stealth/StealthAnnouncer.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockDexRouter} from "../test/mocks/MockDexRouter.sol";

/// @notice Deploys Curtain v2 (docs/CURTAIN_V2_SPEC.md).
///
/// On Robinhood Chain (4663): PRIVATE_KEY, ADMIN_ADDR, OPERATOR_ADDR, TREASURY_ADDR,
/// DEX_ROUTER_ADDR and TOKEN_ADDRS (comma-separated token addresses to allow) are required;
/// symbols are read from each token. No mocks are deployed.
/// On local chains: Anvil's public dev key, mock tokens and a mock DEX router.
///
/// Staking ships with no tokens set; the admin calls `setTokens` once $CRTN launches.
/// Writes deployments/<chainid>.json (or $DEPLOYMENT_FILE).
contract DeployScript is Script {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    // Anvil account #0 — public, well-known, for local chains only (never used on 4663).
    uint256 internal constant ANVIL_DEV_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // Local chains only: mock tokens to deploy.
    string[6] internal mockSymbols = ["USDG", "NVDA", "TSLA", "SPY", "QQQ", "HOOD"];

    function run() external {
        bool production = block.chainid == RHC_CHAIN_ID;
        uint256 key = production ? vm.envUint("PRIVATE_KEY") : vm.envOr("PRIVATE_KEY", ANVIL_DEV_KEY);
        address deployer = vm.addr(key);
        address admin = production ? vm.envAddress("ADMIN_ADDR") : vm.envOr("ADMIN_ADDR", deployer);
        address operator = production ? vm.envAddress("OPERATOR_ADDR") : vm.envOr("OPERATOR_ADDR", deployer);
        address treasury = production ? vm.envAddress("TREASURY_ADDR") : vm.envOr("TREASURY_ADDR", deployer);

        vm.startBroadcast(key);

        // Deployer is the temporary owner so it can allowlist tokens and routers, then hands
        // ownership to `admin`.
        CurtainVault vault = new CurtainVault(deployer, operator, treasury);
        CurtainStaking staking = new CurtainStaking(admin);

        address[] memory tokens;
        if (production) {
            tokens = vm.envAddress("TOKEN_ADDRS", ",");
            for (uint256 i = 0; i < tokens.length; i++) {
                require(tokens[i].code.length > 0, "DeployScript: TOKEN_ADDRS entry has no code");
            }
        } else {
            tokens = new address[](mockSymbols.length);
            for (uint256 i = 0; i < mockSymbols.length; i++) tokens[i] = address(new MockERC20(mockSymbols[i], mockSymbols[i]));
        }
        for (uint256 i = 0; i < tokens.length; i++) vault.setAllowedToken(tokens[i], true);

        address router;
        if (production) {
            router = vm.envAddress("DEX_ROUTER_ADDR");
            require(router.code.length > 0, "DeployScript: no code at DEX_ROUTER_ADDR");
        } else {
            router = address(new MockDexRouter());
        }
        vault.setAllowedRouter(router, true);
        if (admin != deployer) vault.transferOwnership(admin);

        StealthRegistry stealthRegistry = new StealthRegistry();
        StealthAnnouncer stealthAnnouncer = new StealthAnnouncer();

        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeBool(k, "production", production);
        vm.serializeAddress(k, "admin", admin);
        vm.serializeAddress(k, "operator", operator);
        vm.serializeAddress(k, "treasury", treasury);
        vm.serializeAddress(k, "vault", address(vault));
        vm.serializeAddress(k, "staking", address(staking));
        vm.serializeAddress(k, "router", router);
        vm.serializeAddress(k, "stealthRegistry", address(stealthRegistry));
        vm.serializeAddress(k, "stealthAnnouncer", address(stealthAnnouncer));
        string memory t = "tokens";
        string memory tokensJson;
        for (uint256 i = 0; i < tokens.length; i++) {
            tokensJson = vm.serializeAddress(t, IERC20Metadata(tokens[i]).symbol(), tokens[i]);
        }
        string memory json = vm.serializeString(k, "tokens", tokensJson);
        string memory defaultFile = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, vm.envOr("DEPLOYMENT_FILE", defaultFile)); // override lets fork tests avoid the real file

        console.log("CurtainVault:  ", address(vault));
        console.log("CurtainStaking:", address(staking));
        console.log("DEX router:    ", router);
        console.log("Admin:         ", admin);
        console.log("Operator:      ", operator);
        if (admin != deployer) console.log("Next: the admin must call acceptOwnership() on the vault to finish the transfer.");
    }
}
