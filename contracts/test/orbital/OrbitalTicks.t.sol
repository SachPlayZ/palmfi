// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {OrbitalTicks} from "../../src/orbital/OrbitalTicks.sol";

/// Library-level properties of the torus: the fitted scale reproduces the reserves, swaps stay inside the torus
/// and round in the pool's favour, and a round trip never profits.
contract OrbitalTicksTest is Test {
    function _setup(uint256 seed)
        internal
        pure
        returns (OrbitalTicks.Ticks memory t, OrbitalTicks.Pool memory p, uint256 n)
    {
        n = 3 + seed % 4;
        uint256[10] memory raw;
        raw[9] = 1e10 * (1 + seed % 5);
        raw[seed % 9] = 1e10 * (1 + (seed / 7) % 5);
        raw[(seed / 3) % 9] += 1e10;
        t = OrbitalTicks.build(n, raw);
        uint256 base = 1e10 + (seed % 1000) * 1e7;
        uint256 sx;
        uint256 sx2;
        for (uint256 i; i < n; i++) {
            uint256 x = base + ((seed >> (i * 5)) % 16) * base / 100;
            sx += x;
            sx2 += x * x;
            if (i == 0) p.xi = x;
            if (i == 1) p.xj = x;
        }
        p.sumX = sx;
        p.sumX2 = sx2;
        p.c = OrbitalTicks.fit(t, sx, sx2);
    }

    function testFuzz_fit_residualZero(uint256 seed) public pure {
        (OrbitalTicks.Ticks memory t, OrbitalTicks.Pool memory p,) = _setup(seed);
        int256 r = OrbitalTicks.residual(t, p.c, p.sumX, p.sumX2);
        // |residual| ≪ (c·P)², i.e. the reserves are on the torus up to rounding
        assertLt(uint256(r < 0 ? -r : r), p.c * p.c / 1e9);
    }

    function testFuzz_swap_staysInsideTorus_roundtripNeverProfits(uint256 seed, uint256 dFrac) public pure {
        (OrbitalTicks.Ticks memory t, OrbitalTicks.Pool memory p,) = _setup(seed);
        uint256 d = p.xi / 50 + (dFrac % 40) * p.xi / 200; // 2%..22% of the in-reserve
        uint256 y = OrbitalTicks.outGivenIn(t, p, d, p.xj);
        if (y == 0 || y > p.xj) return;
        // inside the torus after the swap
        uint256 s2 = p.sumX2 + (p.xi + d) ** 2 + (p.xj - y) ** 2 - p.xi ** 2 - p.xj ** 2;
        assertLe(OrbitalTicks.residual(t, p.c, p.sumX + d - y, s2), 0);
        // reverse: paying `y` back needs at least d (up to a few units of rounding)
        OrbitalTicks.Pool memory q = OrbitalTicks.Pool(p.c, p.sumX + d - y, s2, p.xj - y, p.xi + d);
        uint256 dBack = OrbitalTicks.inGivenOut(t, q, d - 1);
        assertGe(dBack + y / 1e6 + 8, y); // equal up to fixed-point rounding
    }
}
