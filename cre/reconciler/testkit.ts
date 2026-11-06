/** Test fixtures for the Reconciler (no tests here, so importing is side-effect free). */
import { DEFAULT_PARAMS } from "../shared/deviation";
import { ADDR } from "../shared/testing";
import type { Config } from "./main";

export const config: Config = {
  schedule: "0 */1 * * * *",
  chainSelectorName: "arc-testnet",
  chainId: 5042002,
  hub: ADDR.hub,
  multicall3: ADDR.multicall3,
  reportTtlSeconds: 900,
  gasLimit: "1500000",
  maxWritesPerRun: 8,
  maxScorePerRun: 10,
  vaultPageSize: 50,
  scoring: DEFAULT_PARAMS,
  notifyDelaySeconds: 6 * 3600,
  notify: { url: "https://palmfi.example/api/notify", apiKeySecret: "notifyApiKey" },
};
