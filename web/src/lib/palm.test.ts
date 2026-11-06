import { describe, expect, it } from "vitest";
import { decodeReasonCodes, fastTrackNeeded, formatBits, formatUsd, isValidName, parseUsd, vetoNeeded } from "./palm";

describe("palm helpers", () => {
  it("decodes the reason code bitmap", () => {
    const codes = decodeReasonCodes((1n << 1n) | (1n << 2n) | (1n << 10n));
    expect(codes.map((c) => c.code)).toEqual(["NEW_DESTINATION", "OFF_HOURS", "CRE_SILENT"]);
    expect(decodeReasonCodes(0n)).toEqual([]);
  });

  it("formats and parses 6-decimal USD", () => {
    expect(formatUsd(5_000_000n)).toBe("$5.00");
    expect(formatUsd(1_234_567_890n)).toBe("$1,234.56");
    expect(parseUsd("$1,080")).toBe(1_080_000_000n);
    expect(parseUsd("0.5")).toBe(500_000n);
  });

  it("vote thresholds match Vault.vote (requester excluded from veto)", () => {
    expect([3, 4, 5].map(vetoNeeded)).toEqual([2, 2, 3]); // NO*2 > voterCount-1
    expect([3, 4, 5].map(fastTrackNeeded)).toEqual([2, 3, 3]); // YES*2 > voterCount
  });

  it("names and bits", () => {
    expect(isValidName("nvidia")).toBe(true);
    expect(isValidName("Nvidia")).toBe(false);
    expect(formatBits(12345)).toBe("12.3 bits");
  });
});
