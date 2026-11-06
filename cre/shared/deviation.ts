/**
 * Deviation score (brief §7.2, ADR-0009): how surprising is this queued request, in bits, given the Vault's
 * last 32 executed outflows (VaultModule.scoringContext) and its onboarding profile?
 *
 *   S = S_amount + S_dest + S_time + S_velocity + S_flags      (wallet scope and Vault scope; take the max)
 *   delay = clamp(Floor · 2^(S/k), Floor, MaxDelay); over the Hard cap ≥ CapDelay; S ≥ S_flag → FLAG
 *
 * Pure and integer-only (bigint fixed point, milli-bits): every DON node must reach the same bytes.
 * Everything is measured at the request's own createdAt, so a late re-score (Reconciler) gives the same answer.
 */
import { BLOCKLISTED_DEST, CONFIG_CHANGE_PENDING, NEW_DESTINATION, NEW_WALLET, OFF_HOURS, OVER_HARD_CAP, UNUSUAL_AMOUNT, VELOCITY } from "./palm";

type Hex = `0x${string}`;

/** VaultModule.ScoringContext as viem decodes it. */
export type ScoringContext = {
  request: {
    destination: Hex;
    requester: Hex;
    amount: bigint;
    createdAt: bigint;
    executableAt: bigint;
    state: number;
    kind: number;
    fastTracked: boolean;
    scored: boolean;
    voterCount: number;
    yes: number;
    no: number;
    score: number;
    reasonCodes: bigint;
    requestHash: Hex;
  };
  history: readonly { wallet: Hex; destination: Hex; amount: bigint; timestamp: bigint }[];
  destinationCount: bigint;
  knownDestination: boolean;
  profile: {
    bizStartHourUtc: number;
    bizEndHourUtc: number;
    usualMaxPayout: bigint;
    hardCap: bigint;
    floorDelay: number;
    maxDelay: number;
    capDelay: number;
  };
  configChangePending: boolean;
  requesterAddedAt: bigint;
  requesterDelegation: Hex;
  walletCount: bigint;
};

export type Params = {
  /** Bits per doubling of the delay (milli-bits). */
  k: number;
  /** Score at or above which the request is FLAGged (milli-bits). */
  sFlag: number;
};
export const DEFAULT_PARAMS: Params = { k: 2500, sFlag: 28000 };

/** Per-term milli-bits, carried to notifications and the UI ("+9 bits: new destination"). */
export type Terms = { amount: number; dest: number; time: number; velocity: number; flags: number };

export type Assessment = {
  action: "DELAY" | "FLAG";
  /** Total milli-bits of the winning scope (fits PalmTypes uint32). */
  score: number;
  /** Seconds after createdAt (ignored for FLAG). */
  delay: bigint;
  reasonCodes: bigint;
  scope: "wallet" | "vault";
  terms: Terms;
};

// ---------- fixed-point helpers ----------

const ONE = 1_000_000n; // 1e6 scale for ratios
const LOG2E_MILLI = 1443n; // log2(e) · 1000
const MIN_SAMPLES = 8; // fewer → amount baseline comes from the profile
const MAD_FLOOR = 500n; // milli-bits: never trust a baseline tighter than ±√2×
const NEW_WALLET_AGE = 7n * 86400n;
const FLAG_BITS = 4000n; // CONFIG_CHANGE_PENDING, NEW_WALLET
const DEST_PRIOR = 8n; // pseudo-count a whitelisted destination gets
const HOUR_PRIOR = 2n; // pseudo-count per business hour
const MIN_SPAN = 7n * 86400n; // rate λ is measured over at least a week

const bitLength = (x: bigint) => x.toString(2).length;

/** floor(1000 · log2(x)) for x ≥ 1, by repeated squaring (20 fractional bits). */
export const log2Milli = (x: bigint): bigint => {
  if (x < 1n) throw new Error("log2Milli: x < 1");
  const n = BigInt(bitLength(x) - 1);
  const SCALE = 64n;
  let m = n <= SCALE ? x << (SCALE - n) : x >> (n - SCALE); // m ∈ [2^64, 2^65)
  let frac = 0n;
  for (let i = 0; i < 20; i++) {
    m = (m * m) >> SCALE;
    frac <<= 1n;
    if (m >= 1n << (SCALE + 1n)) {
      m >>= 1n;
      frac |= 1n;
    }
  }
  return n * 1000n + ((frac * 1000n) >> 20n);
};

/** 2^(i/8) · 1e6, i = 0..8: linear interpolation keeps exp2 within 0.5%. */
const EXP2_TABLE = [1000000n, 1090508n, 1189207n, 1296840n, 1414214n, 1542211n, 1681793n, 1834008n, 2000000n];

/** floor(base · 2^(milli/1000)), base ≥ 0, milli ≥ 0. */
export const mulExp2 = (base: bigint, milli: bigint): bigint => {
  const q = milli / 1000n;
  const f = milli % 1000n; // [0, 1000)
  const i = (f * 8n) / 1000n;
  const r = f * 8n - i * 1000n; // remainder within the 1/8 step, out of 1000
  const lo = EXP2_TABLE[Number(i)];
  const mant = lo + ((EXP2_TABLE[Number(i) + 1] - lo) * r) / 1000n;
  return ((base << q) * mant) / ONE;
};

const sortBig = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const median = (xs: bigint[]) => {
  const s = sortBig(xs);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2n;
};
const absBig = (x: bigint) => (x < 0n ? -x : x);
const hourOf = (ts: bigint) => Number((ts / 3600n) % 24n);
const inBizHours = (h: number, start: number, end: number) =>
  start === end ? true : start < end ? h >= start && h < end : h >= start || h < end;

// ---------- terms ----------

type History = ScoringContext["history"];

/**
 * Robust z of log2(amount) over the scope's history (median / MAD), Laplace surprisal: bits = (l − median) / MAD.
 * Only upward deviation counts: smaller-than-usual is not an attack signature. Cold start: the profile's
 * usual max payout is the 2σ point (median = usual/2, MAD = 1 bit).
 */
const amountTerm = (amount: bigint, hist: History, p: ScoringContext["profile"]): bigint | undefined => {
  const l = log2Milli(amount < 1n ? 1n : amount);
  let med: bigint;
  let mad: bigint;
  if (hist.length >= MIN_SAMPLES) {
    const ls = hist.map((o) => log2Milli(o.amount < 1n ? 1n : o.amount));
    med = median(ls);
    mad = median(ls.map((x) => absBig(x - med)));
  } else {
    const usual = p.usualMaxPayout > 0n ? p.usualMaxPayout : p.hardCap;
    if (usual === 0n) return undefined; // no baseline at all → caller falls back to MaxDelay
    med = log2Milli(usual) - 1000n;
    mad = 1000n;
  }
  if (mad < MAD_FLOOR) mad = MAD_FLOOR;
  return l > med ? ((l - med) * 1000n) / mad : 0n;
};

/** −log2 of a Laplace-smoothed destination frequency; whitelisted destinations get DEST_PRIOR pseudo-counts. */
const destTerm = (dest: Hex, hist: History, known: boolean, seenEver: boolean) => {
  const d = dest.toLowerCase();
  const distinct = new Set(hist.map((o) => o.destination.toLowerCase()));
  let c = BigInt(hist.filter((o) => o.destination.toLowerCase() === d).length);
  if (c === 0n && seenEver) c = 1n; // paid before, outside the 32-entry window
  const prior = known ? DEST_PRIOR : 0n;
  const num = c + 1n + prior;
  const den = BigInt(hist.length) + BigInt(distinct.size) + 1n + DEST_PRIOR;
  const bits = log2Milli(den * ONE) - log2Milli(num * ONE);
  return { bits: bits > 0n ? bits : 0n, isNew: c === 0n && !known };
};

/**
 * Surprisal of the hour vs the scope's most usual hour: log2(p(mode) / p(h)) over a 24-bucket histogram,
 * Laplace-smoothed and seeded with the profile's business hours. A request in the usual hour scores 0.
 */
const timeTerm = (at: bigint, hist: History, p: ScoringContext["profile"]) => {
  const bizSet = p.bizStartHourUtc !== p.bizEndHourUtc;
  const counts = Array.from({ length: 24 }, (_, i) => {
    let c = 1n;
    if (bizSet && inBizHours(i, p.bizStartHourUtc, p.bizEndHourUtc)) c += HOUR_PRIOR;
    return c;
  });
  for (const o of hist) counts[hourOf(o.timestamp)] += 1n;
  const h = hourOf(at);
  const mode = counts.reduce((m, c) => (c > m ? c : m), 0n);
  return {
    bits: log2Milli(mode * ONE) - log2Milli(counts[h] * ONE),
    off: bizSet && !inBizHours(h, p.bizStartHourUtc, p.bizEndHourUtc),
  };
};

/**
 * Poisson tail of the count in the last 1h / 24h (this request included) vs the scope's rate λ, by the
 * Chernoff bound −log2 P(X ≥ x) ≈ x·log2(x/λ) − (x − λ)·log2(e) for x > λ, minus the same bound at x = 1
 * so a lone request scores 0. Max of both windows.
 */
const chernoff = (x: bigint, lam: bigint) =>
  x * ONE <= lam ? 0n : x * (log2Milli(x * ONE) - log2Milli(lam)) - ((x * ONE - lam) * LOG2E_MILLI) / ONE;

const velocityTerm = (at: bigint, hist: History): bigint => {
  const oldest = hist.reduce((m, o) => (o.timestamp < m ? o.timestamp : m), at);
  const span = at - oldest > MIN_SPAN ? at - oldest : MIN_SPAN;
  const n = BigInt(hist.length) > 0n ? BigInt(hist.length) : 1n;
  let best = 0n;
  for (const win of [3600n, 86400n]) {
    const x = 1n + BigInt(hist.filter((o) => o.timestamp + win > at && o.timestamp <= at).length);
    const lam = (n * win * ONE) / span; // λ · 1e6
    if (lam < 1n) continue;
    const bits = chernoff(x, lam) - chernoff(1n, lam);
    if (bits > best) best = bits;
  }
  return best;
};

// ---------- assess ----------

const U32_MAX = 0xffffffffn;

const scope = (ctx: ScoringContext, hist: History, vaultWide: boolean) => {
  const r = ctx.request;
  const amount = amountTerm(r.amount, hist, ctx.profile);
  // destinationCount is Vault-wide all-time, so it only vouches at Vault scope
  const dest = destTerm(r.destination, hist, ctx.knownDestination, vaultWide && ctx.destinationCount > 0n);
  const time = timeTerm(r.createdAt, hist, ctx.profile);
  const velocity = velocityTerm(r.createdAt, hist);
  let flags = 0n;
  let codes = 0n;
  if (ctx.configChangePending) (flags += FLAG_BITS), (codes |= CONFIG_CHANGE_PENDING);
  if (r.createdAt < ctx.requesterAddedAt + NEW_WALLET_AGE) (flags += FLAG_BITS), (codes |= NEW_WALLET);
  if (amount !== undefined && amount >= 4000n) codes |= UNUSUAL_AMOUNT;
  if (dest.isNew) codes |= NEW_DESTINATION;
  if (time.off) codes |= OFF_HOURS;
  if (velocity >= 4000n) codes |= VELOCITY;
  const terms: Terms = {
    amount: Number(amount ?? 0n),
    dest: Number(dest.bits),
    time: Number(time.bits),
    velocity: Number(velocity),
    flags: Number(flags),
  };
  const total = (amount ?? 0n) + dest.bits + time.bits + velocity + flags;
  return { total, terms, codes, blind: amount === undefined };
};

/** Score one queued request. `params` is per-deployment config (sentinel config.*.json). */
export const assess = (ctx: ScoringContext, params: Params = DEFAULT_PARAMS): Assessment => {
  const r = ctx.request;
  const p = ctx.profile;
  const wallet = r.requester.toLowerCase();
  const vaultS = scope(ctx, ctx.history, true);
  const walletS = scope(
    ctx,
    ctx.history.filter((o) => o.wallet.toLowerCase() === wallet),
    false,
  );
  const win = walletS.total > vaultS.total ? { s: walletS, name: "wallet" as const } : { s: vaultS, name: "vault" as const };
  const total = win.s.total > U32_MAX ? U32_MAX : win.s.total;
  let codes = r.reasonCodes | win.s.codes;
  if (p.hardCap > 0n && r.amount > p.hardCap) codes |= OVER_HARD_CAP;

  const flag = total >= BigInt(params.sFlag) || (codes & BLOCKLISTED_DEST) !== 0n;
  const floor = BigInt(p.floorDelay);
  const max = BigInt(p.maxDelay);
  let delay: bigint;
  if (vaultS.blind) delay = max; // unsure → slow (brief §7.1.3)
  else {
    const raw = mulExp2(floor, (total * 1000n) / BigInt(params.k) > 64000n ? 64000n : (total * 1000n) / BigInt(params.k));
    delay = raw < floor ? floor : raw > max ? max : raw;
  }
  if ((codes & OVER_HARD_CAP) !== 0n && delay < BigInt(p.capDelay)) delay = BigInt(p.capDelay);

  return { action: flag ? "FLAG" : "DELAY", score: Number(total), delay, reasonCodes: codes, scope: win.name, terms: win.s.terms };
};
