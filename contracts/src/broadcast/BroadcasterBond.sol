// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Broadcaster bonding/slashing per Curtain_Build.md §3.4. Anyone
/// can become a broadcaster by bonding >= MIN_BOND of the governance
/// token; the bonded set (`bondedBroadcasters()`) is what off-chain clients
/// use to compute a bundle's random assignee (§4.1) — that computation
/// itself is off-chain (deterministic given public on-chain state), not
/// something this contract needs to do.
///
/// TOKEN CHOICE (M7): the constructor takes any ERC-20 as `bondToken`
/// rather than hardcoding CRTN, since CRTN itself doesn't exist until M11
/// (Curtain_Build.md's milestone table — CrtnStaking). Whatever token gets
/// deployed at M11 plugs in here unchanged; this contract has no opinion
/// on CRTN's own tokenomics, only that bonders post *some* slashable,
/// governance-relevant stake.
///
/// SLASHING (M7 design decision — spec's `slash(...)` pseudocode doesn't
/// define what an "attestor" is): slashing requires a threshold of EIP-712
/// signatures from an owner-managed attestor set over the exact
/// (broadcaster, amount, evidenceRoot) being slashed — same
/// EIP-712-over-ECDSA-or-ERC-1271 pattern StealthRegistry.sol already uses
/// for `registerKeysOnBehalf`. `evidenceRoot` itself is never interpreted
/// on-chain (it's a commitment to off-chain censorship evidence — bundle
/// hash, assignment timestamp, non-assignee's mined tx — verified by
/// attestors before they sign, not by this contract) and is marked used
/// once slashed, so the same evidence can't be replayed into a second
/// slash. `owner` (attestor management, fee cap enforcement aside) is
/// meant to become a TimelockController per the deploy runbook §7 step 9
/// and §3.9, same as AssetGate/RelayAdapt.
contract BroadcasterBond is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant MIN_BOND = 25_000 ether;
    uint16 public constant MAX_FEE_BPS = 30;
    uint64 public constant UNBOND_DELAY = 14 days;

    bytes32 public constant SLASH_TYPE_HASH =
        keccak256("SlashAttestation(address broadcaster,uint256 amount,bytes32 evidenceRoot)");

    IERC20 public immutable bondToken;
    address public immutable slashTreasury;

    struct Broadcaster {
        uint256 bonded;
        uint16 feeBps;
        uint16 gasMarkupBps;
        uint64 unbondRequestedAt; // 0 == not requested
        bool everActive; // true once bonded >= MIN_BOND at least once — gates setFees even mid-unbond
    }

    mapping(address => Broadcaster) public broadcasters;
    address[] internal _bondedList; // enumerable set of currently-active (bonded >= MIN_BOND, not unbonding) broadcasters
    mapping(address => uint256) internal _bondedListIndex; // broadcaster => index+1 in _bondedList (0 == absent)

    mapping(address => bool) public isAttestor;
    uint256 public attestorCount;
    uint256 public attestorThreshold;
    mapping(bytes32 => bool) public evidenceRootUsed;

    event Bonded(address indexed broadcaster, uint256 amount, uint256 totalBonded);
    event FeesSet(address indexed broadcaster, uint16 feeBps, uint16 gasMarkupBps);
    event UnbondRequested(address indexed broadcaster, uint64 availableAt);
    event Unbonded(address indexed broadcaster, uint256 amount);
    event Slashed(address indexed broadcaster, uint256 amount, bytes32 evidenceRoot);
    event AttestorSet(address indexed attestor, bool active);
    event AttestorThresholdSet(uint256 threshold);

    error BelowMinBond();
    error FeeTooHigh();
    error NotActive();
    error UnbondNotRequested();
    error UnbondStillLocked();
    error UnbondAlreadyRequested();
    error EvidenceAlreadyUsed();
    error InsufficientAttestations();
    error InvalidThreshold();

    constructor(address bondTokenAddr, address slashTreasuryAddr, address initialOwner) Ownable(initialOwner) {
        bondToken = IERC20(bondTokenAddr);
        slashTreasury = slashTreasuryAddr;
    }

    // ---- bonding ----

    function bond(uint256 amount) external {
        bondToken.safeTransferFrom(msg.sender, address(this), amount);

        Broadcaster storage b = broadcasters[msg.sender];
        b.bonded += amount;

        if (b.bonded >= MIN_BOND && _bondedListIndex[msg.sender] == 0 && b.unbondRequestedAt == 0) {
            b.everActive = true;
            _bondedList.push(msg.sender);
            _bondedListIndex[msg.sender] = _bondedList.length;
        }

        emit Bonded(msg.sender, amount, b.bonded);
    }

    function setFees(uint16 feeBps, uint16 gasMarkupBps) external {
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        Broadcaster storage b = broadcasters[msg.sender];
        if (!b.everActive) revert NotActive();
        b.feeBps = feeBps;
        b.gasMarkupBps = gasMarkupBps;
        emit FeesSet(msg.sender, feeBps, gasMarkupBps);
    }

    /// @notice Removes the caller from the assignable set immediately (no new bundles should
    /// target them) and starts the 14-day timelock before their bond can be withdrawn.
    function requestUnbond() external {
        Broadcaster storage b = broadcasters[msg.sender];
        if (b.bonded == 0) revert NotActive();
        if (b.unbondRequestedAt != 0) revert UnbondAlreadyRequested();

        b.unbondRequestedAt = uint64(block.timestamp);
        _removeFromBondedList(msg.sender);

        emit UnbondRequested(msg.sender, uint64(block.timestamp) + UNBOND_DELAY);
    }

    function unbond() external {
        Broadcaster storage b = broadcasters[msg.sender];
        if (b.unbondRequestedAt == 0) revert UnbondNotRequested();
        if (block.timestamp < b.unbondRequestedAt + UNBOND_DELAY) revert UnbondStillLocked();

        uint256 amount = b.bonded;
        delete broadcasters[msg.sender];
        bondToken.safeTransfer(msg.sender, amount);

        emit Unbonded(msg.sender, amount);
    }

    function bondedBroadcasters() external view returns (address[] memory) {
        return _bondedList;
    }

    function _removeFromBondedList(address broadcaster) internal {
        uint256 idxPlusOne = _bondedListIndex[broadcaster];
        if (idxPlusOne == 0) return;
        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = _bondedList.length - 1;
        address last = _bondedList[lastIdx];
        _bondedList[idx] = last;
        _bondedListIndex[last] = idx + 1;
        _bondedList.pop();
        delete _bondedListIndex[broadcaster];
    }

    // ---- attestors (owner-managed; see this file's header on slashing design) ----

    function setAttestor(address attestor, bool active) external onlyOwner {
        if (isAttestor[attestor] == active) return;
        isAttestor[attestor] = active;
        attestorCount = active ? attestorCount + 1 : attestorCount - 1;
        emit AttestorSet(attestor, active);
    }

    function setAttestorThreshold(uint256 threshold) external onlyOwner {
        if (threshold == 0 || threshold > attestorCount) revert InvalidThreshold();
        attestorThreshold = threshold;
        emit AttestorThresholdSet(threshold);
    }

    // ---- slashing ----

    /// @notice Slashes `amount` from `broadcaster`'s bond, given signatures from at least
    /// `attestorThreshold` distinct attestors over (broadcaster, amount, evidenceRoot).
    /// `attestors[i]` names who `attestorSigs[i]` claims to be — verified via
    /// SignatureChecker (ECDSA or ERC-1271, same as StealthRegistry.registerKeysOnBehalf),
    /// so a contract-account attestor works exactly like an EOA one. Permissionless to call —
    /// the security comes from the attestor signatures, not from who submits the transaction
    /// (same pattern as CurtainPool.markCleared()).
    function slash(
        address broadcaster,
        uint256 amount,
        bytes32 evidenceRoot,
        address[] calldata attestors,
        bytes[] calldata attestorSigs
    ) external {
        if (evidenceRootUsed[evidenceRoot]) revert EvidenceAlreadyUsed();
        if (attestors.length != attestorSigs.length) revert InsufficientAttestations();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(SLASH_TYPE_HASH, broadcaster, amount, evidenceRoot))
            )
        );

        uint256 validCount = 0;
        for (uint256 i = 0; i < attestors.length; i++) {
            if (!isAttestor[attestors[i]]) continue;
            if (!SignatureChecker.isValidSignatureNow(attestors[i], digest, attestorSigs[i])) continue;

            bool duplicate = false;
            for (uint256 j = 0; j < i; j++) {
                if (attestors[j] == attestors[i]) { duplicate = true; break; }
            }
            if (!duplicate) validCount++;
        }
        if (attestorThreshold == 0 || validCount < attestorThreshold) revert InsufficientAttestations();

        evidenceRootUsed[evidenceRoot] = true;

        Broadcaster storage b = broadcasters[broadcaster];
        uint256 slashAmount = amount > b.bonded ? b.bonded : amount;
        b.bonded -= slashAmount;
        if (b.bonded < MIN_BOND) _removeFromBondedList(broadcaster);

        if (slashAmount > 0) bondToken.safeTransfer(slashTreasury, slashAmount);

        emit Slashed(broadcaster, slashAmount, evidenceRoot);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("BroadcasterBond")),
                keccak256(bytes("1.0")),
                block.chainid,
                address(this)
            )
        );
    }
}
