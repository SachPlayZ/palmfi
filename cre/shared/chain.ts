/**
 * Chain reads for the workflows. CRE allows 15 EVM calls per execution and has no multicall helper, so every
 * fact read goes through one Multicall3 `aggregate3` (allowFailure on), which also pins all facts of a phase
 * to one block. A sub-call that fails, or a capability call that errors, comes back `undefined`, and the
 * decision engine turns `undefined` into HOLD (API_UNAVAILABLE).
 */
import {
  bytesToHex,
  encodeCallMsg,
  EVMClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  blockNumber as pbBlockNumber,
  protoBigIntToBigint,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { multicall3Abi } from "./abi";

export type BlockRef = "latest" | "finalized" | bigint;

export type Call = {
  to: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Raw calldata instead of abi/functionName (e.g. the ecrecover precompile). */
  data?: Hex;
};

const blockArg = (at: BlockRef) =>
  at === "latest" ? LATEST_BLOCK_NUMBER : at === "finalized" ? LAST_FINALIZED_BLOCK_NUMBER : pbBlockNumber(at);

export class Chain {
  /** EVM capability calls made in this execution (quota: 15). */
  calls = 0;

  constructor(
    readonly runtime: Runtime<unknown>,
    readonly evm: EVMClient,
    readonly multicall3: Address,
  ) {}

  /** One eth_call; undefined on any capability error. */
  callRaw(to: Address, data: Hex, at: BlockRef = "latest"): Hex | undefined {
    this.calls++;
    try {
      const reply = this.evm
        .callContract(this.runtime, { call: encodeCallMsg({ from: zeroAddress, to, data }), blockNumber: blockArg(at) })
        .result();
      return bytesToHex(reply.data);
    } catch (e) {
      this.runtime.log(`callContract ${to} failed: ${String(e)}`);
      return undefined;
    }
  }

  /** Decoded results of `calls`, read in one Multicall3 call at `at`. Failed entries are `undefined`. */
  // biome-ignore lint/suspicious/noExplicitAny: results are heterogenous; call sites cast to the ABI's type
  multicall(calls: Call[], at: BlockRef = "latest"): any[] {
    if (calls.length === 0) return [];
    const encoded = calls.map((c) => ({
      target: c.to,
      allowFailure: true,
      callData:
        c.data ?? encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as never),
    }));
    const raw = this.callRaw(
      this.multicall3,
      encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [encoded] }),
      at,
    );
    if (raw === undefined) return calls.map(() => undefined);
    let results: readonly { success: boolean; returnData: Hex }[];
    try {
      results = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: raw });
    } catch {
      return calls.map(() => undefined);
    }
    return calls.map((c, i) => {
      const r = results[i];
      if (!r || !r.success) return undefined;
      if (c.data) return r.returnData;
      if (r.returnData === "0x") return undefined;
      try {
        return decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: r.returnData } as never);
      } catch {
        return undefined;
      }
    });
  }

  /** Block timestamp (seconds) from the block header; latest when `n` is omitted. */
  blockTimestamp(n?: bigint): { timestamp: bigint; number?: bigint } | undefined {
    this.calls++;
    try {
      const reply = this.evm
        .headerByNumber(this.runtime, n === undefined ? {} : { blockNumber: pbBlockNumber(n) })
        .result();
      if (!reply.header) return undefined;
      const bn = reply.header.blockNumber;
      return {
        timestamp: reply.header.timestamp,
        number: bn ? protoBigIntToBigint(bn) : undefined,
      };
    } catch (e) {
      this.runtime.log(`headerByNumber failed: ${String(e)}`);
      return undefined;
    }
  }
}

/** Test helper: decode one Multicall3 aggregate3 calldata into its sub-calls. */
export const decodeAggregate3 = (data: Hex): { target: Address; callData: Hex }[] => {
  const { args } = decodeFunctionData({ abi: multicall3Abi, data });
  return (args[0] as readonly { target: Address; callData: Hex }[]).map((c) => ({
    target: c.target,
    callData: c.callData,
  }));
};
