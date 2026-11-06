import { createPublicClient, http, parseAbi, type Address } from "viem";
import { sepolia } from "viem/chains";
import { kvFromEnv } from "./kv";
import type { Deps } from "./handlers";

const vaultRoles = parseAbi([
  "function owner() view returns (address)",
  "function recoveryKey() view returns (address)",
  "function isHotWallet(address) view returns (bool)",
]);

async function isController(vault: Address, signer: Address): Promise<boolean> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL),
  });
  try {
    const [owner, recovery, hot] = await Promise.all([
      client.readContract({ address: vault, abi: vaultRoles, functionName: "owner" }),
      client.readContract({ address: vault, abi: vaultRoles, functionName: "recoveryKey" }),
      client.readContract({ address: vault, abi: vaultRoles, functionName: "isHotWallet", args: [signer] }),
    ]);
    return hot || owner.toLowerCase() === signer.toLowerCase() || recovery.toLowerCase() === signer.toLowerCase();
  } catch {
    return false; // not a Vault
  }
}

export function serverDeps(): Deps {
  return { env: process.env, kv: kvFromEnv(), fetch, isController };
}
