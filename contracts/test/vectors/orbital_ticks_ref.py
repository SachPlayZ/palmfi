#!/usr/bin/env python3
"""Reference model of OrbitalTicks.sol (Paradigm Orbital ticks, torus consolidation), in 60-digit Decimal.

Independent of the Solidity: real arithmetic, no fixed point. Writes ticks.json, which test/OrbitalTicksParity.t.sol
replays against the library (fit scale c and an exact-in swap) within fixed-point tolerance.

    python3 test/vectors/orbital_ticks_ref.py
"""
import json, random
from decimal import Decimal as D, getcontext

getcontext().prec = 60
TC = 10


def tick_table(n, raw):
    tot = sum(raw)
    w = [D(r) / D(tot) for r in raw]
    sq = D(n).sqrt()
    floors = [D(x) / D(10000) for x in (9990, 9950, 9900, 9800, 9500, 9000, 8000, 5000, 2500)]
    kh, sg = [], []
    for p in floors:
        d = (p + n - 1) / (sq * (p * p + n - 1).sqrt())
        kh.append(sq - d)
        sg.append((1 - d * d).sqrt())
    kh.append(D(n - 1) / sq)  # full sphere
    sg.append(D(0))
    return sq, w, kh, sg


def stats(n, sq, X):
    alpha = sum(D(x) for x in X) / sq
    sx2 = sum(D(x) ** 2 for x in X)
    return alpha, max(sx2 - alpha ** 2, D(0)).sqrt(), sx2


def classify(sq, w, kh, sg, c, alpha):
    A = S = D(0); P = D(1)
    for b in range(TC - 1):
        if w[b] == 0: continue
        if (alpha - c * A) < kh[b] * c * P: break
        A += w[b] * kh[b]; S += w[b] * sg[b]; P -= w[b]
    return A, S, P


def residual(n, tbl, c, X):
    sq, w, kh, sg = tbl
    alpha, wv, _ = stats(n, sq, X)
    A, S, P = classify(sq, w, kh, sg, c, alpha)
    B = A + P * sq
    return (wv - c * S) ** 2 + (alpha - c * B) ** 2 - (c * P) ** 2


def fit(n, tbl, X):
    sq, w, kh, sg = tbl
    alpha, wv, sx2 = stats(n, sq, X)
    A = S = D(0); P = D(1); b = 0
    while True:
        B = A + P * sq
        Q = S * S + B * B - P * P
        T = wv * S + alpha * B
        disc = T * T - Q * sx2
        if disc >= 0 and Q != 0:
            c = (T + disc.sqrt()) / Q
            if classify(sq, w, kh, sg, c, alpha) == (A, S, P):
                return c
        while b < TC - 1 and w[b] == 0: b += 1
        if b >= TC - 1: raise ValueError("off torus")
        A += w[b] * kh[b]; S += w[b] * sg[b]; P -= w[b]; b += 1


def out_given_in(n, tbl, c, X, i, j, d):
    """Largest y with residual <= 0 (bisection in real arithmetic)."""
    def ok(y):
        Y = [D(x) for x in X]; Y[i] += d; Y[j] -= y
        return Y[j] >= 0 and residual(n, tbl, c, Y) <= 0
    lo, hi = D(0), D(X[j])
    if ok(hi): return hi
    for _ in range(200):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if ok(mid) else (lo, mid)
    return lo


def main():
    rnd = random.Random(7)
    cases = []
    for n in (3, 4, 5, 8):
        for _ in range(6):
            raw = [0] * TC
            raw[TC - 1] = rnd.randint(1, 10) * 10**9  # always some wide liquidity
            for b in rnd.sample(range(TC - 1), rnd.randint(1, 4)):
                raw[b] = rnd.randint(1, 10) * 10**9
            base = rnd.randint(5, 30) * 10**9
            X = [base + rnd.randint(0, base // 4) for _ in range(n)]
            tbl = tick_table(n, raw)
            try:
                c = fit(n, tbl, X)
            except ValueError:
                continue
            i, j = rnd.sample(range(n), 2)
            d = rnd.randint(1, base // 2)
            y = out_given_in(n, tbl, c, X, i, j, D(d))
            cases.append({"n": n, "weights": raw, "X": X, "c": str(int(c)), "i": i, "j": j, "d": d, "out": str(int(y))})
    json.dump(cases, open("test/vectors/ticks.json", "w"), indent=1)
    print(len(cases), "cases")


main()
