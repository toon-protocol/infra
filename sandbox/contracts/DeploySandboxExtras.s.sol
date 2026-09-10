// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/**
 * @title DeploySandboxExtras
 * @notice SANDBOX-OWNED deploy script (lives in infra/sandbox/contracts/, NOT
 *         in the connector repo) for the extra contracts kind:5098 needs on
 *         anvil. It is mounted read-only at /sandbox-extras in the anvil
 *         container (forge runs it by absolute path from the connector's
 *         project root, so the connector checkout is never written to) right
 *         after DeployLocal.s.sol — see sandbox/docker-compose.yml (anvil).
 *
 * What it deploys, and why:
 *
 *  1. `ERC2771Forwarder("ToonSandboxForwarder")` — the OpenZeppelin v5.5.0
 *     trusted forwarder (vendored in the connector checkout's
 *     lib/openzeppelin-contracts, the exact contract whose
 *     `ForwardRequestData` struct / `execute` / `verify` / `nonces` ABI the
 *     gas-station's kind:5098 handler is written against). EIP-712 domain:
 *     name "ToonSandboxForwarder", version "1" (hardwired by OZ).
 *
 *  2. `SandboxTokenNetworkProbe(forwarder)` — a minimal ERC-2771-aware
 *     recipient the smoke test relays a real forwarded call to. It exists
 *     because the REAL TokenNetwork DeployLocal creates was constructed with
 *     trustedForwarder = address(0) (the registry's default; ERC2771Context
 *     stores the forwarder as an IMMUTABLE, so that instance can never accept
 *     meta-transactions). The probe exposes exactly the whitelisted
 *     `setTotalDeposit(bytes32,address,uint256)` selector (the gas station
 *     refuses every other selector — mitigation (d)) and records
 *     `_msgSender()`, which is THE ERC-2771 proof: after a relayed call it
 *     must read back as the CLIENT's address, not the relayer's.
 *
 * DETERMINISM: broadcast from anvil account 9 (0xa0Ee…9720) — an account
 * nothing else in the sandbox transacts from — so the addresses are pure
 * functions of (deployer, nonce 0/1) and stay stable even if the connector's
 * DeployLocal.s.sol grows or shrinks:
 *
 *   ERC2771Forwarder          0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35
 *   SandboxTokenNetworkProbe  0xA15BB66138824a1c7167f5E85b957d04Dd34E468
 *
 * These are committed in conf/gas-station.conf (EVM_GAS_STATION_CONFIG_JSON),
 * the anvil healthcheck, and scripts/smoke-toon.mjs; the `require`s below make
 * any drift loud at deploy time instead of a downstream mystery.
 */
contract SandboxTokenNetworkProbe is ERC2771Context {
    address public lastSender;
    bytes32 public lastChannelId;
    address public lastParticipant;
    uint256 public lastTotalDeposit;
    uint256 public callCount;

    constructor(address trustedForwarder_) ERC2771Context(trustedForwarder_) {}

    /// @notice Same signature as TokenNetwork.setTotalDeposit — the one
    ///         whitelisted selector the smoke relays — but it only RECORDS the
    ///         call (crucially `_msgSender()`, resolved through ERC-2771).
    function setTotalDeposit(bytes32 channelId, address participant, uint256 totalDeposit) external {
        lastSender = _msgSender();
        lastChannelId = channelId;
        lastParticipant = participant;
        lastTotalDeposit = totalDeposit;
        callCount += 1;
    }
}

contract DeploySandboxExtrasScript is Script {
    // anvil account 9 (public test key, local chain only) — dedicated to this
    // script so its nonces (0, 1) are independent of DeployLocal's account 0.
    uint256 internal constant DEPLOYER_KEY =
        0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6;

    function run() external {
        vm.startBroadcast(DEPLOYER_KEY);
        ERC2771Forwarder forwarder = new ERC2771Forwarder("ToonSandboxForwarder");
        SandboxTokenNetworkProbe probe = new SandboxTokenNetworkProbe(address(forwarder));
        vm.stopBroadcast();

        // The committed configs name these addresses; fail HERE if they drift.
        require(
            address(forwarder) == 0x700b6A60ce7EaaEA56F065753d8dcB9653dbAD35,
            "forwarder address drifted from the committed value"
        );
        require(
            address(probe) == 0xA15BB66138824a1c7167f5E85b957d04Dd34E468,
            "probe address drifted from the committed value"
        );

        console.log("ERC2771_FORWARDER_ADDRESS=%s", address(forwarder));
        console.log("SANDBOX_TOKEN_NETWORK_PROBE_ADDRESS=%s", address(probe));
    }
}
