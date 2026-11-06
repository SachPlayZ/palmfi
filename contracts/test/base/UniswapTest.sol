// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {NetworkTest, IERC20Like} from "./NetworkTest.sol";
import {Vault} from "../../src/Vault.sol";
import {VaultHook} from "../../src/uniswap/VaultHook.sol";
import {PaymentRouter} from "../../src/uniswap/PaymentRouter.sol";
import {IUniversalRouter, IPermit2, URRoutes} from "../../src/uniswap/UniswapTypes.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";

/// Shared helpers for the Uniswap fork tests: real Universal Router 2.1.2 routes via Permit2.
abstract contract UniswapTest is NetworkTest {
    address internal bob = makeAddr("bob"); // outside payer
    address internal vendor = makeAddr("vendor"); // outside payee (not a palmfi Owner)

    function hook() internal view returns (VaultHook) {
        return VaultHook(net.uni.hook);
    }

    function payRouter() internal view returns (PaymentRouter) {
        return PaymentRouter(net.uni.paymentRouter);
    }

    function pm() internal view returns (IPoolManager) {
        return IPoolManager(ext.poolManager);
    }

    function hookKey(Vault v, address underlying) internal view returns (PoolKey memory) {
        return hook().poolKeyFor(underlying, v.protectedToken(underlying));
    }

    function hop(address to, PoolKey memory key) internal pure returns (PathKey memory) {
        return PathKey(Currency.wrap(to), key.fee, key.tickSpacing, key.hooks, "");
    }

    function path1(PathKey memory a) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = a;
    }

    function path2(PathKey memory a, PathKey memory b) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](2);
        p[0] = a;
        p[1] = b;
    }

    /// `actor` runs one exact-in Universal Router route, pulling `tokenIn` via Permit2.
    function urSwap(
        address actor,
        address tokenIn,
        PathKey[] memory path,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) internal {
        _urSwap(actor, tokenIn, path, amountIn, minOut, recipient, false);
    }

    /// Same route, expecting the Universal Router call itself to revert (hook/Vault/token errors bubble up).
    function urSwapReverts(
        address actor,
        address tokenIn,
        PathKey[] memory path,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) internal {
        _urSwap(actor, tokenIn, path, amountIn, minOut, recipient, true);
    }

    function _urSwap(
        address actor,
        address tokenIn,
        PathKey[] memory path,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bool reverts
    ) private {
        (bytes memory commands, bytes[] memory inputs) =
            URRoutes.exactIn(tokenIn, path, amountIn, minOut, recipient, true);
        vm.startPrank(actor, actor);
        IERC20Like(tokenIn).approve(ext.permit2, type(uint256).max);
        IPermit2(ext.permit2).approve(tokenIn, ext.universalRouter, uint160(amountIn), uint48(block.timestamp + 1));
        if (reverts) vm.expectRevert();
        IUniversalRouter(ext.universalRouter).execute(commands, inputs, block.timestamp + 60);
        vm.stopPrank();
    }

    function bal(address token, address who) internal view returns (uint256) {
        return IERC20Like(token).balanceOf(who);
    }
}

/// A non-router unlocker: swaps the hook directly, mints and redeems ERC-6909 claims.
contract RawPoolUser is IUnlockCallback {
    IPoolManager internal immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function swapDirect(PoolKey calldata key, bool zeroForOne, uint256 amount) external {
        pm.unlock(abi.encode(uint8(0), abi.encode(key, zeroForOne, amount)));
    }

    /// Pulls `amount` of `token` from `from` into the PoolManager and mints the claim to `to`.
    function mintClaim(address token, address from, address to, uint256 amount) external {
        pm.unlock(abi.encode(uint8(1), abi.encode(token, from, to, amount)));
    }

    /// Burns `from`'s claim (this contract must be their operator) and takes the token to `to`.
    function redeemClaim(address token, address from, address to, uint256 amount) external {
        pm.unlock(abi.encode(uint8(2), abi.encode(token, from, to, amount)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 mode, bytes memory args) = abi.decode(data, (uint8, bytes));
        if (mode == 0) {
            (PoolKey memory key, bool zeroForOne, uint256 amount) = abi.decode(args, (PoolKey, bool, uint256));
            pm.swap(
                key,
                SwapParams(
                    zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                ""
            );
        } else {
            (address token, address from, address to, uint256 amount) =
                abi.decode(args, (address, address, address, uint256));
            if (mode == 1) {
                pm.sync(Currency.wrap(token));
                IERC20Like2(token).transferFrom(from, address(pm), amount);
                pm.settle();
                pm.mint(to, uint256(uint160(token)), amount);
            } else {
                pm.burn(from, uint256(uint160(token)), amount);
                pm.take(Currency.wrap(token), to, amount);
            }
        }
        return "";
    }
}

interface IERC20Like2 {
    function transferFrom(address, address, uint256) external returns (bool);
}
