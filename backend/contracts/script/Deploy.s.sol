// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {CurtainPool} from "../src/pool/CurtainPool.sol";
import {AssetGate} from "../src/config/AssetGate.sol";
import {ScreeningGate} from "../src/gate/ScreeningGate.sol";
import {RelayAdapt} from "../src/adapt/RelayAdapt.sol";
import {Guardian} from "../src/guardian/Guardian.sol";
import {BroadcasterBond} from "../src/broadcast/BroadcasterBond.sol";
import {StealthRegistry} from "../src/stealth/StealthRegistry.sol";
import {StealthAnnouncer} from "../src/stealth/StealthAnnouncer.sol";
import {DisclosureRegistry} from "../src/disclosure/DisclosureRegistry.sol";
import {SolvencyVerifier} from "../src/solvency/SolvencyVerifier.sol";
import {CRTN} from "../src/token/CRTN.sol";
import {CrtnStaking} from "../src/staking/CrtnStaking.sol";

import {PoseidonT2Deployer} from "../src/lib/PoseidonT2.sol";
import {PoseidonT3Deployer} from "../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../src/lib/PoseidonT5.sol";

import {JoinSplit2x2Groth16Verifier} from "../src/pool/generated/JoinSplit2x2Groth16Verifier.sol";
import {JoinSplit2x2VerifierAdapter} from "../src/pool/JoinSplit2x2VerifierAdapter.sol";
import {JoinSplit3x3Groth16Verifier} from "../src/pool/generated/JoinSplit3x3Groth16Verifier.sol";
import {JoinSplit3x3VerifierAdapter} from "../src/pool/JoinSplit3x3VerifierAdapter.sol";
import {UnshieldGroth16Verifier} from "../src/pool/generated/UnshieldGroth16Verifier.sol";
import {UnshieldVerifierAdapter} from "../src/pool/UnshieldVerifierAdapter.sol";
import {PpoiDevGroth16Verifier} from "../src/gate/generated/PpoiDevGroth16Verifier.sol";
import {PpoiDevVerifierAdapter} from "../src/gate/PpoiDevVerifierAdapter.sol";
import {SolvencyGroth16Verifier} from "../src/solvency/generated/SolvencyGroth16Verifier.sol";
import {SolvencyVerifierAdapter} from "../src/solvency/SolvencyVerifierAdapter.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// @notice Curtain deployment per Curtain_Build.md §7 (runbook), for local dev and for
/// Robinhood Chain (4663).
///
/// PRODUCTION MODE (chainid 4663) refuses anything dev-only:
/// - PRIVATE_KEY must be set (no fallback key).
/// - MULTISIG_ADDR (2-of-3 Safe), GUARDIAN_ADDR, TREASURY_ADDR and the four CRTN buckets
///   must be set.
/// - Tokens come from env (USDG_ADDR, NVDA_ADDR, TSLA_ADDR, SPY_ADDR, QQQ_ADDR, HOOD_ADDR),
///   never MockERC20.
/// - Groth16 verifiers come from env (*_VERIFIER_ADDR), deployed from the real multi-party
///   ceremony's keys. The verifiers generated in this repo are single-contributor dev keys
///   (circuits/build/ceremony.md) and are only deployed on local chains.
///
/// GOVERNANCE WIRING (Curtain_Backend.md §2.8):
/// - A TimelockController with a 24h delay owns ScreeningGate, RelayAdapt, AssetGate,
///   BroadcasterBond and Guardian. Proposers: the multisig and CrtnStaking (passed governor
///   votes). Cancellers: the same, so the multisig can veto a queued vote. Executor: anyone,
///   after the delay. No admin, so nobody can bypass the delay.
/// - CurtainPool reads its fee from CrtnStaking (clamped to 10-30 bps) and its shield pause
///   from Guardian; it has no owner. Its `treasury` is CrtnStaking, which splits fees 60/40.
/// - Guardian's pause key (GUARDIAN_ADDR) can pause shield and relay only.
///
/// Writes deployments/<chainid>.json with every address and its code hash; Pin.s.sol checks
/// a live deployment against that file.
///
/// Addresses live in storage rather than locals to stay clear of "stack too deep".
contract DeployScript is Script {
    uint256 internal constant RHC_CHAIN_ID = 4663;
    uint256 internal constant TIMELOCK_DELAY = 24 hours;
    // Anvil account #0 — public, well-known, for local chains only (never used on 4663).
    uint256 internal constant ANVIL_DEV_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    bool public production;
    address public deployer;
    address public multisig;
    address public guardianKey;
    address public treasury;
    address public communityBucket;
    address public teamBucket;
    address public backersBucket;
    address public subsidiesBucket;

    address public hasherT2;
    address public hasherT3;
    address public hasherT5;

    address public verifierAdapterJoinSplit2x2;
    address public verifierAdapterJoinSplit3x3;
    address public verifierAdapterUnshield;
    address public verifierAdapterPpoi;
    address public verifierAdapterSolvency;

    AssetGate public assetGate;
    address public usdg;
    address[] public stockTokens;

    CRTN public crtn;
    CrtnStaking public staking;
    TimelockController public timelock;
    Guardian public guardian;

    ScreeningGate public gate;
    DisclosureRegistry public disclosure;
    ERC2771Forwarder public forwarder;
    CurtainPool public pool;
    RelayAdapt public adapt;
    SolvencyVerifier public solvencyVerifier;

    StealthRegistry public stealthRegistry;
    StealthAnnouncer public stealthAnnouncer;

    BroadcasterBond public bond;

    function run() external {
        production = block.chainid == RHC_CHAIN_ID;
        uint256 deployerPrivateKey = production ? vm.envUint("PRIVATE_KEY") : vm.envOr("PRIVATE_KEY", ANVIL_DEV_KEY);
        deployer = vm.addr(deployerPrivateKey);

        if (production) {
            multisig = vm.envAddress("MULTISIG_ADDR");
            guardianKey = vm.envAddress("GUARDIAN_ADDR");
            treasury = vm.envAddress("TREASURY_ADDR");
            communityBucket = vm.envAddress("COMMUNITY_BUCKET");
            teamBucket = vm.envAddress("TEAM_BUCKET");
            backersBucket = vm.envAddress("BACKERS_BUCKET");
            subsidiesBucket = vm.envAddress("SUBSIDIES_BUCKET");
            require(multisig.code.length > 0, "DeployScript: MULTISIG_ADDR must be a deployed Safe");
        } else {
            // Short literals are placeholders for local chains only.
            multisig = vm.envOr("MULTISIG_ADDR", deployer);
            guardianKey = vm.envOr("GUARDIAN_ADDR", deployer);
            treasury = vm.envOr("TREASURY_ADDR", address(0x7EA5));
            communityBucket = vm.envOr("COMMUNITY_BUCKET", address(0xC001));
            teamBucket = vm.envOr("TEAM_BUCKET", address(0x7EA7));
            backersBucket = vm.envOr("BACKERS_BUCKET", address(0xBAC0));
            subsidiesBucket = vm.envOr("SUBSIDIES_BUCKET", address(0x5080));
        }

        vm.startBroadcast(deployerPrivateKey);

        _deployHashers();
        _deployVerifiers();
        _deployAssetGateAndTokens();
        _deployCrtnStakingAndTimelock();
        _deployPoolStack();
        _deployStealth();
        _deployBroadcasterBond();
        _transferOwnershipToTimelock();

        vm.stopBroadcast();

        _writeDeployment();
        _logSummary();
    }

    function _deployHashers() internal {
        hasherT2 = address(new PoseidonT2Deployer());
        hasherT3 = address(new PoseidonT3Deployer());
        hasherT5 = address(new PoseidonT5Deployer());
    }

    function _deployVerifiers() internal {
        address v2x2 = production ? vm.envAddress("JOINSPLIT2X2_VERIFIER_ADDR") : address(new JoinSplit2x2Groth16Verifier());
        address v3x3 = production ? vm.envAddress("JOINSPLIT3X3_VERIFIER_ADDR") : address(new JoinSplit3x3Groth16Verifier());
        address vUnshield = production ? vm.envAddress("UNSHIELD_VERIFIER_ADDR") : address(new UnshieldGroth16Verifier());
        address vPpoi = production ? vm.envAddress("PPOI_VERIFIER_ADDR") : address(new PpoiDevGroth16Verifier());
        address vSolvency = production ? vm.envAddress("SOLVENCY_VERIFIER_ADDR") : address(new SolvencyGroth16Verifier());
        if (production) {
            require(v2x2.code.length > 0 && v3x3.code.length > 0 && vUnshield.code.length > 0, "DeployScript: missing verifier");
            require(vPpoi.code.length > 0 && vSolvency.code.length > 0, "DeployScript: missing verifier");
        }

        verifierAdapterJoinSplit2x2 = address(new JoinSplit2x2VerifierAdapter(v2x2));
        verifierAdapterJoinSplit3x3 = address(new JoinSplit3x3VerifierAdapter(v3x3));
        verifierAdapterUnshield = address(new UnshieldVerifierAdapter(vUnshield));
        verifierAdapterPpoi = address(new PpoiDevVerifierAdapter(vPpoi));
        verifierAdapterSolvency = address(new SolvencyVerifierAdapter(vSolvency));
    }

    function _deployAssetGateAndTokens() internal {
        assetGate = new AssetGate(deployer);

        usdg = _token("USDG_ADDR", "USD Global", "USDG");
        assetGate.register(usdg, false, vm.envOr("USDG_FEED", address(0)));

        stockTokens.push(_token("NVDA_ADDR", "NVIDIA Stock Token", "NVDA"));
        stockTokens.push(_token("TSLA_ADDR", "Tesla Stock Token", "TSLA"));
        stockTokens.push(_token("SPY_ADDR", "S&P 500 ETF", "SPY"));
        stockTokens.push(_token("QQQ_ADDR", "Invesco QQQ Trust", "QQQ"));
        stockTokens.push(_token("HOOD_ADDR", "Robinhood Markets Inc", "HOOD"));
        for (uint256 i = 0; i < stockTokens.length; i++) {
            assetGate.register(stockTokens[i], true, address(0));
        }
    }

    /// @dev Real token from env on 4663; a fresh MockERC20 on local chains.
    function _token(string memory envKey, string memory name, string memory symbol) internal returns (address token) {
        if (production) {
            token = vm.envAddress(envKey);
            require(token.code.length > 0, string.concat("DeployScript: no code at ", envKey));
        } else {
            token = address(new MockERC20(name, symbol));
        }
    }

    /// @dev Staking before the pool (it is the pool's treasury and fee source) and before the
    /// timelock (it is one of the timelock's proposers).
    function _deployCrtnStakingAndTimelock() internal {
        crtn = new CRTN(communityBucket, teamBucket, backersBucket, subsidiesBucket);
        staking = new CrtnStaking(address(crtn), treasury);

        address[] memory proposers = new address[](2);
        proposers[0] = multisig;
        proposers[1] = address(staking);
        address[] memory executors = new address[](1); // address(0): anyone executes after the delay
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));
        staking.setTimelock(address(timelock));

        guardian = new Guardian(deployer, guardianKey);
    }

    function _deployPoolStack() internal {
        gate = new ScreeningGate(
            PoseidonT2Deployer(hasherT2).hasher(), PoseidonT3Deployer(hasherT3).hasher(), verifierAdapterPpoi, deployer
        );

        disclosure = new DisclosureRegistry();

        // Unmodified OpenZeppelin ERC2771Forwarder: CurtainPool's sole trusted forwarder for
        // gasless `shieldMeta` bundles (see CurtainPool.sol's header).
        forwarder = new ERC2771Forwarder("Curtain");

        // RelayAdapt lands at nonce+1, right after CurtainPool — baked into the pool's
        // constructor so the pool needs no setter (see CurtainPool.sol's header).
        address predictedRelayAdapt = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);

        pool = new CurtainPool(
            PoseidonT3Deployer(hasherT3).hasher(),
            PoseidonT5Deployer(hasherT5).hasher(),
            address(assetGate),
            address(gate),
            verifierAdapterJoinSplit2x2,
            verifierAdapterJoinSplit3x3,
            verifierAdapterUnshield,
            predictedRelayAdapt,
            address(staking), // treasury: CrtnStaking splits fees 60/40
            address(staking), // fee source: governed fee, clamped by the pool
            20, // default 0.20%
            address(forwarder),
            address(guardian)
        );

        adapt = new RelayAdapt(address(pool), deployer);
        require(address(adapt) == predictedRelayAdapt, "DeployScript: predicted RelayAdapt address mismatch");

        // One-time bootstrap while `deployer` still owns the gate.
        gate.setPool(address(pool));

        solvencyVerifier = new SolvencyVerifier(address(pool), verifierAdapterSolvency);
    }

    function _deployStealth() internal {
        stealthRegistry = new StealthRegistry();
        stealthAnnouncer = new StealthAnnouncer();
    }

    function _deployBroadcasterBond() internal {
        bond = new BroadcasterBond(address(crtn), treasury, deployer);
    }

    /// @dev Last step: after it, the deployer owns nothing. Providers, relay targets and
    /// broadcaster attestors are then added through the timelock (multisig or governors).
    function _transferOwnershipToTimelock() internal {
        gate.transferOwnership(address(timelock));
        adapt.transferOwnership(address(timelock));
        assetGate.transferOwnership(address(timelock));
        bond.transferOwnership(address(timelock));
        guardian.transferOwnership(address(timelock));
    }

    function _writeDeployment() internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeBool(k, "production", production);
        vm.serializeAddress(k, "deployer", deployer);
        vm.serializeAddress(k, "multisig", multisig);
        vm.serializeAddress(k, "guardianKey", guardianKey);
        vm.serializeAddress(k, "usdg", usdg);
        vm.serializeAddress(k, "stockTokens", stockTokens);
        string memory contracts_ = _serializeContracts();
        string memory json = vm.serializeString(k, "contracts", contracts_);
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
    }

    function _serializeContracts() internal returns (string memory json) {
        string[15] memory names = [
            "CurtainPool", "RelayAdapt", "ScreeningGate", "AssetGate", "Guardian", "TimelockController",
            "CrtnStaking", "CRTN", "BroadcasterBond", "SolvencyVerifier", "DisclosureRegistry",
            "StealthRegistry", "StealthAnnouncer", "ERC2771Forwarder", "PpoiVerifierAdapter"
        ];
        address[15] memory addrs = [
            address(pool), address(adapt), address(gate), address(assetGate), address(guardian), address(timelock),
            address(staking), address(crtn), address(bond), address(solvencyVerifier), address(disclosure),
            address(stealthRegistry), address(stealthAnnouncer), address(forwarder), verifierAdapterPpoi
        ];
        for (uint256 i = 0; i < names.length; i++) {
            string memory entry = names[i];
            vm.serializeAddress(entry, "address", addrs[i]);
            string memory entryJson = vm.serializeBytes32(entry, "codehash", addrs[i].codehash);
            json = vm.serializeString("contracts", names[i], entryJson);
        }
    }

    function _logSummary() internal view {
        console.log("--- CURTAIN DEPLOYMENT SUMMARY ---");
        console.log("Mode:              ", production ? "production (4663)" : "local/dev");
        console.log("CurtainPool:       ", address(pool));
        console.log("RelayAdapt:        ", address(adapt));
        console.log("ScreeningGate:     ", address(gate));
        console.log("AssetGate:         ", address(assetGate));
        console.log("Guardian:          ", address(guardian));
        console.log("Timelock (24h):    ", address(timelock));
        console.log("CrtnStaking:       ", address(staking));
        console.log("CRTN Token:        ", address(crtn));
        console.log("BroadcasterBond:   ", address(bond));
        console.log("SolvencyVerifier:  ", address(solvencyVerifier));
        console.log("DisclosureRegistry:", address(disclosure));
        console.log("StealthRegistry:   ", address(stealthRegistry));
        console.log("StealthAnnouncer:  ", address(stealthAnnouncer));
        console.log("ERC2771Forwarder:  ", address(forwarder));
        console.log("USDG Token:        ", usdg);
        console.log("Wrote deployments/<chainid>.json; verify with: forge script script/Pin.s.sol");
    }
}
