// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice DisclosureRegistry per Curtain_Build.md §3.6 and §5.
/// Allows note owners to grant selective viewing access to auditors or counterparties
/// by registering an encrypted viewing key bound to a specific scope and optional expiration timestamp.
/// Revocation is forward-only (the viewer retains what was previously decrypted off-chain).
contract DisclosureRegistry {
    struct Grant {
        address granter;
        bytes32 scopeHash;
        bytes viewerEk;
        bytes encryptedVk;
        uint64 until;
        bool revoked;
    }

    uint256 private nonce;
    mapping(bytes32 => Grant) public grants;

    event GrantCreated(
        bytes32 indexed grantId,
        address indexed granter,
        bytes32 scopeHash,
        bytes viewerEk,
        bytes encryptedVk,
        uint64 until
    );
    event GrantRevoked(bytes32 indexed grantId, address indexed granter);

    error GrantNotFound();
    error NotGranter();
    error AlreadyRevoked();

    function grant(
        bytes32 scopeHash,
        bytes calldata viewerEk,
        bytes calldata encryptedVk,
        uint64 until
    ) external returns (bytes32 grantId) {
        grantId = keccak256(abi.encode(msg.sender, scopeHash, viewerEk, encryptedVk, until, nonce++));
        grants[grantId] = Grant({
            granter: msg.sender,
            scopeHash: scopeHash,
            viewerEk: viewerEk,
            encryptedVk: encryptedVk,
            until: until,
            revoked: false
        });

        emit GrantCreated(grantId, msg.sender, scopeHash, viewerEk, encryptedVk, until);
    }

    function revoke(bytes32 grantId) external {
        Grant storage g = grants[grantId];
        if (g.granter == address(0)) revert GrantNotFound();
        if (g.granter != msg.sender) revert NotGranter();
        if (g.revoked) revert AlreadyRevoked();

        g.revoked = true;
        emit GrantRevoked(grantId, msg.sender);
    }

    function isGrantActive(bytes32 grantId) external view returns (bool) {
        Grant storage g = grants[grantId];
        if (g.granter == address(0) || g.revoked) return false;
        if (g.until != 0 && block.timestamp > g.until) return false;
        return true;
    }

    function getGrant(bytes32 grantId) external view returns (Grant memory) {
        return grants[grantId];
    }
}
