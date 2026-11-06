// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// Universal Router 2.1.2 entry point (unowned, non-upgradeable).
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// Permit2 AllowanceTransfer surface the Universal Router pulls through.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// Universal Router command bytes we use (universal-router contracts/libraries/Commands.sol).
library URCommands {
    uint8 internal constant V4_SWAP = 0x10;
}

/// Builds Universal Router 2.1.x V4_SWAP inputs (struct shape with `minHopPriceX36`, UR >= 2.1.1).
/// Shape: SETTLE(input, amountIn, payerIsUser) -> SWAP_EXACT_IN(path, OPEN_DELTA) -> TAKE(output, recipient, all).
/// Settling first puts the input in the PoolManager before the VaultHook runs (its pools have no liquidity).
library URRoutes {
    function exactIn(
        address tokenIn,
        PathKey[] memory path,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bool payerIsUser
    ) internal pure returns (bytes memory commands, bytes[] memory inputs) {
        bytes memory actions =
            abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_IN), uint8(Actions.TAKE));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(Currency.wrap(tokenIn), amountIn, payerIsUser);
        params[1] = abi.encode(
            IV4Router.ExactInputParams({
                currencyIn: Currency.wrap(tokenIn),
                path: path,
                minHopPriceX36: new uint256[](0),
                amountIn: 0, // OPEN_DELTA: the credit from SETTLE
                amountOutMinimum: uint128(minOut)
            })
        );
        params[2] = abi.encode(path[path.length - 1].intermediateCurrency, recipient, uint256(0)); // 0 = full credit
        commands = abi.encodePacked(URCommands.V4_SWAP);
        inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
    }
}
