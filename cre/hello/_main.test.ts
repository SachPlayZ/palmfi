import { describe, expect } from "bun:test";
import { getNetwork } from "@chainlink/cre-sdk";
import { addContractMock, EvmMock, newTestRuntime, test } from "@chainlink/cre-sdk/test";
import { aggregatorV3Abi, initWorkflow, onCronTrigger, type Config } from "./main";

const config: Config = {
  schedule: "*/30 * * * * *",
  chainSelectorName: "ethereum-testnet-sepolia",
  ethUsdFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
};

describe("hello workflow", () => {
  test("reads ETH/USD from the Sepolia Chainlink feed", async () => {
    const selector = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName })!.chainSelector
      .selector;
    const feed = addContractMock(EvmMock.testInstance(selector), { address: config.ethUsdFeed, abi: aggregatorV3Abi });
    feed.decimals = () => 8;
    feed.latestRoundData = () => [1n, 222359000000n, 0n, 1_700_000_000n, 1n];

    const runtime = newTestRuntime();
    runtime.config = config;

    expect(onCronTrigger(runtime)).toBe("ETH/USD 2223.59");
  });

  test("registers one cron handler on the configured schedule", async () => {
    const handlers = initWorkflow(config);

    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe(config.schedule);
  });
});
