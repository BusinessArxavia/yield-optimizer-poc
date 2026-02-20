// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Script, console2 } from "forge-std/Script.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { YieldKeeper } from "../contracts/automation/YieldKeeper.sol";

interface IAccessControl {
    function KEEPER_ROLE() external view returns (bytes32);
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
}

interface IAutomationRegistrar2_3 {
    struct RegistrationParams {
        address upkeepContract;
        uint96 amount;
        address adminAddress;
        uint32 gasLimit;
        uint8 triggerType;
        address billingToken;
        string name;
        bytes encryptedEmail;
        bytes checkData;
        bytes triggerConfig;
        bytes offchainConfig;
    }

    function registerUpkeep(RegistrationParams memory requestParams) external payable returns (uint256);
}

interface IAutomationRegistry {
    function getForwarder(uint256 upkeepID) external view returns (address);
}

/// @title UpgradeYieldKeeper — Redeploy YieldKeeper with forwarder restriction
/// @notice Deploys new keeper, wires roles, registers upkeep, and sets forwarder
contract UpgradeYieldKeeper is Script {
    // ─── Base Sepolia Addresses ──────────────────────────────────────
    address constant VAULT = 0xd61fB879d95258EEA547F56C1c301828FCB9041a;
    address constant STRATEGY_CONTROLLER = 0x0F52eE96041866d621043cd86dB31c1189AAB08f;
    address constant CIRCUIT_BREAKER = 0x9AF03cd768E07E5576E0389dE9C2F90802B35633;
    address constant REWARD_HARVESTER = 0x3b182960f2f489F2a5ac851B22048C2DcCB94109;
    address constant OLD_KEEPER = 0xE3d7AedC73Fa24f0902b2e5e7e51A9E417611ce3;

    // ─── Chainlink ───────────────────────────────────────────────────
    address constant LINK_TOKEN = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;
    address constant REGISTRAR = 0xf28D56F3A707E25B71Ce529a21AF388751E1CF2A;
    address constant REGISTRY = 0x91D4a4C3D448c7f3CB477332B1c7D420a5810aC3;

    uint32 constant GAS_LIMIT = 500_000;
    uint96 constant LINK_FUNDING = 5 ether;

    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        // ─── 1. Deploy new YieldKeeper ───────────────────────────────
        YieldKeeper keeper = new YieldKeeper(
            VAULT,
            STRATEGY_CONTROLLER,
            CIRCUIT_BREAKER,
            deployer,
            100e6, // minIdleSupplyAmount
            500, // idleTargetBps: 5%
            50, // harvestMinYieldBps: 0.5%
            10 minutes // harvestCooldown (testnet)
        );

        // ─── 2. Wire roles ───────────────────────────────────────────
        IAccessControl controller = IAccessControl(STRATEGY_CONTROLLER);
        IAccessControl harvester = IAccessControl(REWARD_HARVESTER);
        bytes32 keeperRole = controller.KEEPER_ROLE();

        // Grant to new keeper
        controller.grantRole(keeperRole, address(keeper));
        harvester.grantRole(harvester.KEEPER_ROLE(), address(keeper));

        // Revoke from old keeper
        controller.revokeRole(keeperRole, OLD_KEEPER);
        harvester.revokeRole(harvester.KEEPER_ROLE(), OLD_KEEPER);

        // ─── 3. Register Chainlink Automation upkeep ─────────────────
        IERC20(LINK_TOKEN).approve(REGISTRAR, LINK_FUNDING);

        uint256 upkeepId = IAutomationRegistrar2_3(REGISTRAR)
            .registerUpkeep(
                IAutomationRegistrar2_3.RegistrationParams({
                    upkeepContract: address(keeper),
                    amount: LINK_FUNDING,
                    adminAddress: deployer,
                    gasLimit: GAS_LIMIT,
                    triggerType: 0,
                    billingToken: LINK_TOKEN,
                    name: "YieldKeeper v2 - Forwarder Restricted",
                    encryptedEmail: bytes(""),
                    checkData: bytes(""),
                    triggerConfig: bytes(""),
                    offchainConfig: bytes("")
                })
            );

        // ─── 4. Get forwarder and set it ─────────────────────────────
        address forwarder = IAutomationRegistry(REGISTRY).getForwarder(upkeepId);
        keeper.setForwarder(forwarder);

        vm.stopBroadcast();

        // ─── Log ─────────────────────────────────────────────────────
        console2.log("=== YieldKeeper Upgrade ===");
        console2.log("");
        console2.log("New YieldKeeper:", address(keeper));
        console2.log("Old YieldKeeper:", OLD_KEEPER);
        console2.log("Upkeep ID:     ", upkeepId);
        console2.log("Forwarder:     ", forwarder);
        console2.log("Deployer:      ", deployer);
    }
}
