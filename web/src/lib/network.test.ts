import { describe, expect, it } from "vitest";
import { sepolia } from "viem/chains";
import { network, wagmiConfig } from "./network";

describe("network", () => {
  it("targets Ethereum Sepolia only", () => {
    expect(wagmiConfig.chains.map((c) => c.id)).toEqual([sepolia.id]);
  });

  it("exposes shared Sepolia addresses from config, not code", () => {
    expect(network.tokens.usdc).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
    expect(network.ensParent).toBe("palmfi.eth");
  });
});
