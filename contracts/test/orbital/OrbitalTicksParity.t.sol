// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {OrbitalTicks} from "../../src/orbital/OrbitalTicks.sol";

/// Replays test/vectors/ticks.json (written by orbital_ticks_ref.py, a Decimal model of the same invariant)
/// against the on-chain library: fitted scale and exact-in output must agree within fixed-point tolerance.
contract OrbitalTicksParityTest is Test {
    function _stats(uint256[] memory X) internal pure returns (uint256 sx, uint256 sx2) {
        for (uint256 k; k < X.length; k++) {
            sx += X[k];
            sx2 += X[k] * X[k];
        }
    }

    function test_parity_withPythonReference() public view {
        string memory json = vm.readFile("test/vectors/ticks.json");
        uint256 cases = abi.decode(vm.parseJson(json, ".[*].n"), (uint256[])).length;
        assertGt(cases, 10);
        for (uint256 k; k < cases; k++) {
            _check(json, string.concat(".[", vm.toString(k), "]"));
        }
    }

    function _check(string memory json, string memory p) internal view {
        uint256[10] memory raw;
        {
            uint256[] memory wRaw = vm.parseJsonUintArray(json, string.concat(p, ".weights"));
            for (uint256 b; b < 10; b++) {
                raw[b] = wRaw[b];
            }
        }
        uint256[] memory X = vm.parseJsonUintArray(json, string.concat(p, ".X"));
        OrbitalTicks.Ticks memory t = OrbitalTicks.build(vm.parseJsonUint(json, string.concat(p, ".n")), raw);
        OrbitalTicks.Pool memory pool;
        (pool.sumX, pool.sumX2) = _stats(X);
        pool.c = OrbitalTicks.fit(t, pool.sumX, pool.sumX2);
        assertApproxEqRel(pool.c, vm.parseJsonUint(json, string.concat(p, ".c")), 1e12, "c");

        pool.xi = X[vm.parseJsonUint(json, string.concat(p, ".i"))];
        pool.xj = X[vm.parseJsonUint(json, string.concat(p, ".j"))];
        uint256 out = OrbitalTicks.outGivenIn(t, pool, vm.parseJsonUint(json, string.concat(p, ".d")), pool.xj);
        assertApproxEqRel(out, vm.parseJsonUint(json, string.concat(p, ".out")), 1e14, "out");
    }
}
