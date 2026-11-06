import { describe, expect, it } from "vitest";
import { decodeDnsName, decodeReasonCodes, formatUsd, labelFromName, parseTokensRecord, parseUsd } from "./palm";

describe("palm helpers", () => {
  it("decodes the reason code bitmap", () => {
    const codes = decodeReasonCodes((1n << 0n) | (1n << 2n) | (1n << 9n));
    expect(codes.map((c) => c.code)).toEqual(["NEW_DESTINATION", "BLOCKLISTED_DEST", "CONFIG_CHANGE_PENDING"]);
    expect(decodeReasonCodes(0n)).toEqual([]);
  });

  it("formats and parses 6-decimal USD", () => {
    expect(formatUsd(5_000_000n)).toBe("$5.00");
    expect(formatUsd(1_234_567_890n)).toBe("$1,234.56");
    expect(parseUsd("$80")).toBe(80_000_000n);
    expect(parseUsd("0.5")).toBe(500_000n);
  });

  it("extracts labels under the parent name", () => {
    expect(labelFromName("Alice.palmfi.eth", "palmfi.eth")).toBe("alice");
    expect(labelFromName("nvidia", "palmfi.eth")).toBe("nvidia");
    expect(labelFromName("bad_name", "palmfi.eth")).toBeNull();
  });

  it("parses the tokens record", () => {
    expect(
      parseTokensRecord("pUSDC:0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,pWETH:0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"),
    ).toHaveLength(2);
    expect(parseTokensRecord("")).toEqual([]);
  });

  it("decodes DNS wire names", () => {
    expect(decodeDnsName("0x05616c6963650670616c6d666903657468" + "00")).toBe("alice.palmfi.eth");
  });
});
