/** Test fixtures for the Reconciler (no tests here, so importing is side-effect free). */
import type { Hex } from "viem";
import { ADDR } from "../shared/testing";
import type { Config } from "./main";

export const POOL_ID = `0x${"5a".repeat(32)}` as Hex;

export const config: Config = {
  schedule: "0 */1 * * * *",
  chainSelectorName: "ethereum-testnet-sepolia",
  chainId: 11155111,
  hub: ADDR.hub,
  multicall3: ADDR.multicall3,
  reportTtlSeconds: 900,
  gasLimit: "1500000",
  maxWritesPerRun: 8,
  maxScorePerRun: 10,
  vaultPageSize: 50,
  volatileMoveBps: 1000,
  assets: [
    {
      name: "WETH",
      underlying: ADDR.weth,
      feed: ADDR.ethUsd,
      heartbeat: 3600,
      pool: {
        stateView: ADDR.stateView,
        poolId: POOL_ID,
        quote: ADDR.usdc,
        quoteDecimals: 6,
        quoteFeed: ADDR.usdcUsd,
        baseDecimals: 18,
      },
    },
    { name: "USDC", underlying: ADDR.usdc, feed: ADDR.usdcUsd, heartbeat: 86400 },
  ],
  notify: { url: "https://palmfi.example/api/notify", apiKeySecret: "notifyApiKey" },
};

