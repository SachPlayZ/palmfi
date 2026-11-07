import { fallback, http, type Transport } from "viem";
import arcConfig from "../../../config/arc.json";

/**
 * Arc RPC endpoints, best first: an env override, the official endpoint, then dRPC's public mirror.
 * The public endpoint rate-limits bursts and sometimes drops or empties responses, so every read
 * retries with backoff and then fails over to the next endpoint instead of surfacing an error.
 */
export function arcRpcUrls(override?: string): string[] {
  return [...new Set([override, arcConfig.rpc, "https://arc-testnet.drpc.org"].filter((u): u is string => !!u))];
}

export function arcTransport(override?: string, opts: { batch?: boolean } = {}): Transport {
  return fallback(
    arcRpcUrls(override).map((url) =>
      http(url, { batch: opts.batch ? { wait: 16 } : false, retryCount: 3, retryDelay: 400, timeout: 12_000 }),
    ),
    { rank: false, retryCount: 2 },
  );
}
