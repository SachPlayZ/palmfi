import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import type { Address } from "viem";
import sepoliaConfig from "../../../config/sepolia.json";

/** Shared Sepolia addresses (config/sepolia.json), the same file the contracts and CRE read. */
export const network = {
  chainId: sepoliaConfig.chainId,
  tokens: sepoliaConfig.tokens as Record<"usdc" | "weth" | "link", Address>,
  uniswap: sepoliaConfig.uniswap as Record<keyof typeof sepoliaConfig.uniswap, Address>,
  feeds: sepoliaConfig.feeds as Record<keyof typeof sepoliaConfig.feeds, Address>,
  ensParent: `${sepoliaConfig.ens.parentLabel}.eth`,
};

// Explicit wallet list: the default one pulls in the Coinbase SDK and its unresolvable optional deps.
const connectors = connectorsForWallets(
  [{ groupName: "Wallets", wallets: [metaMaskWallet, rainbowWallet, injectedWallet, walletConnectWallet] }],
  {
    appName: "palmfi",
    // Injected wallets work without one; set a real WalletConnect project id for mobile wallets.
    projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "palmfi-dev",
  },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [sepolia],
  transports: { [sepolia.id]: http(process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL) },
  ssr: true,
});
