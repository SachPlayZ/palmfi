/**
 * Owner notifications (issue #8): the web app's /notify endpoint, called over Confidential HTTP so the API
 * key is injected from Vault DON secrets inside the enclave and never appears in workflow memory.
 *
 * Endpoint contract: POST {vault, kind: "HOLD"|"FLAG"|"CONFIG_CHANGE", requestId, reasonCodes}
 * with header `x-api-key`. requestId and reasonCodes are decimal strings (uint256 does not fit a JSON number).
 * The endpoint must be idempotent: CRE may retry.
 */
import { ConfidentialHTTPClient, type Runtime } from "@chainlink/cre-sdk";
import type { Address } from "viem";

export type NotifyKind = "HOLD" | "FLAG" | "CONFIG_CHANGE";

export type NotifyConfig = {
  /** Full URL of the /notify endpoint; empty disables notifications. */
  url: string;
  /** Vault DON secret id holding the API key (declared in cre/secrets.yaml). */
  apiKeySecret: string;
  /** Owner of the Vault DON secret (the workflow owner address); omit in simulation. */
  secretOwner?: string;
};

export type NotifyMessage = { vault: Address; kind: NotifyKind; requestId: bigint; reasonCodes: bigint };

export const notifyBody = (m: NotifyMessage): string =>
  JSON.stringify({
    vault: m.vault,
    kind: m.kind,
    requestId: m.requestId.toString(),
    reasonCodes: m.reasonCodes.toString(),
  });

/** Sends one notification. Never throws: a failed notification must not undo a written Verdict. */
export function notify(runtime: Runtime<unknown>, cfg: NotifyConfig, m: NotifyMessage): { ok: boolean; status?: number } {
  if (!cfg.url) return { ok: false };
  try {
    const res = new ConfidentialHTTPClient()
      .sendRequest(runtime, {
        vaultDonSecrets: [{ key: cfg.apiKeySecret, ...(cfg.secretOwner ? { owner: cfg.secretOwner } : {}) }],
        request: {
          url: cfg.url,
          method: "POST",
          bodyString: notifyBody(m),
          multiHeaders: {
            "content-type": { values: ["application/json"] },
            "x-api-key": { values: [`{{.${cfg.apiKeySecret}}}`] },
          },
          timeout: "10s",
          encryptOutput: false,
        },
      })
      .result();
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    if (!ok) runtime.log(`notify ${m.kind} ${m.vault}: HTTP ${res.statusCode}`);
    return { ok, status: res.statusCode };
  } catch (e) {
    runtime.log(`notify ${m.kind} ${m.vault} failed: ${String(e)}`);
    return { ok: false };
  }
}
