import type { NextConfig } from "next";

// Optional deps of the Coinbase CDP SDK (pulled in transitively by wagmi's connector bundle).
// None of these code paths run in palmfi, so stub them out instead of installing them.
const unusedOptionalDeps = [
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
