import {
  bytesToHex,
  CronCapability,
  encodeCallMsg,
  EVMClient,
  getNetwork,
  handler,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, zeroAddress, type Address, type Hex } from "viem";

export type Config = {
  schedule: string;
  chainSelectorName: string;
  ethUsdFeed: Address;
};

export const aggregatorV3Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

const callFeed = (runtime: Runtime<Config>, evm: EVMClient, data: Hex): Hex => {
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: runtime.config.ethUsdFeed, data }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  return bytesToHex(reply.data);
};

/** Proves the CRE wiring end to end: a cron run reads a real Chainlink feed on Ethereum Sepolia. */
export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const net = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.chainSelectorName });
  if (!net) throw new Error(`unknown chain ${runtime.config.chainSelectorName}`);
  const evm = new EVMClient(net.chainSelector.selector);

  const decimals = decodeFunctionResult({
    abi: aggregatorV3Abi,
    functionName: "decimals",
    data: callFeed(runtime, evm, encodeFunctionData({ abi: aggregatorV3Abi, functionName: "decimals" })),
  });
  const [, answer] = decodeFunctionResult({
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
    data: callFeed(runtime, evm, encodeFunctionData({ abi: aggregatorV3Abi, functionName: "latestRoundData" })),
  });

  const price = `ETH/USD ${formatUnits(answer, decimals)}`;
  runtime.log(price);
  return price;
};

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger),
];

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
