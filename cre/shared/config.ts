import { getAddress } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Returns `config` with every 20-byte hex string checksummed. viem refuses mixed-case addresses with a
 * wrong checksum, and a hand-edited config must not crash every execution.
 */
export function normalizeAddresses<T>(config: T): T {
  if (typeof config === "string") return (ADDRESS.test(config) ? getAddress(config.toLowerCase()) : config) as T;
  if (Array.isArray(config)) return config.map((v) => normalizeAddresses(v)) as T;
  if (config && typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(config as object).sort()) out[k] = normalizeAddresses((config as Record<string, unknown>)[k]);
    return out as T;
  }
  return config;
}
