// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "forge-std/Script.sol";

interface IYieldKeeperCRE {
    function setForwarder(address) external;
    function setExpectedWorkflowId(bytes32) external;
    function setExpectedWorkflowOwner(address) external;
    function forwarder() external view returns (address);
    function expectedWorkflowId() external view returns (bytes32);
    function expectedWorkflowOwner() external view returns (address);
}

/// @title ConfigureCREProduction — Lock YieldKeeperCRE to live DON workflow
/// @notice Run after `cre workflow deploy` to set forwarder, workflowId, and owner.
///
/// Usage:
///   1. Deploy workflow: `cre workflow deploy . --target staging-settings`
///   2. Copy WORKFLOW_ID and WORKFLOW_OWNER from deploy output into this script
///   3. Run: `forge script script/ConfigureCREProduction.s.sol --rpc-url baseSepolia --broadcast`
///
/// WARNING: Setting the forwarder to KeystoneForwarder will prevent `simulate --broadcast`
///          and direct `onReport()` calls. Only the DON can deliver reports after this.
///          To re-enable simulation, call `setForwarder(address(0))` from the admin wallet.
contract ConfigureCREProduction is Script {
    // ── Deployed Contracts ──
    address constant KEEPER_CRE = 0x9B39815964a87eF361d555BD99FfdcDEbe4753bb;
    address constant KEYSTONE_FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;

    // ── FILL THESE AFTER `cre workflow deploy` ──────────────────────────
    bytes32 constant WORKFLOW_ID = bytes32(0); // TODO: paste workflow ID from deploy output
    address constant WORKFLOW_OWNER = address(0); // TODO: paste your CRE account address
    // ────────────────────────────────────────────────────────────────────

    function run() external {
        require(WORKFLOW_ID != bytes32(0), "Set WORKFLOW_ID before running");
        require(WORKFLOW_OWNER != address(0), "Set WORKFLOW_OWNER before running");

        vm.startBroadcast();

        IYieldKeeperCRE keeper = IYieldKeeperCRE(KEEPER_CRE);

        // 1. Lock forwarder to production KeystoneForwarder
        keeper.setForwarder(KEYSTONE_FORWARDER);

        // 2. Restrict to deployed workflow identity
        keeper.setExpectedWorkflowId(WORKFLOW_ID);
        keeper.setExpectedWorkflowOwner(WORKFLOW_OWNER);

        vm.stopBroadcast();

        // Verify
        console.log("Forwarder:", keeper.forwarder());
        console.log("WorkflowId:");
        console.logBytes32(keeper.expectedWorkflowId());
        console.log("WorkflowOwner:", keeper.expectedWorkflowOwner());

        require(keeper.forwarder() == KEYSTONE_FORWARDER, "forwarder mismatch");
        require(keeper.expectedWorkflowId() == WORKFLOW_ID, "workflowId mismatch");
        require(keeper.expectedWorkflowOwner() == WORKFLOW_OWNER, "owner mismatch");

        console.log("CRE production configuration complete");
    }
}
