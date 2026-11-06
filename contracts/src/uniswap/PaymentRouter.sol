// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PalmTypes as T} from "../libraries/PalmTypes.sol";
import {IHub, IVault} from "../interfaces/IPalm.sol";
import {IUniversalRouter, IPermit2, URRoutes} from "./UniswapTypes.sol";

interface IFactoryNames {
    function vaultOf(string calldata label) external view returns (address);
    function hook() external view returns (address);
    function isVault(address) external view returns (bool);
}

interface IProtectedTokenLike {
    function vault() external view returns (address);
    function underlying() external view returns (address);
}

/// Pay a palmfi name with any token in one Universal Router transaction (scene 2):
/// tokenIn -> ... -> the payee's Protected token through the VaultHook, delivered to the payee's default
/// receiver (one of their Hot wallets). Takes a 10 bps fee in the input token for the Token Jar, and refuses
/// unless the payee's Vault status in the Hub is `active`.
///
/// The Universal Router reports this contract as `msgSender()`, so the VaultHook asks `payer()` for the original
/// payer, which is held in transient storage for the duration of `pay`.
contract PaymentRouter {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 10;

    IUniversalRouter public immutable universalRouter;
    IPermit2 public immutable permit2;
    IFactoryNames public immutable factory;
    IHub public immutable hub;
    address public immutable tokenJar;

    address private transient _payer;

    event Paid(
        string label,
        address indexed vault,
        address indexed payer,
        address tokenIn,
        uint256 amountIn,
        uint256 fee,
        address protectedToken,
        uint256 received
    );

    error UnknownName();
    error NotActive(uint8 status);
    error BadRoute();
    error Reentrancy();
    error TooLittleReceived(uint256 received, uint256 minOut);

    constructor(address universalRouter_, address permit2_, address factory_, address hub_, address tokenJar_) {
        universalRouter = IUniversalRouter(universalRouter_);
        permit2 = IPermit2(permit2_);
        factory = IFactoryNames(factory_);
        hub = IHub(hub_);
        tokenJar = tokenJar_;
    }

    /// The payer of the payment in flight (zero outside `pay`). Read by the VaultHook.
    function payer() external view returns (address) {
        return _payer;
    }

    /// Fee charged on `amountIn` (in the input token).
    function feeOf(uint256 amountIn) public pure returns (uint256) {
        return amountIn * FEE_BPS / 10_000;
    }

    /// @param path v4 hops from `tokenIn`; the last hop must be the payee's VaultHook pool, ending in their
    ///        Protected token. Output (≥ minOut) goes to the payee's default receiver.
    function pay(
        string calldata label,
        address tokenIn,
        uint256 amountIn,
        PathKey[] calldata path,
        uint256 minOut,
        uint256 deadline
    ) external returns (uint256 received) {
        if (_payer != address(0)) revert Reentrancy();
        address vault = factory.vaultOf(label);
        if (vault == address(0)) revert UnknownName();
        uint8 s = hub.statusOf(vault);
        if (s != T.STATUS_ACTIVE) revert NotActive(s);

        address pToken = _checkRoute(vault, path);
        address receiver = IVault(vault).defaultReceiver();

        uint256 fee = feeOf(amountIn);
        uint256 net = amountIn - fee;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), net);
        if (fee > 0) IERC20(tokenIn).safeTransferFrom(msg.sender, tokenJar, fee);

        IERC20(tokenIn).forceApprove(address(permit2), net);
        permit2.approve(tokenIn, address(universalRouter), uint160(net), uint48(block.timestamp));

        uint256 before = IERC20(pToken).balanceOf(receiver);
        _payer = msg.sender;
        (bytes memory commands, bytes[] memory inputs) = URRoutes.exactIn(tokenIn, path, net, minOut, receiver, true);
        universalRouter.execute(commands, inputs, deadline);
        _payer = address(0);

        received = IERC20(pToken).balanceOf(receiver) - before;
        if (received < minOut) revert TooLittleReceived(received, minOut);
        emit Paid(label, vault, msg.sender, tokenIn, amountIn, fee, pToken, received);
    }

    function _checkRoute(address vault, PathKey[] calldata path) internal view returns (address pToken) {
        if (path.length == 0) revert BadRoute();
        PathKey calldata last = path[path.length - 1];
        if (address(last.hooks) != factory.hook()) revert BadRoute();
        pToken = Currency.unwrap(last.intermediateCurrency);
        if (pToken.code.length == 0 || IProtectedTokenLike(pToken).vault() != vault) revert BadRoute();
        if (IVault(vault).protectedToken(IProtectedTokenLike(pToken).underlying()) != pToken) revert BadRoute();
    }
}
