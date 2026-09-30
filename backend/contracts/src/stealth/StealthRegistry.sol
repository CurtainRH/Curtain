// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice ERC-6538 Stealth Meta-Address Registry, implemented verbatim from the EIP —
/// no Curtain-specific fields. Lets any account register a stealth meta-address per
/// scheme id, either directly or on behalf of another account via an EIP-712 signature.
contract StealthRegistry {
    /// @dev registrant => schemeId => stealth meta-address bytes.
    mapping(address => mapping(uint256 => bytes)) public stealthMetaAddressOf;

    /// @dev registrant => nonce, incremented on each `registerKeysOnBehalf` call.
    mapping(address => uint256) public nonceOf;

    event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress);

    error StealthRegistry__InvalidSignature();

    bytes32 public constant ERC6538REGISTRY_ENTRY_TYPE_HASH =
        keccak256("Erc6538RegistryEntry(uint256 schemeId,bytes stealthMetaAddress,uint256 nonce)");

    /// @notice Registers a stealth meta-address for `msg.sender` under `schemeId`.
    function registerKeys(uint256 schemeId, bytes memory stealthMetaAddress) external {
        stealthMetaAddressOf[msg.sender][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, schemeId, stealthMetaAddress);
    }

    /// @notice Registers a stealth meta-address on behalf of `registrant`, authorized by
    /// an EIP-712 signature (ECDSA or ERC-1271) over the current nonce.
    function registerKeysOnBehalf(
        address registrant,
        uint256 schemeId,
        bytes memory signature,
        bytes memory stealthMetaAddress
    ) external {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        ERC6538REGISTRY_ENTRY_TYPE_HASH,
                        schemeId,
                        keccak256(stealthMetaAddress),
                        nonceOf[registrant]
                    )
                )
            )
        );

        if (!SignatureChecker.isValidSignatureNow(registrant, digest, signature)) {
            revert StealthRegistry__InvalidSignature();
        }

        unchecked {
            nonceOf[registrant]++;
        }

        stealthMetaAddressOf[registrant][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(registrant, schemeId, stealthMetaAddress);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("StealthRegistry")),
                keccak256(bytes("1.0")),
                block.chainid,
                address(this)
            )
        );
    }
}
