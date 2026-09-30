// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurtainPool} from "../../src/pool/CurtainPool.sol";
import {AssetGate} from "../../src/config/AssetGate.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {MockScreeningGate} from "../mocks/MockScreeningGate.sol";
import {MockJoinSplitVerifier} from "../mocks/MockJoinSplitVerifier.sol";
import {MockUnshieldVerifier} from "../mocks/MockUnshieldVerifier.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {PoseidonT3Deployer} from "../../src/lib/PoseidonT3.sol";
import {PoseidonT5Deployer} from "../../src/lib/PoseidonT5.sol";

/// @notice Post-M12 acceptance test for `shieldMeta` (Curtain_Build.md §11 item 22's
/// forwarder gap, resolved): proves a real gasless shield via ERC2771Forwarder correctly
/// binds `originOf` (and pulls tokens from) the REAL SIGNER, never the forwarder contract or
/// the relayer that pays gas — the exact property a naive forwarder-holds-funds design would
/// have broken (see CurtainPool.sol's header).
contract CurtainPoolMetaTxTest is Test {
    uint16 internal constant FEE_BPS = 20;

    CurtainPool internal pool;
    AssetGate internal assetGate;
    ERC2771Forwarder internal forwarder;
    MockERC20 internal token;

    uint256 internal alicePk = 0xA11CE;
    address internal alice;
    address internal relayer = address(0x1234567890123456789012345678901234567890);
    address internal treasury = address(0x7EA5);

    bytes32 internal constant FORWARD_REQUEST_TYPEHASH =
        keccak256("ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)");

    function setUp() public {
        alice = vm.addr(alicePk);

        address hasherT3 = PoseidonT3Deployer(address(new PoseidonT3Deployer())).hasher();
        address hasherT5 = PoseidonT5Deployer(address(new PoseidonT5Deployer())).hasher();

        assetGate = new AssetGate(address(this));
        MockScreeningGate gate = new MockScreeningGate();
        MockJoinSplitVerifier joinSplitVer = new MockJoinSplitVerifier();
        MockUnshieldVerifier unshieldVer = new MockUnshieldVerifier();

        forwarder = new ERC2771Forwarder("Curtain");

        token = new MockERC20("USD Global", "USDG");
        assetGate.register(address(token), false, address(0));

        pool = new CurtainPool(
            hasherT3,
            hasherT5,
            address(assetGate),
            address(gate),
            address(joinSplitVer),
            address(joinSplitVer),
            address(unshieldVer),
            address(0),
            treasury,
            FEE_BPS,
            FEE_BPS,
            address(forwarder)
        );

        token.mint(alice, 1_000 ether);
        // Alice approves the POOL directly — not the forwarder — since _msgSender()
        // resolves to Alice inside shield(), and safeTransferFrom pulls from _msgSender().
        vm.prank(alice);
        token.approve(address(pool), type(uint256).max);
    }

    function _signAndBuildRequest(uint256 signerPk, address from, bytes memory data)
        internal
        view
        returns (ERC2771Forwarder.ForwardRequestData memory req)
    {
        uint256 nonce = forwarder.nonces(from);
        uint48 deadline = uint48(block.timestamp + 1 hours);

        bytes32 structHash = keccak256(
            abi.encode(FORWARD_REQUEST_TYPEHASH, from, address(pool), uint256(0), uint256(3_000_000), nonce, deadline, keccak256(data))
        );

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Curtain")),
                keccak256(bytes("1")),
                block.chainid,
                address(forwarder)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);

        req = ERC2771Forwarder.ForwardRequestData({
            from: from,
            to: address(pool),
            value: 0,
            gas: 3_000_000,
            deadline: deadline,
            data: data,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function test_shieldMeta_originBindsToRealSigner_notForwarderOrRelayer() public {
        bytes memory shieldCalldata = abi.encodeWithSelector(
            CurtainPool.shield.selector,
            address(token),
            100 ether,
            uint256(111),
            uint256(222),
            bytes(""),
            bytes("")
        );
        ERC2771Forwarder.ForwardRequestData memory req = _signAndBuildRequest(alicePk, alice, shieldCalldata);

        uint256 aliceBalanceBefore = token.balanceOf(alice);

        // A DIFFERENT address (the relayer) submits the meta-tx and pays gas — Alice never
        // sends a transaction herself.
        vm.prank(relayer);
        forwarder.execute(req);

        // Tokens were pulled from ALICE (the real signer), not the relayer or the forwarder.
        assertEq(token.balanceOf(alice), aliceBalanceBefore - 100 ether);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(token.balanceOf(address(forwarder)), 0);

        // originOf() must resolve to Alice — the critical property: a naive forwarder that
        // held funds and called shield() itself would have bound this to the forwarder's own
        // address instead, permanently misdirecting unshieldToOrigin's payout.
        uint256 fee = (100 ether * FEE_BPS) / 10000;
        bytes32 commit = bytes32(
            pool.commitHasher().poseidon([pool.tokenIdOf(address(token)), 100 ether - fee, uint256(111), uint256(222)])
        );
        assertEq(pool.originOf(commit), alice);
        assertNotEq(pool.originOf(commit), relayer);
        assertNotEq(pool.originOf(commit), address(forwarder));
    }

    function test_shieldMeta_unshieldToOriginPaysRealSigner_notRelayer() public {
        bytes memory shieldCalldata = abi.encodeWithSelector(
            CurtainPool.shield.selector, address(token), 100 ether, uint256(333), uint256(444), bytes(""), bytes("")
        );
        ERC2771Forwarder.ForwardRequestData memory req = _signAndBuildRequest(alicePk, alice, shieldCalldata);

        vm.prank(relayer);
        forwarder.execute(req);

        uint256 fee = (100 ether * FEE_BPS) / 10000;
        uint256 netAmount = 100 ether - fee;
        bytes32 commit = bytes32(
            pool.commitHasher().poseidon([pool.tokenIdOf(address(token)), netAmount, uint256(333), uint256(444)])
        );

        uint256 nullifier = 999; // MockUnshieldVerifier ignores proof content entirely
        uint256 aliceBalanceBeforeExit = token.balanceOf(alice);
        uint256 relayerBalanceBefore = token.balanceOf(relayer);

        // Any caller may submit unshieldToOrigin — but it must ALWAYS pay Alice, the real
        // depositor, never whoever happens to call it (here: the relayer, calling directly,
        // no meta-tx involved on this leg).
        vm.prank(relayer);
        pool.unshieldToOrigin(commit, address(token), netAmount, 333, 444, nullifier, hex"");

        uint256 unshieldFee = (netAmount * FEE_BPS) / 10000;
        assertEq(token.balanceOf(alice), aliceBalanceBeforeExit + netAmount - unshieldFee);
        assertEq(token.balanceOf(relayer), relayerBalanceBefore); // relayer gets nothing
    }

    function test_shieldMeta_revertsOnReplayedRequest() public {
        bytes memory shieldCalldata = abi.encodeWithSelector(
            CurtainPool.shield.selector, address(token), 10 ether, uint256(1), uint256(2), bytes(""), bytes("")
        );
        ERC2771Forwarder.ForwardRequestData memory req = _signAndBuildRequest(alicePk, alice, shieldCalldata);

        forwarder.execute(req);
        vm.expectRevert();
        forwarder.execute(req); // same nonce, already consumed
    }

    function test_directCall_stillWorksWithoutForwarder() public {
        // A user who doesn't want gasless meta-tx can still call shield() directly — the
        // forwarder is additive, not a replacement for the ordinary path.
        vm.prank(alice);
        (bytes32 commit, ) = pool.shield(address(token), 50 ether, 5, 6, hex"", hex"");
        assertEq(pool.originOf(commit), alice);
    }
}
