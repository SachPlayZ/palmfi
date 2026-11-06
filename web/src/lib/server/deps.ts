import { createPublicClient, http, parseAbi, type Address } from "viem";
import { arcTestnet } from "../network";
import { kvFromEnv } from "./kv";
import type { Deps } from "./handlers";

const vaultRoles = parseAbi(["function recoveryKey() view returns (address)", "function isWallet(address) view returns (bool)"]);

async function isController(vault: Address, signer: Address): Promise<boolean> {
  const client = createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL) });
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
