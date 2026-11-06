/**
 * Test-only fake of the palmfi contracts behind the SDK's EvmMock / ConfidentialHttpMock. It decodes every
 * eth_call (including Multicall3 aggregate3 batches) against the real ABIs and answers from an in-memory
 * world, so workflow tests drive the handlers exactly as the DON would. Must be installed inside the SDK's
 * `test()` wrapper.
 */
import { getNetwork, protoBigIntToBigint } from "@chainlink/cre-sdk";
import { ConfidentialHttpMock, EvmMock } from "@chainlink/cre-sdk/test";
import {
  bytesToHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { aggregatorV3Abi, approvalBookAbi, ECRECOVER, hubAbi, multicall3Abi, stateViewAbi, vaultAbi } from "./abi";
import { decodeAggregate3 } from "./chain";
import * as P from "./palm";
import { decodeReport } from "./report";
import type { OnchainRequest } from "./scoring";

export const SEPOLIA = getNetwork({ chainFamily: "evm", chainSelectorName: "ethereum-testnet-sepolia" })!.chainSelector
  .selector;

export const ADDR = {
  hub: "0x00000000000000000000000000000000000000a1",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  book: "0x00000000000000000000000000000000000000b0",
  weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  ethUsd: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  usdcUsd: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
  stateView: "0xE1Dd9c3fA50EDB962E442f60dfBc432e24537E4C",
  alice: "0x000000000000000000000000000000000000a11c",
  nvidia: "0x00000000000000000000000000000000000000d1",
  hot: "0x00000000000000000000000000000000000000c1",
  friend: "0x00000000000000000000000000000000000000f1",
  exchange: "0x00000000000000000000000000000000000000e1",
  attacker: "0x00000000000000000000000000000000000000ba",
  approver: "0x00000000000000000000000000000000000000a9",
  sweeper: "0x00000000000000000000000000000000000000ee",
} as const satisfies Record<string, Address>;

export type FakeVault = {
  institution: boolean;
  hardCap: bigint;
  sensitivePending: bigint;
  bizStartHourUtc: number;
  bizEndHourUtc: number;
  usualMaxPayout: bigint;
  approvalBook: Address;
  approver: Address;
  destinations: Set<string>;
  hotWallets: Address[];
  delegationTargets: Address[];
  delegationOk: boolean[];
  reserves: { u: Address[]; held: bigint[]; supply: bigint[] };
  requests: Map<bigint, OnchainRequest>;
  /** Request state at the FINALIZED block; defaults to `requests`. */
  finalized?: Map<bigint, OnchainRequest>;
  stale: Set<string>;
};

export type Feed = { decimals: number; roundId: bigint; answer: bigint; updatedAt: bigint; prevAnswer?: bigint };

export type World = {
  status: Map<string, number>;
  vaults: Map<string, FakeVault>;
  blocked: Set<string>;
  marketMode: Map<string, number>;
  lastHeartbeat: bigint;
  approvals: Map<string, { requestId: bigint; amount: bigint; asset: Address; destination: Address; expiry: bigint; signature: Hex }>;
  /** ecrecover answers keyed by the signature hex. */
  signers: Map<string, Address>;
  feeds: Map<string, Feed>;
  slot0: Map<string, bigint>;
  headerTimestamp: bigint;
  headerFails: boolean;
  /** "target:functionName" sub-calls that revert; "*" fails every eth_call. */
  failing: Set<string>;
  writes: P.Report[];
  writeReply: { txStatus: "TX_STATUS_SUCCESS" | "TX_STATUS_REVERTED" | "TX_STATUS_FATAL"; receiverReverted: boolean };
  notifications: { url: string; body: unknown; headers: Record<string, string[]>; secrets: string[] }[];
  notifyStatus: number;
  evmCalls: number;
};

const lc = (a: string) => a.toLowerCase();

export const request = (over: Partial<OnchainRequest> = {}): OnchainRequest => ({
  asset: ADDR.weth,
  destination: ADDR.friend,
  requester: ADDR.hot,
  amount: 10n ** 16n,
  usdValue: 30_000000n,
  createdAt: 1_793_970_000n,
  executableAt: 0n,
  state: P.REQ_PENDING,
  asWeth: false,
  secondFactor: false,
  recoveryApproved: false,
  reasonCodes: P.OVER_BUDGET,
  requestHash: keccak256(toHex(`req-${over.amount ?? 1}-${over.destination ?? ADDR.friend}`)),
  ...over,
});

export const fakeVault = (over: Partial<FakeVault> = {}): FakeVault => ({
  institution: false,
  hardCap: 50_000000n,
  sensitivePending: 0n,
  bizStartHourUtc: 0,
  bizEndHourUtc: 0,
  usualMaxPayout: 0n,
  approvalBook: ADDR.book,
  approver: ADDR.approver,
  destinations: new Set([lc(ADDR.friend)]),
  hotWallets: [ADDR.hot],
  delegationTargets: ["0x0000000000000000000000000000000000000000"],
  delegationOk: [true],
  reserves: { u: [ADDR.weth, ADDR.usdc], held: [10n ** 18n, 100_000000n], supply: [10n ** 18n, 100_000000n] },
  requests: new Map(),
  stale: new Set(),
  ...over,
});

// 2026-11-06 14:00 UTC
export const T_14H = 1793973600n;
export const T_02H = 1793930400n;

export const newWorld = (): World => ({
  status: new Map(),
  vaults: new Map(),
  blocked: new Set(),
  marketMode: new Map(),
  lastHeartbeat: 0n,
  approvals: new Map(),
  signers: new Map(),
  feeds: new Map([
    [lc(ADDR.ethUsd), { decimals: 8, roundId: 100n, answer: 3000_00000000n, updatedAt: T_14H - 60n }],
    [lc(ADDR.usdcUsd), { decimals: 8, roundId: 100n, answer: 1_00000000n, updatedAt: T_14H - 60n }],
  ]),
  slot0: new Map(),
  headerTimestamp: T_14H,
  headerFails: false,
  failing: new Set(),
  writes: [],
  writeReply: { txStatus: "TX_STATUS_SUCCESS", receiverReverted: false },
  notifications: [],
  notifyStatus: 200,
  evmCalls: 0,
});

export const addVault = (w: World, addr: Address, v: FakeVault, status = P.STATUS_ACTIVE) => {
  w.vaults.set(lc(addr), v);
  w.status.set(lc(addr), status);
  return v;
};

class Revert extends Error {}

const reqTuple = (r: OnchainRequest) => r;

function answer(w: World, to: Address, data: Hex, finalized: boolean): Hex {
  const t = lc(to);
  if (w.failing.has("*")) throw new Revert("all");
  if (t === lc(ECRECOVER)) {
    // input = hash ‖ v ‖ r ‖ s (32 bytes each); key the answer by the 65-byte r ‖ s ‖ v signature
    const sig = `0x${data.slice(130, 258)}${data.slice(128, 130)}`;
    const signer = w.signers.get(lc(sig));
    return signer ? encodeAbiParameters([{ type: "address" }], [signer]) : "0x";
  }
  const route = (abi: Abi) => {
    const { functionName, args } = decodeFunctionData({ abi, data });
    if (w.failing.has(`${t}:${functionName}`)) throw new Revert(functionName);
    return { functionName, args: (args ?? []) as readonly unknown[] };
  };
  const out = (abi: Abi, functionName: string, result: unknown) =>
    encodeFunctionResult({ abi, functionName, result } as never);

  if (t === lc(ADDR.hub)) {
    const { functionName, args } = route(hubAbi);
    switch (functionName) {
      case "statusOf":
        return out(hubAbi, functionName, w.status.get(lc(args[0] as string)) ?? 0);
      case "isBlocked":
        return out(hubAbi, functionName, w.blocked.has(lc(args[0] as string)));
      case "marketMode":
        return out(hubAbi, functionName, w.marketMode.get(lc(args[0] as string)) ?? 0);
      case "lastHeartbeat":
        return out(hubAbi, functionName, w.lastHeartbeat);
      case "vaultCount":
        return out(hubAbi, functionName, BigInt(w.vaults.size));
      case "getVaults": {
        const [off, lim] = args as [bigint, bigint];
        const all = [...w.vaults.keys()].map((a) => getAddress(a));
        return out(hubAbi, functionName, all.slice(Number(off), Number(off + lim)));
      }
      case "openRequests": {
        const [off, lim] = args as [bigint, bigint];
        const all = [...w.vaults.entries()].slice(Number(off), Number(off + lim));
        const rows = all.flatMap(([a, v]) =>
          [...v.requests.entries()]
            .filter(([, r]) => [P.REQ_PENDING, P.REQ_CLEARED, P.REQ_HELD].includes(r.state))
            .map(([id, r]) => ({ vault: getAddress(a), requestId: id, usdValue: r.usdValue, state: r.state, requestHash: r.requestHash })),
        );
        return out(hubAbi, functionName, rows);
      }
    }
  }
  if (t === lc(ADDR.book)) {
    const { functionName, args } = route(approvalBookAbi);
    const a = w.approvals.get(`${lc(args[0] as string)}:${lc(args[1] as string)}`);
    return out(approvalBookAbi, functionName, a ?? {
      requestId: 0n, amount: 0n, asset: "0x0000000000000000000000000000000000000000",
      destination: "0x0000000000000000000000000000000000000000", expiry: 0n, signature: "0x",
    });
  }
  const feed = w.feeds.get(t);
  if (feed) {
    const { functionName, args } = route(aggregatorV3Abi);
    if (functionName === "decimals") return out(aggregatorV3Abi, functionName, feed.decimals);
    if (functionName === "latestRoundData")
      return out(aggregatorV3Abi, functionName, [feed.roundId, feed.answer, feed.updatedAt, feed.updatedAt, feed.roundId]);
    const id = args[0] as bigint;
    if (feed.prevAnswer === undefined) throw new Revert("no round");
    return out(aggregatorV3Abi, functionName, [id, feed.prevAnswer, feed.updatedAt - 3600n, feed.updatedAt - 3600n, id]);
  }
  if (t === lc(ADDR.stateView)) {
    const { functionName, args } = route(stateViewAbi);
    const sqrt = w.slot0.get(lc(args[0] as string));
    if (sqrt === undefined) throw new Revert("no pool");
    return out(stateViewAbi, functionName, [sqrt, 0, 0, 0]);
  }
  const v = w.vaults.get(t);
  if (v) {
    const { functionName, args } = route(vaultAbi);
    const reqs = finalized ? (v.finalized ?? v.requests) : v.requests;
    switch (functionName) {
      case "getRequest": {
        const r = reqs.get(args[0] as bigint) ?? request({ state: P.REQ_NONE, requestHash: `0x${"0".repeat(64)}`, reasonCodes: 0n });
        return out(vaultAbi, functionName, reqTuple(r));
      }
      case "openRequestIds":
        return out(vaultAbi, functionName, [...reqs.keys()]);
      case "institution":
      case "hardCap":
      case "sensitivePending":
      case "bizStartHourUtc":
      case "bizEndHourUtc":
      case "usualMaxPayout":
      case "approvalBook":
      case "approver":
        return out(vaultAbi, functionName, v[functionName]);
      case "isDestination":
        return out(vaultAbi, functionName, v.destinations.has(lc(args[0] as string)));
      case "marketModeOf": {
        const a = lc(args[0] as string);
        return out(vaultAbi, functionName, v.stale.has(a) ? P.MODE_DEGRADED : (w.marketMode.get(a) ?? 0));
      }
      case "valueUsd":
        return out(vaultAbi, functionName, [0n, v.stale.has(lc(args[0] as string))]);
      case "reserves":
        return out(vaultAbi, functionName, [v.reserves.u, v.reserves.held, v.reserves.supply]);
      case "delegations":
        return out(vaultAbi, functionName, [v.hotWallets, v.delegationTargets, v.delegationOk]);
    }
  }
  throw new Revert(`no contract at ${to}`);
}

/** Installs the fake world behind the SDK mocks. Call inside `test()` from @chainlink/cre-sdk/test. */
export function installWorld(w: World) {
  const evm = EvmMock.testInstance(SEPOLIA);
  evm.callContract = (req) => {
    w.evmCalls++;
    if (w.failing.has("*")) throw new Error("rpc down");
    const to = bytesToHex(req.call!.to) as Address;
    const data = bytesToHex(req.call!.data) as Hex;
    const finalized = req.blockNumber ? protoBigIntToBigint(req.blockNumber) === -3n : false;
    if (lc(to) === lc(ADDR.multicall3)) {
      const calls = decodeAggregate3(data);
      const results = calls.map((c) => {
        try {
          return { success: true, returnData: answer(w, c.target, c.callData, finalized) };
        } catch (e) {
          if (e instanceof Revert) return { success: false, returnData: "0x" as Hex };
          throw e;
        }
      });
      const enc = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      return { data: Buffer.from(enc.slice(2), "hex").toString("base64") };
    }
    const enc = answer(w, to, data, finalized);
    return { data: Buffer.from(enc.slice(2), "hex").toString("base64") };
  };
  evm.headerByNumber = () => {
    w.evmCalls++;
    if (w.headerFails) throw new Error("header unavailable");
    return { header: { timestamp: w.headerTimestamp.toString(), blockNumber: { absVal: "AQ==", sign: "1" } } };
  };
  evm.writeReport = (req) => {
    const raw = bytesToHex(req.report!.rawReport);
    // rawReport = 109-byte metadata header ‖ payload
    w.writes.push(decodeReport(`0x${raw.slice(2 + 109 * 2)}`));
    return {
      txStatus: w.writeReply.txStatus,
      receiverContractExecutionStatus: w.writeReply.receiverReverted
        ? "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED"
        : "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS",
    };
  };
  const http = ConfidentialHttpMock.testInstance();
  http.sendRequest = (req) => {
    const r = req.request!;
    const headers: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(r.multiHeaders)) headers[k] = v.values;
    w.notifications.push({
      url: r.url,
      body: r.body.case === "bodyString" ? JSON.parse(r.body.value) : undefined,
      headers,
      secrets: req.vaultDonSecrets.map((s) => s.key),
    });
    return { statusCode: w.notifyStatus };
  };
}
