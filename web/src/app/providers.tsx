"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useState, type ReactNode } from "react";
import { wagmiConfig } from "@/lib/wagmi";

const theme = {
  ...lightTheme({ accentColor: "#1b1b18", accentColorForeground: "#fdfdfb", borderRadius: "large", fontStack: "system", overlayBlur: "small" }),
};
theme.fonts.body = "var(--font-display), ui-sans-serif, system-ui, sans-serif";
theme.colors.modalBackground = "#fdfdfb";
theme.colors.connectButtonBackground = "#f2f1ec";
theme.shadows.connectButton = "none";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 2 } } }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} modalSize="compact">{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
