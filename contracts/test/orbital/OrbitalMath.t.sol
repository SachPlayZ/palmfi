// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {OrbitalMath} from "../../src/orbital/OrbitalMath.sol";

/// The closed-form pairwise solves keep the sphere invariant and always round in the pool's favour.
contract OrbitalMathTest is Test {
    function _sphere(uint256 n, uint256 x) internal pure returns (uint256 r) {
        uint256[] memory X = new uint256[](n);
        for (uint256 i; i < n; i++) {
            X[i] = x;
        }
        r = OrbitalMath.radius(X);
    }

    function test_radius_equalPricePoint() public pure {
        // X_i = r(1 − 1/√n): for n = 4, r = 2X
        assertApproxEqAbs(_sphere(4, 1_000e6), 2_000e6, 1);
    }

    function testFuzz_outGivenIn_keepsInvariant_poolFavoured(uint64 xi, uint64 xj, uint64 din) public pure {
        uint256 r = 1e15;
        uint256 ai = bound(xi, 1e12, r);
        uint256 aj = bound(xj, 1e12, r);
        uint256 d = bound(din, 1, ai);
        uint256 y = OrbitalMath.outGivenIn(ai, aj, d);
        // after: (ai − d)² + (aj + y)² ≤ ai² + aj²  (never paid more than the sphere allows)
        assertLe((ai - d) ** 2 + (aj + y) ** 2, ai * ai + aj * aj);
        // ... and at most one unit short of it
        assertGt((ai - d) ** 2 + (aj + y + 1) ** 2, ai * ai + aj * aj);
    }

    function testFuzz_roundTrip_noFreeLunch(uint64 xi, uint64 xj, uint64 yout) public pure {
        uint256 ai = bound(xi, 1e12, 1e15);
        uint256 aj = bound(xj, 1e12, 1e15);
        uint256 y = bound(yout, 1, aj / 2);
        if ((aj + y) ** 2 > ai * ai + aj * aj) return;
        uint256 d = OrbitalMath.inGivenOut(ai, aj, y);
        if (d > ai) return;
        assertGe(OrbitalMath.outGivenIn(ai, aj, d), y - 1); // paying d buys (about) y
        if (d > 0) assertLt(OrbitalMath.outGivenIn(ai, aj, d - 1), y + 1); // one unit less never buys more
    }

    function test_nearPeg_atBalance() public pure {
        uint256 a = 1e13;
        assertApproxEqAbs(OrbitalMath.outGivenIn(a, a, 100e6), 100e6, 1e3);
    }
}
