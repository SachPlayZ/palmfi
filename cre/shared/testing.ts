/**
 * Test-only fake of the palmfi v2 contracts behind the SDK's EvmMock / ConfidentialHttpMock. It decodes every
 * eth_call (including Multicall3 aggregate3 batches) against the real ABIs and answers from an in-memory
 * world, so workflow tests drive the handlers exactly as the DON would. Must be installed inside the SDK's
 * `test()` wrapper.
 */
import { getNetwork } from "@chainlink/cre-sdk";
import { ConfidentialHttpMock, EvmMock } from "@chainlink/cre-sdk/test";
import {
  bytesToHex,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { hubAbi, multicall3Abi, vaultAbi } from "./abi";
import { decodeAggregate3 } from "./chain";
import type { ScoringContext } from "./deviation";
import * as P from "./palm";
import { decodeReport } from "./report";

export const ARC = getNetwork({ chainFamily: "evm", chainSelectorName: "arc-testnet" })!.chainSelector.selector;

const RAW_ADDR = {
  hub: "0x00000000000000000000000000000000000000a1",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  alice: "0x000000000000000000000000000000000000a11c",
  nvidia: "0x00000000000000000000000000000000000000d1",
  w0: "0x00000000000000000000000000000000000000c0",
  w1: "0x00000000000000000000000000000000000000c1",
  w2: "0x00000000000000000000000000000000000000c2",
  friend: "0x00000000000000000000000000000000000000f1",
  payee2: "0x00000000000000000000000000000000000000f2",
  exchange: "0x00000000000000000000000000000000000000e1",
  attacker: "0x00000000000000000000000000000000000000ba",
  sweeper: "0x00000000000000000000000000000000000000ee",
} as const satisfies Record<string, Address>;

/** Checksummed, as the chain (and viem decoding) returns them. */
export const ADDR = Object.fromEntries(
  Object.entries(RAW_ADDR).map(([k, v]) => [k, getAddress(v.toLowerCase())]),
) as { [K in keyof typeof RAW_ADDR]: Address };

export type Req = ScoringContext["request"];
export type Outflow = ScoringContext["history"][number];

export type FakeVault = {
  profile: ScoringContext["profile"];
  history: Outflow[];
  known: Set<string>;
  destCount: Map<string, bigint>;
  configChangePending: boolean;
  wallets: Address[];
  walletAddedAt: Map<string, bigint>;
  delegationTargets: Address[];
  delegationOk: boolean[];
  reserves: { held: bigint; supply: bigint };
  requests: Map<bigint, Req>;
};

export type World = {
  status: Map<string, number>;
  vaults: Map<string, FakeVault>;
  blocked: Set<string>;
  lastHeartbeat: bigint;
  headerTimestamp: bigint;
  headerFails: boolean;
  /** "target:functionName" sub-calls that revert; "*" fails every eth_call. */
  failing: Set<string>;
  writes: P.Report[];
  writeReply: { txStatus: "TX_STATUS_SUCCESS" | "TX_STATUS_REVERTED" | "TX_STATUS_FATAL"; receiverReverted: boolean };
  notifications: { url: string; body: Record<string, string>; headers: Record<string, string[]>; secrets: string[] }[];
  notifyStatus: number;
  evmCalls: number;
};

const lc = (a: string) => a.toLowerCase();
const USD = (x: number) => BigInt(Math.round(x * 1e6));

// 2026-11-06 14:00 UTC / 02:00 UTC
export const T_14H = 1793973600n;
export const T_02H = 1793930400n;
const DAY = 86400n;

export const request = (over: Partial<Req> = {}): Req => ({
  destination: ADDR.friend,
  requester: ADDR.w0,
  amount: USD(1500),
  createdAt: T_14H - 60n,
  executableAt: T_14H - 60n + 72n * 3600n,
  state: P.REQ_PENDING,
  kind: P.KIND_UNWRAP,
  fastTracked: false,
  scored: false,
  voterCount: 3,
  yes: 0,
  no: 0,
  score: 0,
  reasonCodes: P.CRE_SILENT,
  requestHash: keccak256(toHex(`req-${over.amount ?? 1}-${over.destination ?? ADDR.friend}-${over.requester ?? ADDR.w0}`)),
  ...over,
});

/** 24 business-hours payments ($1k–$2.4k) to two regular payees over the last four weeks. */
export const payroll = (): Outflow[] =>
  Array.from({ length: 24 }, (_, i) => ({
    wallet: [ADDR.w0, ADDR.w1, ADDR.w2][i % 3],
    destination: i % 2 ? ADDR.payee2 : ADDR.friend,
    amount: USD(1000 + ((i * 263) % 1400)),
    timestamp: T_14H - BigInt(28 - i) * DAY - BigInt(i % 4) * 3600n,
  }));

export const fakeVault = (over: Partial<FakeVault> = {}): FakeVault => ({
  profile: {
    bizStartHourUtc: 9,
    bizEndHourUtc: 17,
    usualMaxPayout: USD(3000),
    hardCap: USD(50_000),
    floorDelay: 15 * 60,
    maxDelay: 72 * 3600,
    capDelay: 24 * 3600,
  },
  history: payroll(),
  known: new Set([lc(ADDR.friend), lc(ADDR.payee2)]),
  destCount: new Map([
    [lc(ADDR.friend), 12n],
    [lc(ADDR.payee2), 12n],
  ]),
  configChangePending: false,
  wallets: [ADDR.w0, ADDR.w1, ADDR.w2],
  walletAddedAt: new Map([ADDR.w0, ADDR.w1, ADDR.w2].map((w) => [lc(w), T_14H - 90n * DAY])),
  delegationTargets: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"],
  delegationOk: [true, true, true],
  reserves: { held: USD(100_000), supply: USD(100_000) },
  requests: new Map(),
  ...over,
});

export const newWorld = (): World => ({
  status: new Map(),
  vaults: new Map(),
  blocked: new Set(),
  lastHeartbeat: 0n,
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

const EMPTY_HASH = `0x${"0".repeat(64)}` as Hex;

class Revert extends Error {}

/** What VaultModule.scoringContext returns for request `id` of `v`. */
export const contextOf = (v: FakeVault, id: bigint): ScoringContext => {
  const r = v.requests.get(id) ?? request({ state: P.REQ_NONE, requestHash: EMPTY_HASH, reasonCodes: 0n });
  const target = v.wallets.findIndex((x) => lc(x) === lc(r.requester));
  return {
    request: r,
    history: v.history,
    destinationCount: v.destCount.get(lc(r.destination)) ?? 0n,
    knownDestination: v.known.has(lc(r.destination)),
    profile: v.profile,
    configChangePending: v.configChangePending,
    requesterAddedAt: v.walletAddedAt.get(lc(r.requester)) ?? 0n,
    requesterDelegation: target >= 0 ? v.delegationTargets[target] : "0x0000000000000000000000000000000000000000",
    walletCount: BigInt(v.wallets.length),
  };
};

function answer(w: World, to: Address, data: Hex): Hex {
  const t = lc(to);
  if (w.failing.has("*")) throw new Revert("all");
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
            .filter(([, r]) => r.state === P.REQ_PENDING)
            .map(([id, r]) => ({
              vault: getAddress(a),
              requestId: id,
              amount: r.amount,
              state: r.state,
              scored: r.scored,
              fastTracked: r.fastTracked,
              executableAt: r.executableAt,
              requestHash: r.requestHash,
            })),
        );
        return out(hubAbi, functionName, rows);
      }
    }
  }
  const v = w.vaults.get(t);
  if (v) {
    const { functionName, args } = route(vaultAbi);
    switch (functionName) {
      case "getRequest":
        return out(vaultAbi, functionName, contextOf(v, args[0] as bigint).request);
      case "openRequestIds":
        return out(
          vaultAbi,
          functionName,
          [...v.requests.entries()].filter(([, r]) => r.state === P.REQ_PENDING).map(([id]) => id),
        );
      case "scoringContext":
        return out(vaultAbi, functionName, contextOf(v, args[0] as bigint));
      case "reserves":
        return out(vaultAbi, functionName, [v.reserves.held, v.reserves.supply]);
      case "delegations":
        return out(vaultAbi, functionName, [v.wallets, v.delegationTargets, v.delegationOk]);
    }
  }
  throw new Revert(`no contract at ${to}`);
}

/** Installs the fake world behind the SDK mocks. Call inside `test()` from @chainlink/cre-sdk/test. */
export function installWorld(w: World) {
  const evm = EvmMock.testInstance(ARC);
  evm.callContract = (req) => {
    w.evmCalls++;
    if (w.failing.has("*")) throw new Error("rpc down");
    const to = bytesToHex(req.call!.to) as Address;
    const data = bytesToHex(req.call!.data) as Hex;
    if (lc(to) === lc(ADDR.multicall3)) {
      const calls = decodeAggregate3(data);
      const results = calls.map((c) => {
        try {
          return { success: true, returnData: answer(w, c.target, c.callData) };
        } catch (e) {
          if (e instanceof Revert) return { success: false, returnData: "0x" as Hex };
          throw e;
        }
      });
      const enc = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
      return { data: Buffer.from(enc.slice(2), "hex").toString("base64") };
    }
    const enc = answer(w, to, data);
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
      body: r.body.case === "bodyString" ? JSON.parse(r.body.value) : {},
      headers,
      secrets: req.vaultDonSecrets.map((s) => s.key),
    });
    return { statusCode: w.notifyStatus };
  };
}
