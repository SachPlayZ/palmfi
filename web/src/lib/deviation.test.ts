import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** web/src/lib/deviation.ts is a copy of cre/shared/deviation.ts: the UI explains scores with the Sentinel's own math. */
describe("deviation.ts mirrors the Sentinel", () => {
  it("is identical apart from the codes import", () => {
    const cre = readFileSync(join(__dirname, "../../../cre/shared/deviation.ts"), "utf8");
    const web = readFileSync(join(__dirname, "deviation.ts"), "utf8");
    expect(web.replace('from "./deviation-codes";', 'from "./palm";')).toBe(cre);
  });
});
