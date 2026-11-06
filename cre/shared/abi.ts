/**
 * ABIs the workflows read and decode, transcribed from contracts/src (Hub.sol, Vault.sol, ApprovalBook.sol)
 * plus Multicall3, Chainlink AggregatorV3 and the Uniswap v4 StateView. abi.test.ts checks the palmfi
 * signatures against the Solidity sources.
 */
import { parseAbi } from "viem";

export const hubEventsAbi = parseAbi([
  "event UnwrapRequested(address indexed vault, uint256 indexed requestId, bytes32 requestHash, address asset, uint256 amount, address destination, uint256 usdValue, uint256 reasonCodes)",
  "event ConfigChangeRequested(address indexed vault, uint256 indexed changeId, uint8 kind, bytes data, uint64 eta)",
  "event SecondFactorConfirmed(address indexed vault, uint256 indexed requestId, bytes32 requestHash)",
  "event HookSwap(address indexed vault, address indexed hotWallet, address asset, uint256 amount, bool isUnwrap, uint256 usdValue)",
  "event SafeHarborSwap(address indexed vault, address indexed hotWallet, uint256 amountIn, uint256 amountOut, uint256 minOut)",
]);

export const hubAbi = parseAbi([
  "struct OpenRequest { address vault; uint256 requestId; uint256 usdValue; uint8 state; bytes32 requestHash; }",
  "function openRequests(uint256 offset, uint256 limit) view returns (OpenRequest[] out)",
  "function getVaults(uint256 offset, uint256 limit) view returns (address[] out)",
  "function vaultCount() view returns (uint256)",
  "function statusOf(address vault) view returns (uint8)",
  "function isBlocked(address account) view returns (bool)",
  "function marketMode(address asset) view returns (uint8)",
  "function lastHeartbeat() view returns (uint256)",
]);

export const vaultAbi = parseAbi([
  "struct Request { address asset; address destination; address requester; uint128 amount; uint128 usdValue; uint64 createdAt; uint64 executableAt; uint8 state; bool asWeth; bool secondFactor; bool recoveryApproved; uint256 reasonCodes; bytes32 requestHash; }",
  "function getRequest(uint256 id) view returns (Request)",
  "function openRequestIds() view returns (uint256[])",
  "function institution() view returns (bool)",
  "function hardCap() view returns (uint128)",
  "function sensitivePending() view returns (uint256)",
  "function bizStartHourUtc() view returns (uint8)",
  "function bizEndHourUtc() view returns (uint8)",
  "function usualMaxPayout() view returns (uint128)",
  "function approvalBook() view returns (address)",
  "function approver() view returns (address)",
  "function isDestination(address) view returns (bool)",
  "function marketModeOf(address underlying) view returns (uint8)",
  "function valueUsd(address underlying, uint256 amount) view returns (uint256 usd, bool stale)",
  "function reserves() view returns (address[] u, uint256[] held, uint256[] supply)",
  "function delegations() view returns (address[] wallets, address[] targets, bool[] ok)",
]);

export const approvalBookAbi = parseAbi([
  "struct Approval { uint256 requestId; uint256 amount; address asset; address destination; uint64 expiry; bytes signature; }",
  "function get(address vault, bytes32 requestHash) view returns (Approval)",
]);

export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

export const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
]);

/** The ecrecover precompile, called through Multicall3 to check ApprovalBook signatures (no crypto in WASM). */
export const ECRECOVER = "0x0000000000000000000000000000000000000001" as const;
