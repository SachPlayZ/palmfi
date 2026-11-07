import { createPublicClient, parseAbi, type Address } from "viem";
import { arcTransport } from "@/lib/rpc";
import { arcTestnet } from "../network";
import { kvFromEnv } from "./kv";
import { botTokenOf, type Deps, type TelegramUpdate } from "./handlers";

const vaultRoles = parseAbi(["function recoveryKey() view returns (address)", "function isWallet(address) view returns (bool)"]);

async function isController(vault: Address, signer: Address): Promise<boolean> {
  const client = createPublicClient({ chain: arcTestnet, transport: arcTransport(process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL) });
  try {
    const [recovery, wallet] = await Promise.all([
      client.readContract({ address: vault, abi: vaultRoles, functionName: "recoveryKey" }),
      client.readContract({ address: vault, abi: vaultRoles, functionName: "isWallet", args: [signer] }),
    ]);
    return wallet || recovery.toLowerCase() === signer.toLowerCase();
  } catch {
    return false; // not a Vault
  }
}

export function serverDeps(): Deps {
  return { env: process.env, kv: kvFromEnv(), fetch, isController };
}

/** Drains the bot's pending updates via getUpdates (only used when no webhook is set, e.g. local dev). */
export async function pollTelegram(): Promise<TelegramUpdate[]> {
  const token = botTokenOf(process.env);
  if (!token) return [];
  const g = globalThis as { __palmfiTgOffset?: number };
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=0&offset=${g.__palmfiTgOffset ?? 0}`, { cache: "no-store" });
  const body = (await res.json()) as { ok: boolean; result?: (TelegramUpdate & { update_id: number })[] };
  if (!body.ok || !body.result?.length) return [];
  g.__palmfiTgOffset = Math.max(...body.result.map((u) => u.update_id)) + 1;
  return body.result;
}
