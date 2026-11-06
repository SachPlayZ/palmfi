import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, rainbowWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { arcTestnet } from "./network";

// Explicit wallet list: the default one pulls in the Coinbase SDK and its unresolvable optional deps.
// WalletConnect-based wallets only appear once a real project id is configured.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const connectors = connectorsForWallets(
  [
    {
      groupName: "Wallets",
      wallets: walletConnectProjectId
        ? [metaMaskWallet, rainbowWallet, injectedWallet, walletConnectWallet]
        : [injectedWallet],
    },
  ],
  { appName: "palmfi", projectId: walletConnectProjectId ?? "" },
);

export const wagmiConfig = createConfig({
  connectors,
  chains: [arcTestnet],
  // Batch concurrent reads into one JSON-RPC request: the public Arc endpoint rate-limits bursts.
  transports: { [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_RPC_URL || arcTestnet.rpcUrls.default.http[0], { batch: { wait: 16 } }) },
  ssr: true,
});
