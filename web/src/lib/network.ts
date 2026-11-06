import { defineChain, type Address } from "viem";
import arcConfig from "../../../config/arc.json";

/** Arc testnet (Circle's USDC-native L1): USDC is gas (18 dp native) and an ERC-20 at 0x3600… (6 dp). */
export const arcTestnet = defineChain({
  id: arcConfig.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [arcConfig.rpc] } },
  blockExplorers: { default: { name: "Arcscan", url: arcConfig.explorer } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/** Shared Arc addresses (config/arc.json), the same file the contracts and CRE read. */
export const network = {
  chainId: arcConfig.chainId,
  explorer: arcConfig.explorer,
  usdc: arcConfig.tokens.usdc as Address,
  poolManager: arcConfig.uniswap.poolManager as Address,
};

export const txUrl = (hash: string) => `${network.explorer}/tx/${hash}`;
export const addressUrl = (a: string) => `${network.explorer}/address/${a}`;
