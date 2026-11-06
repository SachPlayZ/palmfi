import { describe, expect, it } from "vitest";
import { REQ } from "./palm";
import { requestTimeline, voteProgress } from "./requests";

const base = { state: REQ.PENDING, createdAt: 1000n, executableAt: 1000n + 3600n, executable: false, scored: false, fastTracked: false };

describe("requestTimeline", () => {
  it("unscored → MaxDelay wording", () => {
    expect(requestTimeline(base, 1000).text).toContain("Not scored yet");
  });
  it("scored → Sentinel delay countdown", () => {
    expect(requestTimeline({ ...base, scored: true }, 1000).text).toBe("Delay set by the Sentinel: executable in 1h 0m");
  });
  it("fast-tracked and ready states", () => {
    expect(requestTimeline({ ...base, fastTracked: true }, 1000).text).toContain("Fast-tracked");
    expect(requestTimeline({ ...base, executable: true }, 9000).ready).toBe(true);
  });
  it("expired after 7 days", () => {
    expect(requestTimeline(base, 1000 + 7 * 86400 + 1).expired).toBe(true);
  });
  it("closed states show their label", () => {
    expect(requestTimeline({ ...base, state: REQ.VETOED }, 0).text).toBe("Vetoed");
  });
});

describe("voteProgress", () => {
  it("5 Voters: 3 NO of the other 4 veto, 3 YES fast-track", () => {
    expect(voteProgress({ voterCount: 5, yes: 1, no: 2 })).toEqual({ veto: { have: 2, need: 3 }, fastTrack: { have: 1, need: 3 } });
  });
});
