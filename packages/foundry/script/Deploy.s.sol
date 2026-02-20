//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { DeployYieldVault } from "./DeployYieldVault.s.sol";
import { DeployYieldVaultLocal } from "./DeployYieldVaultLocal.s.sol";

/// @notice Main deployment script for all contracts
/// @dev Run this when you want to deploy multiple contracts at once
///      Example: yarn deploy
///      For testnet: yarn deploy --file DeployYieldVaultTestnet.s.sol --network baseSepolia
contract DeployScript is ScaffoldETHDeploy {
    function run() external {
        if (block.chainid == 31337) {
            // Local Anvil: deploy with mocks
            DeployYieldVaultLocal deployLocal = new DeployYieldVaultLocal();
            deployLocal.run();
        } else {
            // Testnet/mainnet: use real addresses
            DeployYieldVault deployVault = new DeployYieldVault();
            deployVault.run();
        }
    }
}
