// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Single-sphere N-token Orbital invariant ||r*1 - x||^2 = r^2, WAD (1e18) values.
/// @dev Reference: scripts/orbital_ref.py. With a_k = r - x_k, a 2-coord swap keeps
///      a_i^2 + a_j^2 constant, so both swap directions are closed form (no Newton).
///      Every sqrt floors, which rounds exact-in output down and exact-out input up (pool-favouring).
library OrbitalMath {
    error Infeasible();
    error ExceedsCap();
    error InsufficientLiquidity();

    /// @notice Sphere radius through reserves: larger root of (n-1) r^2 - 2 S r + Q = 0.
    /// @param s sum of reserves, q sum of squared reserves, n active token count (>= 2)
    function radius(uint256 s, uint256 q, uint256 n) internal pure returns (uint256) {
        uint256 m = n - 1;
        uint256 s2 = s * s;
        if (s2 < m * q) revert Infeasible();
        return (s + Math.sqrt(s2 - m * q)) / m;
    }

    /// @notice Output of token j for `dIn` of token i at radius r.
    function exactIn(uint256 r, uint256 xi, uint256 xj, uint256 dIn) internal pure returns (uint256 dOut) {
        uint256 ai = _gap(r, xi);
        uint256 aj = _gap(r, xj);
        if (dIn > ai) revert ExceedsCap();
        // a_j'^2 = a_j^2 + a_i^2 - (a_i - d)^2 = a_j^2 + d (2 a_i - d)
        uint256 aj2 = Math.sqrt(aj * aj + dIn * (2 * ai - dIn));
        dOut = aj2 > aj ? aj2 - aj : 0;
        if (dOut >= xj) revert InsufficientLiquidity();
    }

    /// @notice Input of token i needed for `dOut` of token j at radius r.
    function exactOut(uint256 r, uint256 xi, uint256 xj, uint256 dOut) internal pure returns (uint256 dIn) {
        if (dOut >= xj) revert InsufficientLiquidity();
        uint256 ai = _gap(r, xi);
        uint256 aj = _gap(r, xj);
        // a_i'^2 = a_i^2 - d (2 a_j + d)
        uint256 grow = dOut * (2 * aj + dOut);
        uint256 ai2sq = ai * ai;
        if (grow > ai2sq) revert InsufficientLiquidity();
        dIn = ai - Math.sqrt(ai2sq - grow);
    }

    function _gap(uint256 r, uint256 x) private pure returns (uint256) {
        return r > x ? r - x : 0;
    }
}
