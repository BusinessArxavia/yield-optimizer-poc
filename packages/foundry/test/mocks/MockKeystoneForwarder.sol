// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title MockKeystoneForwarder — Simulates the CRE KeystoneForwarder for testing
/// @notice Calls onReport() on a target contract, mimicking how the real forwarder delivers reports
contract MockKeystoneForwarder {
    /// @notice Deliver a report to a consumer contract (simulates KeystoneForwarder behavior)
    /// @param target The consumer contract address
    /// @param metadata Encoded workflow metadata (workflowId, workflowName, workflowOwner)
    /// @param report The ABI-encoded report payload
    function report(address target, bytes calldata metadata, bytes calldata report) external {
        (bool success, bytes memory returnData) =
            target.call(abi.encodeWithSignature("onReport(bytes,bytes)", metadata, report));
        if (!success) {
            // Bubble up the revert reason
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            revert("MockKeystoneForwarder: onReport call failed");
        }
    }

    /// @notice Build metadata bytes matching the CRE format
    /// @dev Format: abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
    function buildMetadata(bytes32 workflowId, bytes10 workflowName, address workflowOwner)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(workflowId, workflowName, workflowOwner);
    }
}
