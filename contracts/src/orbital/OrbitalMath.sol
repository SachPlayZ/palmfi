// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FixedPointMathLib} from "solmate/src/utils/FixedPointMathLib.sol";

/// Orbital AMM math (Paradigm, "Orbital", Robinson / Moallemi / White, June 2025), single sphere (ADR-0010,
/// fallback ladder step 2) on virtual reserves.
///
/// Sphere invariant over N (virtual) reserves X: Σ (r − X_i)² = r². With a_i = r − X_i, a pairwise trade that
/// moves only coordinates i (in) and j (out) keeps a_i² + a_j² constant, so both directions are closed form:
///   exact in  d: y = √(a_i² + a_j² − (a_i − d)²) − a_j
///   exact out y: d = a_i − √(a_i² + a_j² − (a_j + y)²)
/// The marginal price of j in i is a_i / a_j: 1 at the equal-price point X_i = r(1 − 1/√N).
///
/// Virtual reserves X_i = x_i + V concentrate liquidity around the peg (what a single boundary tick does in the
/// paper): with V = (C − 1)·L/N, a balanced pool trades like one C× deeper, and no trade can take more than the
/// real reserve x_j. Every rounding favours the pool.
library OrbitalMath {
    error OffSphere();

    /// Radius of the sphere through X: the larger root of (N−1)r² − 2r·ΣX + ΣX² = 0.
    function radius(uint256[] memory X) internal pure returns (uint256 r) {
        uint256 n = X.length;
        if (n < 2) return 0;
        uint256 s;
        uint256 s2;
        for (uint256 i; i < n; i++) {
            s += X[i];
            s2 += X[i] * X[i];
        }
        uint256 a = s * s;
        uint256 b = (n - 1) * s2;
        if (a < b) revert OffSphere();
        r = (s + FixedPointMathLib.sqrt(a - b)) / (n - 1);
    }

    /// Output for an exact input `d` of coordinate i (a_i = r − X_i, a_j = r − X_j). Rounds down.
    function outGivenIn(uint256 ai, uint256 aj, uint256 d) internal pure returns (uint256) {
        if (d > ai) revert OffSphere(); // past the top of the sphere: price of i would turn negative
        uint256 ai2 = ai - d;
        uint256 s = ai * ai + aj * aj - ai2 * ai2;
        uint256 root = FixedPointMathLib.sqrt(s);
        return root > aj ? root - aj : 0;
    }

    /// Input needed for an exact output `y` of coordinate j. Rounds up.
    function inGivenOut(uint256 ai, uint256 aj, uint256 y) internal pure returns (uint256) {
        uint256 aj2 = aj + y;
        uint256 t = ai * ai + aj * aj;
        if (aj2 * aj2 > t) revert OffSphere();
        return ai - FixedPointMathLib.sqrt(t - aj2 * aj2); // floored root → d rounds up
    }
}
