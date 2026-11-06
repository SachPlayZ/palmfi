// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// Paradigm Orbital ticks (nested spherical caps + torus consolidation), on top of OrbitalMath's single sphere.
///
/// Notation (Robinson / Moallemi / White, "Orbital", June 2025). n tokens, reserves X (virtual, see OrbitalMath),
/// unit vector v = 1/√n·(1,…,1). For the reserve vector: α = X·v (parallel part), w = √(‖X‖² − α²) (perpendicular).
/// A tick of radius r with plane constant k covers the part of its sphere where α ≤ k. Every tick shares one
/// price, so tick t holds the fixed share ρ_t of the pool's scale c (r_t = c·ρ_t) and its normalised plane
/// constant k̂ = k/r is a property of the tick alone. We offer ten ticks named by the depeg they tolerate: tick b
/// reaches its boundary when the dumped token's price has fallen to priceFloorBps(b) of the peg (99.9%, 99.5%,
/// 99%, 98%, 95%, 90%, 80%, 50%, 25%); tick 10 (k̂_max = (n − 1)/√n) is the plain sphere and never reaches one.
///
/// Consolidation. Ticks whose cap has been reached are *boundary* ticks: pinned at α_t = k_t on an (n−1)-sphere of
/// radius s_t = r_t·σ_b, σ_b = √(1 − (√n − k̂_b)²). The rest are *interior* ticks, which sum to one sphere of
/// radius c·P (P = interior weight). With A = Σ_boundary ρ k̂, S = Σ_boundary ρ σ, B = A + P√n the whole pool obeys
/// the torus invariant
///   (w − c·S)² + (α − c·B)² = (c·P)²          ⇔   Q·c² − 2T·c + ‖X‖² = 0,
///   Q = S² + B² − P²,  T = w·S + α·B
/// so the scale c fits the reserves in closed form (larger root), and a swap is the 1-D root of the same
/// invariant, bisected with the tick classification re-evaluated at every probe (the invariant is continuous across
/// a tick crossing, so crossings need no special case). Feasible ⇔ torus residual ≤ 0 ⇔ the pool keeps at least what
/// the invariant requires, so every rounding favours the pool. When every tick is at its boundary, no pairwise
/// trade can leave the circle: the pool stops trading that direction, which is the bounded depeg exposure.
library OrbitalTicks {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant TICK_COUNT = 10;

    error OffTorus();
    error NoWeight();

    struct Ticks {
        uint256 sqrtN; // √n, wad
        uint256[TICK_COUNT] w; // normalised weight per tick (sums to WAD)
        uint256[TICK_COUNT] kh; // k̂ per tick, wad
        uint256[TICK_COUNT] sg; // σ per tick, wad
    }

    /// Build the tick table from raw (unnormalised) weights, index b−1 for tick b.
    function build(uint256 n, uint256[TICK_COUNT] memory raw) internal pure returns (Ticks memory t) {
        uint256 sum;
        for (uint256 b; b < TICK_COUNT; b++) {
            sum += raw[b];
        }
        if (sum == 0) revert NoWeight();
        t.sqrtN = FixedPointMathLib.sqrt(n * WAD * WAD);
        for (uint256 b; b < TICK_COUNT; b++) {
            t.w[b] = raw[b] * WAD / sum;
            if (b == TICK_COUNT - 1) {
                t.kh[b] = (n - 1) * WAD * WAD / t.sqrtN; // k̂_max: the full sphere
                t.sg[b] = 0;
                continue;
            }
            // Tick b stops at the point where the dumped token's price has fallen to p (others equal):
            //   k̂ = √n − (p + n − 1) / (√n·√(p² + n − 1)),   d = √n − k̂,   σ = √(1 − d²)
            uint256 p = priceFloorBps(b + 1) * (WAD / 10_000);
            uint256 sq = FixedPointMathLib.sqrt(p * p + (n - 1) * WAD * WAD);
            uint256 d = (p + (n - 1) * WAD) * WAD * WAD / (t.sqrtN * sq);
            if (d > WAD) d = WAD;
            t.kh[b] = t.sqrtN - d;
            t.sg[b] = FixedPointMathLib.sqrt(WAD * WAD - d * d);
        }
    }

    /// The price floor (bps of the peg) at which tick `b` (1..9) reaches its boundary; tick 10 has none.
    function priceFloorBps(uint256 b) internal pure returns (uint256) {
        if (b == 1) return 9990;
        if (b == 2) return 9950;
        if (b == 3) return 9900;
        if (b == 4) return 9800;
        if (b == 5) return 9500;
        if (b == 6) return 9000;
        if (b == 7) return 8000;
        if (b == 8) return 5000;
        return 2500;
    }

    /// Reserve statistics the invariant needs.
    function alphaOf(Ticks memory t, uint256 sumX) internal pure returns (uint256) {
        return sumX * WAD / t.sqrtN;
    }

    function perpOf(uint256 alpha, uint256 sumX2) internal pure returns (uint256) {
        uint256 a2 = alpha * alpha;
        return a2 >= sumX2 ? 0 : FixedPointMathLib.sqrt(sumX2 - a2);
    }

    /// Which ticks sit on their boundary at scale `c` and parallel part `alpha`: the ascending prefix of ticks with
    /// (α − c·A)/(c·P) ≥ k̂. Returns A, S (boundary sums) and P (interior weight), all wad.
    function classify(Ticks memory t, uint256 c, uint256 alpha) internal pure returns (uint256 A, uint256 S, uint256 P) {
        P = WAD;
        for (uint256 b; b < TICK_COUNT - 1; b++) {
            uint256 wb = t.w[b];
            if (wb == 0) continue;
            // boundary iff (α − c·A)/(c·P) ≥ k̂  ⇔  α·WAD² ≥ c·A·WAD + c·P·k̂
            if (alpha * WAD * WAD < c * A * WAD + c * P * t.kh[b]) break;
            A += wb * t.kh[b] / WAD;
            S += wb * t.sg[b] / WAD;
            P -= wb;
        }
    }

    /// Torus residual at scale c for reserve statistics (sumX, sumX2). ≤ 0 means the reserves are on or inside the
    /// invariant (the pool holds at least what the curve requires).
    function residual(Ticks memory t, uint256 c, uint256 sumX, uint256 sumX2) internal pure returns (int256) {
        uint256 alpha = alphaOf(t, sumX);
        uint256 wv = perpOf(alpha, sumX2);
        (uint256 A, uint256 S, uint256 P) = classify(t, c, alpha);
        int256 cS = int256(c * S / WAD);
        int256 cB = int256(c * (A + P * t.sqrtN / WAD) / WAD);
        int256 cP = int256(c * P / WAD);
        int256 dw = int256(wv) - cS;
        int256 da = int256(alpha) - cB;
        return dw * dw + da * da - cP * cP;
    }

    /// Larger root of Q·c² − 2T·c + ‖X‖² = 0 for the boundary sums (A, S, P); 0 if none.
    function _root(Ticks memory t, uint256[3] memory asp, uint256 alpha, uint256 wv, uint256 sumX2)
        private
        pure
        returns (uint256)
    {
        uint256 B = asp[0] + asp[2] * t.sqrtN / WAD;
        uint256 q = (asp[1] * asp[1] + B * B - asp[2] * asp[2]) / WAD; // Q, wad (positive since B² ≥ P²·n)
        uint256 tt = wv * asp[1] + alpha * B; // T, raw·wad
        uint256 qx = q * sumX2 * WAD;
        if (tt * tt < qx || q == 0) return 0;
        return (tt + FixedPointMathLib.sqrt(tt * tt - qx)) / q;
    }

    /// Fit the scale c to the reserves: for each candidate boundary prefix take the larger root of
    /// Q·c² − 2T·c + ‖X‖² = 0 and keep the first one whose own classification agrees.
    function fit(Ticks memory t, uint256 sumX, uint256 sumX2) internal pure returns (uint256 c) {
        uint256 alpha = alphaOf(t, sumX);
        uint256 wv = perpOf(alpha, sumX2);
        uint256[3] memory asp = [uint256(0), 0, WAD]; // A, S, P
        uint256 b;
        while (true) {
            c = _root(t, asp, alpha, wv, sumX2);
            if (c != 0) {
                (uint256 A2, uint256 S2, uint256 P2) = classify(t, c, alpha);
                if (A2 == asp[0] && S2 == asp[1] && P2 == asp[2]) return c;
            }
            // next boundary candidate: the next non-empty tick below the widest
            while (b < TICK_COUNT - 1 && t.w[b] == 0) b++;
            if (b >= TICK_COUNT - 1) revert OffTorus();
            asp[0] += t.w[b] * t.kh[b] / WAD;
            asp[1] += t.w[b] * t.sg[b] / WAD;
            asp[2] -= t.w[b];
            b++;
        }
    }

    /// Scale and statistics of the pool plus the traded pair's reserves.
    struct Pool {
        uint256 c;
        uint256 sumX;
        uint256 sumX2;
        uint256 xi;
        uint256 xj;
    }

    function _feasible(Ticks memory t, Pool memory p, uint256 dI, uint256 dJ) private pure returns (bool) {
        if (dJ > p.xj) return false;
        uint256 s = p.sumX + dI - dJ;
        uint256 s2 = p.sumX2 + (p.xi + dI) * (p.xi + dI) + (p.xj - dJ) * (p.xj - dJ) - p.xi * p.xi - p.xj * p.xj;
        // margin of 8c (≈ 4× the √-floor noise in w and α): rounding can never tip a trade against the pool
        return residual(t, p.c, s, s2) <= -int256(8 * p.c);
    }

    /// Exact in: the largest output (≤ cap + 1) the torus allows for input `d` of coordinate i. Returns 0 when the
    /// input alone already carries the pool past a tick boundary (the pool cannot absorb that much of this token).
    /// The root is searched outward from y = 0 in doubling steps, so it is the first one on the path from the
    /// current state, never a far branch of the torus.
    function outGivenIn(Ticks memory t, Pool memory p, uint256 d, uint256 cap) internal pure returns (uint256) {
        if (!_feasible(t, p, d, 0)) return 0;
        uint256 lo;
        uint256 hi = d / 64 + 1;
        while (hi <= cap && _feasible(t, p, d, hi)) {
            lo = hi;
            hi *= 2;
        }
        if (hi > cap) {
            if (_feasible(t, p, d, cap + 1)) return cap + 1; // caller rejects: more than the pool holds
            hi = cap + 1;
        }
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_feasible(t, p, d, mid)) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    /// Exact out: the smallest input that lets the pool pay `y` of coordinate j.
    function inGivenOut(Ticks memory t, Pool memory p, uint256 y) internal pure returns (uint256) {
        uint256 hi = y > 0 ? y : 1;
        for (uint256 k; !_feasible(t, p, hi, y); k++) {
            if (k == 60) revert OffTorus();
            hi *= 2;
        }
        uint256 lo;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_feasible(t, p, mid, y)) hi = mid;
            else lo = mid;
        }
        return hi;
    }
}
