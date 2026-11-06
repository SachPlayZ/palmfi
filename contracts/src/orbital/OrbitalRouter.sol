// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal single-hop v4 router for Arc (Universal Router there is unverified).
/// @dev PoolSwapTest-style. Payer = msg.sender (exposed via msgSender() for OrbitalHook); output goes
///      to `recipient`, which is also passed to the hook as hookData so the hook can whitelist-check it.
contract OrbitalRouter is IUnlockCallback, IMsgSender {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    address transient locker;

    error NotPoolManager();
    error Locked();
    error Slippage(uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    /// @param amountSpecified < 0 exact-in, > 0 exact-out (v4 convention)
    /// @param limit exact-in: min out; exact-out: max in
    function swap(PoolKey calldata key, bool zeroForOne, int256 amountSpecified, uint256 limit, address recipient)
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (locker != address(0)) revert Locked();
        locker = msg.sender;
        (amountIn, amountOut) = abi.decode(
            poolManager.unlock(abi.encode(key, zeroForOne, amountSpecified, recipient, msg.sender)), (uint256, uint256)
        );
        locker = address(0);
        if (amountSpecified < 0 ? amountOut < limit : amountIn > limit) revert Slippage(amountIn, amountOut);
    }

    function msgSender() external view returns (address) {
        return locker;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified, address recipient, address payer) =
            abi.decode(data, (PoolKey, bool, int256, address, address));
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            abi.encode(recipient)
        );
        (Currency cIn, Currency cOut, int128 dIn, int128 dOut) = zeroForOne
            ? (key.currency0, key.currency1, d.amount0(), d.amount1())
            : (key.currency1, key.currency0, d.amount1(), d.amount0());
        uint256 amountIn = uint256(uint128(-dIn));
        uint256 amountOut = uint256(uint128(dOut));
        poolManager.sync(cIn);
        IERC20(Currency.unwrap(cIn)).safeTransferFrom(payer, address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(cOut, recipient, amountOut);
        return abi.encode(amountIn, amountOut);
    }
}
