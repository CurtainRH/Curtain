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
contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(deployerPrivateKey);

        address treasury = vm.envOr("TREASURY_ADDR", address(0x7EA5000000000000000000000000000000000000));
        address community = vm.envOr("COMMUNITY_BUCKET", address(0xC001000000000000000000000000000000000000));
        address team = vm.envOr("TEAM_BUCKET", address(0x7EA7000000000000000000000000000000000000));
        address backers = vm.envOr("BACKERS_BUCKET", address(0xBAC000000000000000000000000000000000000));
        address subsidies = vm.envOr("SUBSIDIES_BUCKET", address(0x5080000000000000000000000000000000000000));

        vm.startBroadcast(deployerPrivateKey);

        // 1. Poseidon Hasher deployers
        address poseidonT2 = address(new PoseidonT2Deployer());
        address poseidonT3 = address(new PoseidonT3Deployer());
        address poseidonT5 = address(new PoseidonT5Deployer());

        // 2. Groth16 Verifiers & Adapters
        address v2x2Raw = address(new JoinSplit2x2Groth16Verifier());
        address v2x2Adapter = address(new JoinSplit2x2VerifierAdapter(v2x2Raw));

        address v3x3Raw = address(new JoinSplit3x3Groth16Verifier());
        address v3x3Adapter = address(new JoinSplit3x3VerifierAdapter(v3x3Raw));

        address vUnshieldRaw = address(new UnshieldGroth16Verifier());
        address vUnshieldAdapter = address(new UnshieldVerifierAdapter(vUnshieldRaw));

        address vPpoiRaw = address(new PpoiDevGroth16Verifier());
        address vPpoiAdapter = address(new PpoiDevVerifierAdapter(vPpoiRaw));

        address vSolvencyRaw = address(new SolvencyGroth16Verifier());
        address vSolvencyAdapter = address(new SolvencyVerifierAdapter(vSolvencyRaw));

        // 3. AssetGate & Token Registration
        AssetGate assetGate = new AssetGate(deployer);

        MockERC20 usdg = new MockERC20("USD Global", "USDG");
        assetGate.register(address(usdg), false, address(0));

        MockERC20 nvda = new MockERC20("NVIDIA Stock Token", "NVDA");
        assetGate.register(address(nvda), true, address(0));

        MockERC20 tsla = new MockERC20("Tesla Stock Token", "TSLA");
        assetGate.register(address(tsla), true, address(0));

        MockERC20 spy = new MockERC20("S&P 500 ETF", "SPY");
        assetGate.register(address(spy), true, address(0));

        MockERC20 qqq = new MockERC20("Invesco QQQ Trust", "QQQ");
        assetGate.register(address(qqq), true, address(0));

        MockERC20 hood = new MockERC20("Robinhood Markets Inc", "HOOD");
        assetGate.register(address(hood), true, address(0));

        // 4. ScreeningGate
        ScreeningGate gate = new ScreeningGate(
            PoseidonT2Deployer(poseidonT2).hasher(),
            PoseidonT3Deployer(poseidonT3).hasher(),
            vPpoiAdapter,
            deployer
        );

        // 5. DisclosureRegistry
        DisclosureRegistry disclosure = new DisclosureRegistry();

        // 6. Predict RelayAdapt address for CurtainPool constructor
        uint256 currentNonce = vm.getNonce(deployer);
        address predictedRelayAdapt = vm.computeCreateAddress(deployer, currentNonce + 1);

        // 7. CurtainPool (Zero admin functions, fee 20 BPS shield/unshield)
        CurtainPool pool = new CurtainPool(
            PoseidonT3Deployer(poseidonT3).hasher(),
            PoseidonT5Deployer(poseidonT5).hasher(),
            address(assetGate),
            address(gate),
            v2x2Adapter,
            v3x3Adapter,
            vUnshieldAdapter,
            predictedRelayAdapt,
            treasury,
            20, // 0.20% shield fee
            20  // 0.20% unshield fee
        );

        // 8. RelayAdapt
        RelayAdapt adapt = new RelayAdapt(address(pool), deployer);
        require(address(adapt) == predictedRelayAdapt, "DeployScript: predicted RelayAdapt address mismatch");

        // 9. Link ScreeningGate to CurtainPool
        gate.setPool(address(pool));

        // 10. SolvencyVerifier
        SolvencyVerifier solvencyVerifier = new SolvencyVerifier(address(pool), vSolvencyAdapter);

        // 11. Stealth Registry & Announcer
        StealthRegistry stealthRegistry = new StealthRegistry();
        StealthAnnouncer stealthAnnouncer = new StealthAnnouncer();

        // 12. $CRTN Token, Staking & BroadcasterBond
        CRTN crtn = new CRTN(community, team, backers, subsidies);
        CrtnStaking staking = new CrtnStaking(address(crtn), treasury);
        BroadcasterBond bond = new BroadcasterBond(address(crtn), treasury, deployer);

        vm.stopBroadcast();

        console.log("--- CURTAIN DEPLOYMENT SUMMARY ---");
        console.log("CurtainPool:       ", address(pool));
        console.log("AssetGate:         ", address(assetGate));
        console.log("ScreeningGate:     ", address(gate));
        console.log("RelayAdapt:        ", address(adapt));
        console.log("DisclosureRegistry:", address(disclosure));
        console.log("SolvencyVerifier:  ", address(solvencyVerifier));
        console.log("StealthRegistry:   ", address(stealthRegistry));
        console.log("StealthAnnouncer:  ", address(stealthAnnouncer));
        console.log("CRTN Token:        ", address(crtn));
        console.log("CrtnStaking:       ", address(staking));
        console.log("BroadcasterBond:   ", address(bond));
        console.log("USDG Token:        ", address(usdg));
    }
}
