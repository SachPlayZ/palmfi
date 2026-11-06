import { describe, expect, test } from "bun:test";
import * as P from "./palm";

// node:fs is typed `never` by the SDK (WASM has no fs), so read through Bun.
const SOL = await Bun.file(`${import.meta.dir}/../../contracts/src/libraries/PalmTypes.sol`).text();
const VAULT = await Bun.file(`${import.meta.dir}/../../contracts/src/Vault.sol`).text();

/** Every `uintN internal constant NAME = VALUE;` in PalmTypes.sol, with `1 << n` evaluated. */
const solConstants = (): Map<string, bigint> => {
  const out = new Map<string, bigint>();
  const re = /uint\d+\s+internal\s+constant\s+(\w+)\s*=\s*([^;]+);/g;
  for (const m of SOL.matchAll(re)) {
    const expr = m[2].trim();
    const shift = expr.match(/^(\d+)\s*<<\s*(\d+)$/);
    out.set(m[1], shift ? BigInt(shift[1]) << BigInt(shift[2]) : BigInt(expr));
  }
  return out;
};

describe("palm.ts mirrors PalmTypes.sol", () => {
  const sol = solConstants();

  test("PalmTypes.sol was parsed", () => {
    expect(sol.size).toBeGreaterThan(50);
  });

  for (const [name, value] of solConstants()) {
    test(name, () => {
      const ts = (P as Record<string, unknown>)[name];
      expect(ts === undefined ? undefined : BigInt(ts as number | bigint)).toBe(value);
    });
  }

  test("Report struct field order", () => {
    const body = SOL.match(/struct Report \{([^}]+)\}/)![1];
    const fields = [...body.matchAll(/(\w+)\s+(\w+);/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(fields).toEqual([
      "uint8 reportType",
      "address vault",
      "uint256 requestId",
      "bytes32 requestHash",
      "uint8 verdict",
      "uint256 reasonCodes",
      "uint64 expiry",
      "uint256 nonce",
    ]);
  });

  test("Vault.STALENESS_MARGIN", () => {
    expect(VAULT).toContain("STALENESS_MARGIN = 1 hours;");
    expect(P.STALENESS_MARGIN).toBe(3600n);
  });
});
