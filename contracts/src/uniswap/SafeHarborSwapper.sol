// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ISafeHarborSwapper} from "../interfaces/IPalm.sol";

interface IIsVault {
    function isVault(address) external view returns (bool);
}

/// Safe-harbor swaps: WETH -> USDC for factory Vaults, through the PoolManager directly, over a fixed allowlist
/// of WETH/USDC pool keys set at deployment. Only that direction exists. The calling Vault transfers the WETH
/// first and checks the Chainlink-based minimum output itself; this contract also enforces `minOut`.
contract SafeHarborSwapper is ISafeHarborSwapper, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    address public immutable factory;
    address public immutable weth;
    address public immutable usdc;

    mapping(PoolId => bool) public allowed;

    error NotVault();
    error NotPoolManager();
    error NotAllowlisted();
    error BadPair();
    error MissingInput();
    error PartialFill();
    error TooLittleOut(uint256 out, uint256 minOut);

    event PoolAllowlisted(PoolId indexed id);

    constructor(IPoolManager pm, address factory_, address weth_, address usdc_, PoolKey[] memory keys) {
        poolManager = pm;
        factory = factory_;
        weth = weth_;
        usdc = usdc_;
        for (uint256 i; i < keys.length; i++) {
            address c0 = Currency.unwrap(keys[i].currency0);
            address c1 = Currency.unwrap(keys[i].currency1);
            if (!((c0 == weth_ && c1 == usdc_) || (c0 == usdc_ && c1 == weth_))) revert BadPair();
            allowed[keys[i].toId()] = true;
            emit PoolAllowlisted(keys[i].toId());
        }
    }

    /// @param route abi.encode(PoolKey) of an allowlisted WETH/USDC pool.
    function swap(uint256 amountIn, uint256 minOut, bytes calldata route) external returns (uint256 amountOut) {
        if (!IIsVault(factory).isVault(msg.sender)) revert NotVault();
        PoolKey memory key = abi.decode(route, (PoolKey));
        if (!allowed[key.toId()]) revert NotAllowlisted();
        if (IERC20(weth).balanceOf(address(this)) < amountIn) revert MissingInput();
        amountOut = abi.decode(poolManager.unlock(abi.encode(key, amountIn, msg.sender)), (uint256));
        if (amountOut < minOut) revert TooLittleOut(amountOut, minOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 amountIn, address vault) = abi.decode(data, (PoolKey, uint256, address));
        bool zeroForOne = Currency.unwrap(key.currency0) == weth; // always WETH in, USDC out
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 inDelta = zeroForOne ? d.amount0() : d.amount1();
        int128 outDelta = zeroForOne ? d.amount1() : d.amount0();
        uint256 paid = uint256(uint128(-inDelta));
        uint256 out = uint256(uint128(outDelta));
        if (paid != amountIn) revert PartialFill(); // the Vault already burned the full pETH amount

        poolManager.sync(Currency.wrap(weth));
        IERC20(weth).safeTransfer(address(poolManager), paid);
        poolManager.settle();
        poolManager.take(Currency.wrap(usdc), vault, out);
        return abi.encode(out);
    }
}
