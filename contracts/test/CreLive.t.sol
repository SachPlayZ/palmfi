// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {NetworkTest} from "./base/NetworkTest.sol";
import {PalmTypes as T} from "../src/libraries/PalmTypes.sol";
import {Vault} from "../src/Vault.sol";
import {VaultBase} from "../src/VaultBase.sol";
import {OrbitalHook} from "../src/orbital/OrbitalHook.sol";
import {OrbitalRouter} from "../src/orbital/OrbitalRouter.sol";

/// CRE on every outflow: while the heartbeat is fresh, every Unwrap / payment / pool swap is a scored request.
/// A zero-surprise request within the Instant budget clears at zero delay (and spends the budget); the direct
/// instant lane is only the CRE-down fallback.
contract CreLiveTest is NetworkTest {
    Vault v; // 5 wallets; budget 500/24h, Floor 15m, Hard cap 5k

    function setUp() public virtual override {
        super.setUp();
        v = onboard("nvidia", 5);
        depositUsdc(v, w[0], 10_000e6);
    }

    function heartbeat() internal {
        report(T.Report(T.REPORT_HEARTBEAT, address(0), 0, bytes32(0), 0, 0, 0, 0, 0));
    }

    function _request(uint256 amount) internal returns (uint256 id) {
        vm.prank(w[0]);
        id = v.requestUnwrap(amount, outsider);
    }

    function test_creLive_followsHeartbeat() public {
        assertFalse(hub().creLive()); // never heard from CRE
        heartbeat();
        assertTrue(hub().creLive());
        skip(10 minutes + 1);
        assertFalse(hub().creLive()); // stale → fallback
    }

    function test_live_directUnwrapAndPayRefused() public {
        heartbeat();
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.UseRequest.selector);
        v.unwrap(10e6, outsider);
        Vault other = onboard("palantir", 3);
        vm.prank(w[0]);
        vm.expectRevert(VaultBase.UseRequest.selector);
        v.pay(address(other), 10e6);
    }

    function test_down_directUnwrapStillWorks() public {
        heartbeat();
        skip(11 minutes);
        vm.prank(w[0]);
        v.unwrap(10e6, outsider);
        assertEq(usdcBalance(outsider), 10e6);
    }

    function test_smallRequest_noBond_zeroDelay_spendsBudget() public {
        heartbeat();
        uint256 id = _request(100e6);
        assertEq(v.bondOf(id), 0);
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6 - 100e6); // amount only, no bond
        assertFalse(v.isExecutable(id)); // MaxDelay until scored

        setDelay(v, id, 0, 0);
        assertEq(v.getRequest(id).executableAt, block.timestamp);
        assertEq(v.availableBudget(), 400e6);
        v.execute(id);
        assertEq(usdcBalance(outsider), 100e6);
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6 - 100e6);
    }

    function test_zeroDelay_overBudget_clampedToFloor() public {
        uint256 id = _request(600e6); // over the 500 budget
        assertEq(v.bondOf(id), BOND);
        setDelay(v, id, 0, 0); // compromised CRE can't release more than the budget
        assertEq(v.getRequest(id).executableAt, block.timestamp + 15 minutes);
        assertEq(v.availableBudget(), 500e6);
    }

    function test_smurfing_budgetBoundsZeroDelays() public {
        // Five 100 USDC zero-delay clears use up the budget; the sixth waits the Floor even if CRE says 0.
        for (uint256 i; i < 5; i++) {
            uint256 id = _request(100e6);
            setDelay(v, id, 0, 0);
            v.execute(id);
        }
        uint256 last = _request(100e6);
        assertEq(v.bondOf(last), BOND); // no longer within budget: bonded
        setDelay(v, last, 0, 0);
        assertEq(v.getRequest(last).executableAt, block.timestamp + 15 minutes);
    }

    function test_vetoedSmallRequest_refundsWithoutBond() public {
        uint256 id = _request(100e6);
        vote(v, w[1], id, false);
        vote(v, w[2], id, false);
        vote(v, w[3], id, false);
        assertEq(v.getRequest(id).state, T.REQ_VETOED);
        assertEq(tokenOf(v).balanceOf(w[0]), 10_000e6);
    }
}

/// Pool swaps while CRE is live must consume a pre-cleared KIND_SWAP request.
contract CreLiveSwapTest is NetworkTest {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    OrbitalHook hook;
    OrbitalRouter router;
    Vault nvidia;
    Vault palantir;
    address[] p;

    function setUp() public override {
        super.setUp();
        address at = address(FLAGS ^ (uint160(0x4444) << 144));
        deployCodeTo("OrbitalHook.sol:OrbitalHook", abi.encode(ext.poolManager, net.factory, deployer), at);
        hook = OrbitalHook(at);
        router = new OrbitalRouter(IPoolManager(ext.poolManager), hook);
        vm.startPrank(deployer);
        hook.setRouter(address(router));
        factory().setHook(at);
        vm.stopPrank();
        for (uint256 i; i < 3; i++) {
            p.push(makeAddr(string.concat("palantir", vm.toString(i))));
        }
        nvidia = onboard("nvidia", 3);
        palantir = Vault(factory().createVault("palantir", config(p)));
        _lp(nvidia, w[0], 10_000e6);
        _lp(palantir, p[0], 10_000e6);
        report(T.Report(T.REPORT_HEARTBEAT, address(0), 0, bytes32(0), 0, 0, 0, 0, 0));
    }

    function _lp(Vault vlt, address wallet, uint256 amount) internal {
        depositUsdc(vlt, wallet, amount + 1_000e6);
        vm.startPrank(wallet);
        tokenOf(vlt).approve(address(hook), amount);
        hook.addLiquidity(vlt.token(), amount);
        tokenOf(vlt).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(uint256 amountIn) internal {
        (address tin, address tout) = (palantir.token(), nvidia.token());
        if (armed) {
            armed = false;
            vm.expectRevert();
        }
        vm.prank(p[0]);
        router.swap(tin, tout, amountIn, true, 0, w[0]);
    }

    /// _swap reads the token addresses first, so expectRevert is armed inside it, after those calls.
    bool armed;

    function _expectSwapRevert() internal {
        armed = true;
    }

    function test_live_swapWithoutRequestReverts() public {
        _expectSwapRevert();
        _swap(100e6);
    }

    function test_live_swapConsumesClearedRequest() public {
        vm.prank(p[0]);
        uint256 id = palantir.requestSwap(100e6);
        assertEq(tokenOf(palantir).balanceOf(p[0]), 1_000e6); // nothing escrowed
        assertEq(palantir.getRequest(id).destination, address(hook));

        _expectSwapRevert(); // not scored yet: still at MaxDelay
        _swap(100e6);

        setDelay(palantir, id, 0, 0);
        _swap(100e6);
        assertEq(palantir.getRequest(id).state, T.REQ_EXECUTED);
        assertGt(tokenOf(nvidia).balanceOf(w[0]), 1_000e6 + 99e6);

        _expectSwapRevert(); // consumed: one request, one swap
        _swap(10e6);
    }

    function test_swapRequestCantBeExecutedDirectly() public {
        vm.prank(p[0]);
        uint256 id = palantir.requestSwap(100e6);
        setDelay(palantir, id, 0, 0);
        vm.expectRevert(VaultBase.BadKind.selector);
        palantir.execute(id);
    }
}
