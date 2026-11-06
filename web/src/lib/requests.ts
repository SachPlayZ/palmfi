import { REQ, REQ_LABEL, REQUEST_TTL, fastTrackNeeded, formatDuration, vetoNeeded } from "./palm";
import type { VaultRequest } from "./vault";

/** What the request is waiting for, and when it can execute. */
export function requestTimeline(r: Pick<VaultRequest, "state" | "createdAt" | "executableAt" | "executable" | "scored" | "fastTracked">, now: number) {
  const created = Number(r.createdAt);
  const expiresIn = created + REQUEST_TTL - now;
  type T = { text: string; expired?: boolean; ready?: boolean };
  if (r.state !== REQ.PENDING) return { text: REQ_LABEL[r.state] ?? "?" } as T;
  if (expiresIn <= 0) return { text: "Expired (7 days): anyone can close it to refund the bond", expired: true } as T;
  if (r.executable) return { text: "Executable now", ready: true } as T;
  const left = formatDuration(Number(r.executableAt) - now);
  if (r.fastTracked) return { text: `Fast-tracked by a majority: executable in ${left}` } as T;
  if (!r.scored) return { text: `Not scored yet: executable in ${left} (MaxDelay) unless the Sentinel shortens it` } as T;
  return { text: `Delay set by the Sentinel: executable in ${left}` } as T;
}

/** Vote progress: NOs needed to veto (requester excluded), YESes needed to fast-track. */
export function voteProgress(r: Pick<VaultRequest, "voterCount" | "yes" | "no">) {
  return {
    veto: { have: r.no, need: vetoNeeded(r.voterCount) },
    fastTrack: { have: r.yes, need: fastTrackNeeded(r.voterCount) },
  };
}
