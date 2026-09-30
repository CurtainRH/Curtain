// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice ERC-5564 Stealth Address Announcer, implemented verbatim from the EIP —
/// no Curtain-specific fields. A single public event log that lets senders announce
/// a stealth payment so the recipient's wallet can discover it by scanning.
contract StealthAnnouncer {
    /// @param schemeId Identifies the stealth address scheme (1 = secp256k1 with view tags).
    /// @param stealthAddress The computed stealth address funds were sent to.
    /// @param caller The address that submitted the announcement (may differ from the sender).
    /// @param ephemeralPubKey The ephemeral public key used to derive `stealthAddress`.
    /// @param metadata Scheme-specific data; for scheme 1, byte 0 is the view tag.
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
