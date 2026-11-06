// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {OrbitalMath} from "../../src/orbital/OrbitalMath.sol";
import {OrbitalVectors} from "./OrbitalVectors.sol";

/// External wrapper so expectRevert / try work on the library.
contract MathHarness {
    function radius(uint256[] memory x) public pure returns (uint256) {
        (uint256 s, uint256 q) = (0, 0);
        for (uint256 k; k < x.length; ++k) {
            s += x[k];
            q += x[k] * x[k];
        }
        return OrbitalMath.radius(s, q, x.length);
    }

    function exactIn(uint256[] memory x, uint256 i, uint256 j, uint256 d) external pure returns (uint256) {
        return OrbitalMath.exactIn(radius(x), x[i], x[j], d);
    }

    function exactOut(uint256[] memory x, uint256 i, uint256 j, uint256 d) external pure returns (uint256) {
        return OrbitalMath.exactOut(radius(x), x[i], x[j], d);
    }
}

contract OrbitalMathTest is Test {
    uint256 constant WAD = 1e18;
    MathHarness h = new MathHarness();

    /// Few-wei slack: Solidity floors r and each sqrt; the reference is exact then floored.
    function _tol(uint256 v) internal pure returns (uint256) {
        return 16 + v / 1e15;
    }

    function test_vectorsMatchPythonReference() public view {
        for (uint256 k; k < OrbitalVectors.COUNT; ++k) {
            OrbitalVectors.V memory v = OrbitalVectors.get(k);
            assertApproxEqAbs(h.radius(v.x), v.r, _tol(v.r), "radius");
            uint256 got = v.exactOut ? h.exactOut(v.x, v.i, v.j, v.d) : h.exactIn(v.x, v.i, v.j, v.d);
            assertApproxEqAbs(got, v.want, _tol(v.want), "swap");
        }
    }

    function test_equalPricePoint() public view {
        // x_i = r (1 - 1/sqrt n)  =>  for n=4, r = 2x
        uint256[] memory x = _flat(4, 1_000_000 * WAD);
        assertApproxEqAbs(h.radius(x), 2_000_000 * WAD, 4);
        // tiny trade at balance is ~1:1
        assertApproxEqAbs(h.exactIn(x, 0, 1, 1e6), 1e6, 2);
    }

    function testFuzz_roundTripFavoursPool(uint8 nSeed, uint64 base, uint16 skew, uint16 frac) public view {
        uint256 n = bound(nSeed, 2, 8);
        uint256[] memory x = _flat(n, bound(base, 1e3, 1e10) * WAD);
        x[0] = x[0] * bound(skew, 70, 130) / 100;
        uint256 d = x[1] * bound(frac, 1, 5000) / 10_000;
        uint256 out = h.exactIn(x, 0, 1, d);
        // buying back `out` never costs less than `d` minus rounding slack
        uint256 back = h.exactOut(x, 0, 1, out);
        assertLe(back, d + _tol(d));
        // pool moves outward (r is increasing in every reserve) modulo rounding
        uint256 r0 = h.radius(x);
        x[0] += d;
        x[1] -= out;
        assertGe(h.radius(x) + _tol(r0), r0);
    }

    function test_revertsPastCap() public {
        uint256[] memory x = _flat(3, 100 * WAD);
        uint256 r = h.radius(x);
        vm.expectRevert(OrbitalMath.ExceedsCap.selector);
        h.exactIn(x, 0, 1, r - x[0] + 1);
        vm.expectRevert(OrbitalMath.InsufficientLiquidity.selector);
        h.exactOut(x, 0, 1, x[1]);
    }

    function test_infeasibleOneSided() public {
        uint256[] memory x = new uint256[](3);
        x[0] = 100 * WAD; // others empty: no sphere through (100,0,0)
        vm.expectRevert(OrbitalMath.Infeasible.selector);
        h.radius(x);
    }

    /// Live parity fuzz against the Python reference. Opt-in: ORBITAL_FFI=true forge test --ffi
    function testFuzz_ffiParity(uint8 nSeed, uint64 base, uint16 skew, uint16 frac, bool exactOut_) public {
        if (!vm.envOr("ORBITAL_FFI", false)) return;
        uint256 n = bound(nSeed, 2, 6);
        uint256[] memory x = _flat(n, bound(base, 1e3, 1e10) * WAD);
        x[n - 1] = x[n - 1] * bound(skew, 70, 130) / 100;
        uint256 d = x[0] * bound(frac, 1, 5000) / 10_000;
        string[] memory cmd = new string[](8);
        cmd[0] = "python3";
        cmd[1] = "../scripts/orbital_ref.py";
        cmd[2] = exactOut_ ? "exact-out" : "exact-in";
        cmd[3] = _join(x);
        (cmd[4], cmd[5], cmd[6], cmd[7]) = ("1", "0", vm.toString(d), "--abi");
        uint256 want = abi.decode(vm.ffi(cmd), (uint256));
        if (want == type(uint256).max) return; // reference says infeasible
        uint256 got = exactOut_ ? h.exactOut(x, 1, 0, d) : h.exactIn(x, 1, 0, d);
        assertApproxEqAbs(got, want, _tol(want));
    }

    function _flat(uint256 n, uint256 v) internal pure returns (uint256[] memory x) {
        x = new uint256[](n);
        for (uint256 k; k < n; ++k) {
            x[k] = v;
        }
    }

    function _join(uint256[] memory x) internal pure returns (string memory s) {
        s = vm.toString(x[0]);
        for (uint256 k = 1; k < x.length; ++k) {
            s = string.concat(s, ",", vm.toString(x[k]));
        }
    }
}
