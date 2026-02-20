// @yield-optimizer/automation
// Chainlink Automation + CCIP + Gelato integration for automated yield rotation

// Task 3.1 — Contract ABIs for automation
export * from "./abis.js";

// Task 3.2 — CRE yield check workflow
export {
  runYieldCheck,
  startYieldCheckLoop,
  type YieldCheckConfig,
  type WorkflowResult,
} from "./cre/yield-check-workflow.js";

// Task 3.3 — CCIP transfer module
export {
  estimateCcipFee,
  isChainSupported,
  sendCcipTransfer,
  getChainSelector,
  CCIP_CHAIN_SELECTORS,
  type CcipTransferParams,
  type CcipFeeEstimate,
  type CcipTransferResult,
} from "./ccip/send-transfer.js";

// Task 3.4 — CCTP transfer module
export {
  isCctpSupported,
  initiateCctpBurn,
  waitForAttestation,
  completeCctpTransfer,
  CCTP_DOMAINS,
  TOKEN_MESSENGER,
  MESSAGE_TRANSMITTER,
  type CctpTransferParams,
  type CctpTransferResult,
} from "./ccip/cctp-transfer.js";

// Task 3.5 — Gelato dead man switch
export {
  checkSwitchStatus,
  sendHeartbeat,
  executeFallback,
  startDeadManSwitchLoop,
  type DeadManSwitchConfig,
  type SwitchStatus,
} from "./gelato/dead-man-switch.js";
