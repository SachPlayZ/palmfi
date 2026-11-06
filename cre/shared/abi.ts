/**
 * ABIs the workflows read and decode, transcribed from contracts/src (Hub.sol, Vault.sol, VaultBase.sol,
 * VaultModule.sol) plus Multicall3. abi.test.ts checks the palmfi signatures against the Solidity sources.
 */
import { parseAbi } from "viem";

export const hubEventsAbi = parseAbi([
  "event RequestQueued(address indexed vault, uint256 indexed requestId, bytes32 requestHash, uint8 kind, address wallet, uint256 amount, address destination, uint256 reasonCodes)",
  "event ConfigChange(address indexed vault, uint256 indexed changeId, uint8 kind, bytes data, uint16 yesVotes, uint64 eta)",
  "event Outflow(address indexed vault, address wallet, address destination, uint256 amount, bool viaPool)",
  "event Voted(address indexed vault, uint256 indexed requestId, address voter, bool yes, uint16 yesVotes, uint16 noVotes)",
]);

export const hubAbi = parseAbi([
  "struct OpenRequest { address vault; uint256 requestId; uint256 amount; uint8 state; bool scored; bool fastTracked; uint64 executableAt; bytes32 requestHash; }",
  "function openRequests(uint256 offset, uint256 limit) view returns (OpenRequest[] out)",
  "function getVaults(uint256 offset, uint256 limit) view returns (address[] out)",
  "function vaultCount() view returns (uint256)",
  "function statusOf(address vault) view returns (uint8)",
  "function isBlocked(address account) view returns (bool)",
  "function lastHeartbeat() view returns (uint256)",
]);

export const vaultAbi = parseAbi([
  "struct Request { address destination; address requester; uint128 amount; uint64 createdAt; uint64 executableAt; uint8 state; uint8 kind; bool fastTracked; bool scored; uint16 voterCount; uint16 yes; uint16 no; uint32 score; uint256 reasonCodes; bytes32 requestHash; }",
  "struct Outflow { address wallet; address destination; uint128 amount; uint64 timestamp; }",
  "struct Profile { uint8 bizStartHourUtc; uint8 bizEndHourUtc; uint128 usualMaxPayout; uint128 hardCap; uint32 floorDelay; uint32 maxDelay; uint32 capDelay; }",
  "struct ScoringContext { Request request; Outflow[] history; uint256 destinationCount; bool knownDestination; Profile profile; bool configChangePending; uint64 requesterAddedAt; address requesterDelegation; uint256 walletCount; }",
  "function getRequest(uint256 id) view returns (Request)",
  "function openRequestIds() view returns (uint256[])",
  "function scoringContext(uint256 id) view returns (ScoringContext ctx)",
  "function reserves() view returns (uint256 held, uint256 supply)",
  "function delegations() view returns (address[] ws, address[] targets, bool[] ok)",
]);

export const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
