/**
 * PalmTypes.Report encoding and the forwarder write. A write "succeeds" only when the tx succeeded AND the
 * Hub's onReport did not revert (receiverContractExecutionStatus). Even then the Hub may have dropped the
 * report as ReportRejected (ADR-0005), so callers that care read state back (the Reconciler does).
 */
import { EVMClient, hexToBase64, TxStatus, type Runtime } from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import { bytesToHex, decodeAbiParameters, encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import type { Report } from "./palm";

const REPORT_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "reportType", type: "uint8" },
      { name: "vault", type: "address" },
      { name: "requestId", type: "uint256" },
      { name: "requestHash", type: "bytes32" },
      { name: "verdict", type: "uint8" },
      { name: "reasonCodes", type: "uint256" },
      { name: "expiry", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  },
] as const;

/** abi.encode(PalmTypes.Report): what Hub.decodeReport expects. */
export const encodeReport = (r: Report): Hex => encodeAbiParameters(REPORT_TUPLE, [r]);

export const decodeReport = (data: Hex): Report => {
  const [r] = decodeAbiParameters(REPORT_TUPLE, data);
  return { ...r };
};

/** Deterministic nonce from trigger-derived data (every DON node computes the same value). */
export const deriveNonce = (...parts: (bigint | number | string)[]): bigint =>
  BigInt(keccak256(toHex(parts.map(String).join("|"))));

export type WriteResult = {
  ok: boolean;
  txStatus: string;
  receiverReverted: boolean;
  txHash?: Hex;
  error?: string;
};

export function writeReport(
  runtime: Runtime<unknown>,
  evm: EVMClient,
  hub: Address,
  report: Report,
  gasLimit: string,
): WriteResult {
  try {
    const signed = runtime
      .report({
        encodedPayload: hexToBase64(encodeReport(report)),
        encoderName: "evm",
        signingAlgo: "ecdsa",
        hashingAlgo: "keccak256",
      })
      .result();
    const reply = evm.writeReport(runtime, { receiver: hub, report: signed, gasConfig: { gasLimit } }).result();
    const receiverReverted =
      reply.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED;
    const ok = reply.txStatus === TxStatus.SUCCESS && !receiverReverted;
    return {
      ok,
      txStatus: TxStatus[reply.txStatus] ?? String(reply.txStatus),
      receiverReverted,
      txHash: reply.txHash && reply.txHash.length > 0 ? bytesToHex(reply.txHash) : undefined,
      error: reply.errorMessage || undefined,
    };
  } catch (e) {
    return { ok: false, txStatus: "ERROR", receiverReverted: false, error: String(e) };
  }
}
