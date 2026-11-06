import type { NextConfig } from "next";

// Optional deps of the Coinbase CDP SDK and MetaMask SDK (React Native), pulled in transitively by
// wagmi's connector bundle. None of these code paths run in a browser, so stub them out instead of installing them.
const unusedOptionalDeps = [
  "@react-native-async-storage/async-storage",
  "@x402/core/client",
  "@x402/evm",
  "@x402/evm/exact/client",
  "@x402/evm/upto/client",
  "@x402/svm/exact/client",
];

const nextConfig: NextConfig = {
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...Object.fromEntries(unusedOptionalDeps.map((m) => [m, false])),
    };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
