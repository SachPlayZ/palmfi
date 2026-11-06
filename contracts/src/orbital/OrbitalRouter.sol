// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {OrbitalHook, IERC20Min} from "./OrbitalHook.sol";

/// Minimal v4 router for the Orbital pool (Universal Router is unverified on Arc, brief §8.5). The hook trusts
/// only this router's `msgSender()`: the wallet that called `swap`, whose Vault the swap-in is charged to.
/// The output goes to `recipient`, which the output token only accepts if it is a wallet of its own Vault.
contract OrbitalRouter is IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable poolManager;
    OrbitalHook public immutable hook;

    address transient _locker;

    error OnlyPoolManager();
    error Slippage(uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager pm, OrbitalHook hook_) {
        poolManager = pm;
        hook = hook_;
    }

    /// The wallet the current swap is for (IMsgSender, read by the hook).
    function msgSender() external view returns (address) {
        return _locker;
    }

    /// Exact in: pay `amount` of `tokenIn`, get at least `limit` of `tokenOut`.
    /// Exact out: get `amount` of `tokenOut`, pay at most `limit` of `tokenIn`.
    function swap(address tokenIn, address tokenOut, uint256 amount, bool exactIn, uint256 limit, address recipient)
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        _locker = msg.sender;
        (amountIn, amountOut) = abi.decode(
            poolManager.unlock(abi.encode(msg.sender, tokenIn, tokenOut, amount, exactIn, recipient)), (uint256, uint256)
        );
        _locker = address(0);
        if (exactIn ? amountOut < limit : amountIn > limit) revert Slippage(amountIn, amountOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (address payer, address tokenIn, address tokenOut, uint256 amount, bool exactIn, address recipient) =
            abi.decode(data, (address, address, address, uint256, bool, address));
        PoolKey memory key = hook.keyFor(tokenIn, tokenOut);
        bool zeroForOne = tokenIn < tokenOut;
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: exactIn ? -int256(amount) : int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        (int128 dIn, int128 dOut) = zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 amountIn = uint256(int256(-dIn));
        uint256 amountOut = uint256(int256(dOut));

        poolManager.sync(Currency.wrap(tokenIn));
        IERC20Min(tokenIn).transferFrom(payer, address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(Currency.wrap(tokenOut), recipient, amountOut);
        return abi.encode(amountIn, amountOut);
    }
}
