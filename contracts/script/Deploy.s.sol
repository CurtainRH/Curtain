// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CurtainPool} from "../src/pool/CurtainPool.sol";
import {AssetGate} from "../src/config/AssetGate.sol";
import {ScreeningGate} from "../src/gate/ScreeningGate.sol";
import {RelayAdapt} from "../src/adapt/RelayAdapt.sol";
import {BroadcasterBond} from "../src/broadcast/BroadcasterBond.sol";
import {StealthRegistry} from "../src/stealth/StealthRegistry.sol";
import {StealthAnnouncer} from "../src/stealth/StealthAnnouncer.sol";
import {DisclosureRegistry} from "../src/disclosure/DisclosureRegistry.sol";
import {SolvencyVerifier} from "../src/solvency/SolvencyVerifier.sol";
import {CRTN} from "../src/token/CRTN.sol";
import {CrtnStaking} from "../src/staking/CrtnStaking.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

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

/// @notice Curtain Protocol full deployment script per Runbook §7 (M12).
///
/// Deployed addresses are held in STORAGE (state variables), not local
/// stack variables — a single `run()` (or even a handful of helpers each
/// returning several values) holding ~20 live locals simultaneously hits
/// solc's "stack too deep" limit. Storage writes don't consume EVM stack
/// slots, so this sidesteps the limit entirely. `via_ir` would also fix
/// this, but as a project-wide toggle it changes codegen for every
/// contract, not just this script — storage-based state is the narrower,
/// safer fix for a one-shot deploy script with no ABI/gas surface to
/// worry about.
///
/// TWO BUGS FOUND AND FIXED HERE (see Curtain_Build.md §11): this script
/// originally (a) never transferred ScreeningGate/RelayAdapt ownership to
/// CrtnStaking, so every governance proposal's execution would revert
/// forever against a freshly-deployed protocol (CrtnStaking would never
/// actually own the contracts it's supposed to govern), and (b) never
/// pointed CurtainPool's `treasury` at CrtnStaking, so the 60/40 fee
/// split described in Curtain_Build.md §3.9 was fully implemented and
/// tested in CrtnStaking.sol in isolation but never actually reachable —
/// 100% of every shield/unshield fee went straight to a plain EOA
/// forever, exactly as before M11 existed. Both are fixed below:
/// CurtainPool's `treasury` constructor arg is now `address(staking)`
/// (a plain ERC-20 `transfer` to a contract works identically to one to
/// an EOA — CurtainPool needs no code changes at all, preserving its
/// immutability guarantee completely untouched), and ScreeningGate/
/// RelayAdapt ownership is transferred to `staking` as the final step,
/// after the one-time `gate.setPool()` bootstrap that only the deployer
/// (not yet-transferred-away owner) can perform.
contract DeployScript is Script {
    address public deployer;

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

    CRTN public crtn;
    CrtnStaking public staking;

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
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        deployer = vm.addr(deployerPrivateKey);

        // Short hex literals (not 40 digits) are placeholder/vanity
        // addresses only, meant to be overridden via env vars for any real
        // deployment — same convention as the test suites' treasury/alice
        // placeholders. A full 40-digit literal here would need to be a
        // real EIP-55 checksummed address or solc rejects it at compile
        // time; short literals sidestep that checksum requirement entirely.
        treasury = vm.envOr("TREASURY_ADDR", address(0x7EA5));
        communityBucket = vm.envOr("COMMUNITY_BUCKET", address(0xC001));
        teamBucket = vm.envOr("TEAM_BUCKET", address(0x7EA7));
        backersBucket = vm.envOr("BACKERS_BUCKET", address(0xBAC0));
        subsidiesBucket = vm.envOr("SUBSIDIES_BUCKET", address(0x5080));

        vm.startBroadcast(deployerPrivateKey);

        _deployHashers();
        _deployVerifiers();
        _deployAssetGateAndTokens();
        _deployCrtnAndStaking();
        _deployPoolStack();
        _deployStealth();
        _deployBroadcasterBond();
        _transferGovernanceOwnership();

        vm.stopBroadcast();

        _logSummary();
    }

    function _deployHashers() internal {
        hasherT2 = address(new PoseidonT2Deployer());
        hasherT3 = address(new PoseidonT3Deployer());
        hasherT5 = address(new PoseidonT5Deployer());
    }

    function _deployVerifiers() internal {
        address v2x2Raw = address(new JoinSplit2x2Groth16Verifier());
        verifierAdapterJoinSplit2x2 = address(new JoinSplit2x2VerifierAdapter(v2x2Raw));

        address v3x3Raw = address(new JoinSplit3x3Groth16Verifier());
        verifierAdapterJoinSplit3x3 = address(new JoinSplit3x3VerifierAdapter(v3x3Raw));

        address vUnshieldRaw = address(new UnshieldGroth16Verifier());
        verifierAdapterUnshield = address(new UnshieldVerifierAdapter(vUnshieldRaw));

        address vPpoiRaw = address(new PpoiDevGroth16Verifier());
        verifierAdapterPpoi = address(new PpoiDevVerifierAdapter(vPpoiRaw));

        address vSolvencyRaw = address(new SolvencyGroth16Verifier());
        verifierAdapterSolvency = address(new SolvencyVerifierAdapter(vSolvencyRaw));
    }

    function _deployAssetGateAndTokens() internal {
        assetGate = new AssetGate(deployer);

        usdg = address(new MockERC20("USD Global", "USDG"));
        assetGate.register(usdg, false, address(0));

        address nvda = address(new MockERC20("NVIDIA Stock Token", "NVDA"));
        assetGate.register(nvda, true, address(0));

        address tsla = address(new MockERC20("Tesla Stock Token", "TSLA"));
        assetGate.register(tsla, true, address(0));

        address spy = address(new MockERC20("S&P 500 ETF", "SPY"));
        assetGate.register(spy, true, address(0));

        address qqq = address(new MockERC20("Invesco QQQ Trust", "QQQ"));
        assetGate.register(qqq, true, address(0));

        address hood = address(new MockERC20("Robinhood Markets Inc", "HOOD"));
        assetGate.register(hood, true, address(0));
    }

    /// @dev Deployed BEFORE CurtainPool (deviating from the original draft's order) because
    /// CurtainPool's constructor needs `address(staking)` as its `treasury` argument — see
    /// this file's header on the fee-routing fix.
    function _deployCrtnAndStaking() internal {
        crtn = new CRTN(communityBucket, teamBucket, backersBucket, subsidiesBucket);
        staking = new CrtnStaking(address(crtn), treasury);
    }

    function _deployPoolStack() internal {
        gate = new ScreeningGate(
            PoseidonT2Deployer(hasherT2).hasher(),
            PoseidonT3Deployer(hasherT3).hasher(),
            verifierAdapterPpoi,
            deployer
        );

        disclosure = new DisclosureRegistry();

        // Unmodified deployment of OpenZeppelin's audited ERC2771Forwarder — CurtainPool's
        // sole trusted forwarder for gasless `shieldMeta` bundles (see CurtainPool.sol's
        // header on why this preserves origin-binding security instead of a naive
        // forwarder-holds-funds design).
        forwarder = new ERC2771Forwarder("Curtain");

        // Predict RelayAdapt's address (deployed right after CurtainPool, at
        // nonce+1) so it can be baked into CurtainPool's constructor with no
        // mutable setter — see CurtainPool.sol's header.
        uint256 currentNonce = vm.getNonce(deployer);
        address predictedRelayAdapt = vm.computeCreateAddress(deployer, currentNonce + 1);

        pool = new CurtainPool(
            PoseidonT3Deployer(hasherT3).hasher(),
            PoseidonT5Deployer(hasherT5).hasher(),
            address(assetGate),
            address(gate),
            verifierAdapterJoinSplit2x2,
            verifierAdapterJoinSplit3x3,
            verifierAdapterUnshield,
            predictedRelayAdapt,
            address(staking), // fee-routing fix — see this file's header
            20, // 0.20% shield fee
            20, // 0.20% unshield fee
            address(forwarder)
        );

        adapt = new RelayAdapt(address(pool), deployer);
        require(address(adapt) == predictedRelayAdapt, "DeployScript: predicted RelayAdapt address mismatch");

        // One-time bootstrap — must happen while `deployer` is still the
        // owner, i.e. before _transferGovernanceOwnership() runs.
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

    /// @dev Governance ownership fix — see this file's header. Must run after
    /// `gate.setPool()` (which needs `deployer` to still be the owner).
    function _transferGovernanceOwnership() internal {
        gate.transferOwnership(address(staking));
        adapt.transferOwnership(address(staking));
    }

    function _logSummary() internal view {
        console.log("--- CURTAIN DEPLOYMENT SUMMARY ---");
        console.log("CurtainPool:       ", address(pool));
        console.log("AssetGate:         ", address(assetGate));
        console.log("ScreeningGate:     ", address(gate));
        console.log("RelayAdapt:        ", address(adapt));
        console.log("DisclosureRegistry:", address(disclosure));
        console.log("ERC2771Forwarder:  ", address(forwarder));
        console.log("SolvencyVerifier:  ", address(solvencyVerifier));
        console.log("StealthRegistry:   ", address(stealthRegistry));
        console.log("StealthAnnouncer:  ", address(stealthAnnouncer));
        console.log("CRTN Token:        ", address(crtn));
        console.log("CrtnStaking:       ", address(staking));
        console.log("BroadcasterBond:   ", address(bond));
        console.log("USDG Token:        ", usdg);
        console.log("Fee treasury (CurtainPool -> CrtnStaking -> 60/40 split):", address(staking));
    }
}
