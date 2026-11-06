/**
 * Vault-level checks that freeze without any request (issues #11, #12): reserves below supply →
 * RESERVE_FLAG, a Hot wallet delegated (EIP-7702) to an unapproved target → DELEGATION_FLAG.
 * The Hub's onReport freezes the Vault, flips ENS status and emits Flagged; we only write and notify.
 */
import type { Runtime } from "@chainlink/cre-sdk";
import type { Address } from "viem";
import { hubAbi, vaultAbi } from "./abi";
import type { Chain } from "./chain";
import { notify } from "./notify";
import * as P from "./palm";
import { deriveNonce, writeReport, type WriteResult } from "./report";
import { delegationsOk, reservesOk, type ScoringConfig } from "./scoring";

export type HealthFinding = {
  vault: Address;
  reportType: typeof P.REPORT_DELEGATION_FLAG | typeof P.REPORT_RESERVE_FLAG;
  reasonCodes: bigint;
  write?: WriteResult;
  skipped?: "WRITE_BUDGET";
};

const ZERO32 = `0x${"0".repeat(64)}` as const;

/** Read reserves, delegations and status for `vaults` (one EVM call) and return what should be flagged. */
export function inspectVaults(chain: Chain, hub: Address, vaults: Address[]): HealthFinding[] {
  const calls = vaults.flatMap((v) => [
    { to: hub, abi: hubAbi, functionName: "statusOf", args: [v] },
    { to: v, abi: vaultAbi, functionName: "reserves" },
    { to: v, abi: vaultAbi, functionName: "delegations" },
  ]);
  const r = chain.multicall(calls);
  const out: HealthFinding[] = [];
  vaults.forEach((vault, i) => {
    const status = r[i * 3] as number | undefined;
    if (status !== P.STATUS_ACTIVE) return; // Frozen stays Frozen; Migrated/Revoked are terminal
    // A failed read is not evidence: never freeze on missing data (that is HOLD territory).
    if (reservesOk(r[i * 3 + 1]) === false)
      out.push({ vault, reportType: P.REPORT_RESERVE_FLAG, reasonCodes: P.RESERVE_MISMATCH });
    if (delegationsOk(r[i * 3 + 2]) === false)
      out.push({ vault, reportType: P.REPORT_DELEGATION_FLAG, reasonCodes: P.DELEGATION_CHANGED });
  });
  return out;
}

/** Write the findings (one report per Vault and type) and notify the Owner. */
export function flagVaults(
  runtime: Runtime<unknown>,
  chain: Chain,
  cfg: ScoringConfig,
  findings: HealthFinding[],
  opts: { blockTimestamp: bigint; nonceSeed: string; writeBudget: number },
): HealthFinding[] {
  let writes = 0;
  for (const f of findings) {
    if (writes >= opts.writeBudget) {
      f.skipped = "WRITE_BUDGET";
      continue;
    }
    writes++;
    const report: P.Report = {
      reportType: f.reportType,
      vault: f.vault,
      requestId: 0n,
      requestHash: ZERO32,
      verdict: P.VERDICT_FLAG,
      reasonCodes: f.reasonCodes,
      expiry: opts.blockTimestamp + BigInt(cfg.reportTtlSeconds),
      nonce: deriveNonce(opts.nonceSeed, f.vault.toLowerCase(), f.reportType),
    };
    f.write = writeReport(runtime, chain.evm, cfg.hub, report, cfg.gasLimit);
    runtime.log(
      `${f.reportType === P.REPORT_RESERVE_FLAG ? "RESERVE_FLAG" : "DELEGATION_FLAG"} ${f.vault} ` +
        `tx=${f.write.txStatus} receiverReverted=${f.write.receiverReverted}`,
    );
    if (f.write.ok) notify(runtime, cfg.notify, { vault: f.vault, kind: "FLAG", requestId: 0n, reasonCodes: f.reasonCodes });
  }
  return findings;
}
