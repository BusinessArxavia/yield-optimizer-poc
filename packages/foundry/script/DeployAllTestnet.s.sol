// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { CircuitBreaker } from "../contracts/safety/CircuitBreaker.sol";
import { YieldVault } from "../contracts/vault/YieldVault.sol";
import { VaultGateway } from "../contracts/vault/VaultGateway.sol";
import { StrategyController } from "../contracts/strategy/StrategyController.sol";
import { RewardHarvester } from "../contracts/automation/RewardHarvester.sol";
import { YieldKeeper } from "../contracts/automation/YieldKeeper.sol";
import { DeadManSwitch } from "../contracts/automation/DeadManSwitch.sol";

/// @dev Minimal no-op Merkl distributor for testnet (Merkl has no Base Sepolia deployment)
contract TestnetMerklDistributor {
    mapping(address => mapping(address => uint256)) public claimed;

    function claim(address[] calldata, address[] calldata, uint256[] calldata, bytes32[][] calldata) external { }
}

/// @dev Minimal no-op Aave RewardsController for testnet
/// Real Aave incentives may not be active on Base Sepolia
contract TestnetRewardsController {
    function claimAllRewards(address[] calldata, address)
        external
        pure
        returns (address[] memory rewardsList, uint256[] memory claimedAmounts)
    {
        rewardsList = new address[](0);
        claimedAmounts = new uint256[](0);
    }

    function getAllUserRewards(address[] calldata, address) external pure returns (address[] memory, uint256[] memory) {
        return (new address[](0), new uint256[](0));
    }

    function getRewardsByAsset(address) external pure returns (address[] memory) {
        return new address[](0);
    }
}

/// @title DeployAllTestnet — Full Phase 4 deployment on Base Sepolia
/// @notice Deploys all 9 contracts (including testnet mocks) and wires all roles
contract DeployAllTestnet is Script {
    // ─── Base Sepolia Addresses ───────────────────────────────────────
    address constant AAVE_POOL = 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27;
    address constant USDC = 0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f;
    address constant USDC_USD_FEED = 0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165;
    address constant CCIP_ROUTER = 0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93;
    address constant LINK_TOKEN = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // ─── 1. Circuit Breaker ──────────────────────────────────────
        uint256[3] memory depeg = [uint256(99_000_000), uint256(98_000_000), uint256(95_000_000)];
        uint256[3] memory tvl = [uint256(1000), uint256(2000), uint256(5000)];
        uint256[3] memory share = [uint256(500), uint256(1000), uint256(2000)];

        CircuitBreaker circuitBreaker =
            new CircuitBreaker(deployer, deployer, deployer, USDC_USD_FEED, depeg, tvl, share);

        // ─── 2. Yield Vault ──────────────────────────────────────────
        YieldVault vault = new YieldVault(
            IERC20(USDC), "Yield USDC", "yUSDC", deployer, deployer, AAVE_POOL, address(circuitBreaker), deployer, 1000
        );

        // ─── 3. Strategy Controller ─────────────────────────────────
        StrategyController controller = new StrategyController(
            deployer, address(vault), AAVE_POOL, CCIP_ROUTER, LINK_TOKEN, address(circuitBreaker), 25, 200, 1 minutes, 0
        );

        // ─── 4. Vault Gateway ────────────────────────────────────────
        VaultGateway gateway = new VaultGateway();

        // ─── 5. Testnet Reward Mocks ─────────────────────────────────
        TestnetRewardsController rewardsController = new TestnetRewardsController();
        TestnetMerklDistributor merklDistributor = new TestnetMerklDistributor();

        // ─── 6. Reward Harvester ─────────────────────────────────────
        RewardHarvester harvester = new RewardHarvester(
            deployer,
            address(vault),
            address(rewardsController),
            address(merklDistributor),
            10 minutes // short cooldown for testnet
        );

        // ─── 7. Yield Keeper ─────────────────────────────────────────
        YieldKeeper keeper = new YieldKeeper(
            address(vault),
            address(controller),
            address(circuitBreaker),
            deployer,
            100e6, // minIdleSupplyAmount
            500, // idleTargetBps: 5%
            50, // harvestMinYieldBps: 0.5%
            10 minutes // harvestCooldown
        );

        // ─── 8. Dead Man Switch ──────────────────────────────────────
        DeadManSwitch dms = new DeadManSwitch(address(controller), deployer, deployer, 1 hours);

        // ─── Wire Roles ──────────────────────────────────────────────

        // Vault: grant STRATEGY_ROLE to controller + harvester, revoke deployer
        vault.grantRole(vault.STRATEGY_ROLE(), address(controller));
        vault.grantRole(vault.STRATEGY_ROLE(), address(harvester));
        vault.revokeRole(vault.STRATEGY_ROLE(), deployer);

        // CircuitBreaker: grant VAULT_ROLE to vault
        circuitBreaker.grantRole(circuitBreaker.VAULT_ROLE(), address(vault));

        // Harvester: grant KEEPER_ROLE to keeper contract + deployer, SWAPPER_ROLE to deployer (for testnet)
        harvester.grantRole(harvester.KEEPER_ROLE(), address(keeper));
        harvester.grantRole(harvester.KEEPER_ROLE(), deployer);
        harvester.grantRole(harvester.SWAPPER_ROLE(), deployer);

        vm.stopBroadcast();

        // ─── Log ─────────────────────────────────────────────────────
        console2.log("=== Phase 4 - Base Sepolia Full Deployment ===");
        console2.log("");
        console2.log("--- Core ---");
        console2.log("CircuitBreaker:      ", address(circuitBreaker));
        console2.log("YieldVault:          ", address(vault));
        console2.log("StrategyController:  ", address(controller));
        console2.log("");
        console2.log("--- New (Phase 4) ---");
        console2.log("VaultGateway:        ", address(gateway));
        console2.log("RewardHarvester:     ", address(harvester));
        console2.log("");
        console2.log("--- Automation ---");
        console2.log("YieldKeeper:         ", address(keeper));
        console2.log("DeadManSwitch:       ", address(dms));
        console2.log("");
        console2.log("--- Testnet Mocks ---");
        console2.log("RewardsController:   ", address(rewardsController));
        console2.log("MerklDistributor:    ", address(merklDistributor));
        console2.log("");
        console2.log("Deployer:            ", deployer);
        console2.log("Asset (USDC):        ", USDC);
        console2.log("Aave Pool:           ", AAVE_POOL);
    }
}
