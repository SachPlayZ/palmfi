import { describe, expect, it } from "vitest";
import { network } from "./network";
import { wagmiConfig } from "./wagmi";

describe("network", () => {
  it("targets Arc testnet only", () => {
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([5042002]);
  });

  it("exposes shared Arc addresses from config, not code", () => {
    expect(network.usdc).toBe("0x3600000000000000000000000000000000000000");
    expect(network.poolManager).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
