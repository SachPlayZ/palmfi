// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// Seeds palmfi's plain v4 pools (WETH/USDC for Safe-harbor swaps, LINK/USDC for payments) with real tokens:
/// initializes at a given price if needed and adds one concentrated position around it. Positions are owned by
/// this contract and are not withdrawable (testnet seed liquidity).
contract PoolSeeder is IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable poolManager;

    error NotPoolManager();

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    /// sqrtPriceX96 for token1-per-token0 given each token's USD price (any common decimals) and token decimals.
    function sqrtPriceFromUsd(uint256 usd0, uint8 dec0, uint256 usd1, uint8 dec1) public pure returns (uint160) {
        uint256 priceX192 = FullMath.mulDiv(usd0 * 10 ** dec1, 1 << 192, usd1 * 10 ** dec0);
        return uint160(Math.sqrt(priceX192));
    }

    /// Initializes `key` at `sqrtPriceX96` (if new) and adds liquidity in ±`widthTicks` around the current tick,
    /// pulling at most amount0Max/amount1Max from msg.sender (approve this contract first).
    function seed(PoolKey calldata key, uint160 sqrtPriceX96, int24 widthTicks, uint256 amount0Max, uint256 amount1Max)
        external
        returns (uint128 liquidity)
    {
        (uint160 sqrtP,,,) = poolManager.getSlot0(key.toId());
        if (sqrtP == 0) {
            poolManager.initialize(key, sqrtPriceX96);
            sqrtP = sqrtPriceX96;
        }
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        int24 s = key.tickSpacing;
        int24 lower = ((tick - widthTicks) / s) * s;
        int24 upper = ((tick + widthTicks) / s + 1) * s;
        if (lower < TickMath.minUsableTick(s)) lower = TickMath.minUsableTick(s);
        if (upper > TickMath.maxUsableTick(s)) upper = TickMath.maxUsableTick(s);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0Max, amount1Max
        );
        poolManager.unlock(abi.encode(key, lower, upper, liquidity, msg.sender));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, int24 lower, int24 upper, uint128 liquidity, address payer) =
            abi.decode(data, (PoolKey, int24, int24, uint128, address));
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)
            }),
            ""
        );
        _pay(key.currency0, payer, d.amount0());
        _pay(key.currency1, payer, d.amount1());
        return "";
    }

    function _pay(Currency c, address payer, int128 delta) internal {
        if (delta >= 0) return;
        poolManager.sync(c);
        IERC20(Currency.unwrap(c)).safeTransferFrom(payer, address(poolManager), uint256(uint128(-delta)));
        poolManager.settle();
    }
}
