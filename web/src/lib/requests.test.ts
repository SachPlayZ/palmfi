import { describe, expect, it } from "vitest";
import { REQ } from "./palm";
import { requestTimeline } from "./requests";

const base = { createdAt: 1000n, executableAt: 0n, executable: false, secondFactor: false, recoveryApproved: false };

describe("requestTimeline", () => {
  it("counts down an Individual's fail-open path while Pending", () => {
    expect(requestTimeline({ ...base, state: REQ.PENDING }, false, 300, 1000).text).toContain("3d 0h");
  });
  it("shows the Institution fail-closed requirements", () => {
    const t = requestTimeline({ ...base, state: REQ.PENDING, secondFactor: true }, true, 300, 1100).text;
    expect(t).toContain("Payout approval ✓");
    expect(t).toContain("needs Recovery key");
    expect(t).toContain("Floor in 3m 20s");
  });
  it("asks for a Second factor on an unconfirmed HOLD", () => {
    expect(requestTimeline({ ...base, state: REQ.HELD }, false, 300, 1100).needs2fa).toBe(true);
  });
  it("counts down to executableAt once Cleared", () => {
    expect(requestTimeline({ ...base, state: REQ.CLEARED, executableAt: 1300n }, false, 300, 1100).text).toBe("Executable in 3m 20s");
  });
  it("marks expiry after 7 days and terminal states", () => {
    expect(requestTimeline({ ...base, state: REQ.HELD }, false, 300, 1000 + 7 * 86400 + 1).expired).toBe(true);
    expect(requestTimeline({ ...base, state: REQ.FLAGGED }, false, 300, 1100).text).toBe("Flagged");
  });
});
