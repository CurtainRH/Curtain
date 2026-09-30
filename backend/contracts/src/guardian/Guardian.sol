// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Guardian pause switches, per Curtain_Backend.md §2.8: "guardian pause = shield and
/// relay only, never transact / unshieldToOrigin." Kept outside CurtainPool so the pool itself
/// has no pause selectors (Pin.s.sol's immutability check); the pool and RelayAdapt only read
/// `shieldPaused()` / `relayPaused()`. There is deliberately no switch for anything else.
///
/// `guardian` is a separate hot key that can pause or unpause quickly. `owner` (the 24h
/// timelock) can rotate that key and can also flip the switches itself.
contract Guardian is Ownable {
    address public guardian;
    bool public shieldPaused;
    bool public relayPaused;

    event GuardianSet(address guardian);
    event ShieldPaused(bool paused);
    event RelayPaused(bool paused);

    error NotGuardian();

    constructor(address initialOwner, address guardian_) Ownable(initialOwner) {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian();
        _;
    }

    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function setShieldPaused(bool paused) external onlyGuardianOrOwner {
        shieldPaused = paused;
        emit ShieldPaused(paused);
    }

    function setRelayPaused(bool paused) external onlyGuardianOrOwner {
        relayPaused = paused;
        emit RelayPaused(paused);
    }
}
