import { FAIL_OPEN_DELAY, REQ, REQ_LABEL, REQUEST_TTL, formatDuration } from "./palm";
import type { VaultRequest } from "./vault";

export const isOpen = (s: number) => s === REQ.PENDING || s === REQ.CLEARED || s === REQ.HELD;

/** What the request is waiting for, and when it can execute. */
export function requestTimeline(
  r: Pick<VaultRequest, "state" | "createdAt" | "executableAt" | "executable" | "secondFactor" | "recoveryApproved">,
  institution: boolean, floorDelay: number, now: number) {
  const created = Number(r.createdAt);
  const expiresIn = created + REQUEST_TTL - now;
  if (!isOpen(r.state)) return { text: REQ_LABEL[r.state] } as { text: string; expired?: boolean; ready?: boolean; needs2fa?: boolean };
  if (expiresIn <= 0) return { text: "Expired (7 days): anyone can close it to refund", expired: true };
  if (r.executable) return { text: "Executable now", ready: true };
  if (r.state === REQ.PENDING) {
    if (institution) {
      const parts = [r.secondFactor ? "Payout approval ✓" : "needs Payout approval", r.recoveryApproved ? "Recovery key ✓" : "needs Recovery key"];
      const floorIn = created + floorDelay - now;
      return { text: `Awaiting Verdict. Fail-closed path: ${parts.join(", ")}${floorIn > 0 ? `, Floor in ${formatDuration(floorIn)}` : ""}` };
    }
    return { text: `Awaiting Verdict. If CRE stays silent it becomes executable in ${formatDuration(created + FAIL_OPEN_DELAY - now)}` };
  }
  if (r.executableAt > 0n) return { text: `Executable in ${formatDuration(Number(r.executableAt) - now)}` };
  return { text: "Held: confirm with your Second factor or it expires", needs2fa: true };
}

