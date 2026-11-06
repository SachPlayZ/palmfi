// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {BaseHook} from "@uniswap/v4-hooks-public/src/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {IVault} from "../interfaces/IPalm.sol";

/// Exposes the payer of the payment in flight (held in transient storage for one transaction).
interface IPayerContext {
    function payer() external view returns (address);
}

/// One 1:1 pool per (Vault, Underlying): Underlying <-> that Vault's Protected token, 0 fee, tick spacing 1,
/// zero LPs. Built on Uniswap Labs' BaseAggregatorHook / LitePSM shape: `beforeSwap` takes the input from the
/// PoolManager, runs the Vault's own wrap/unwrap (one policy engine), settles the output and returns a delta
/// that fully consumes the swap so the concentrated-liquidity math never runs (a NoOp swap).
///
/// The real swapper comes only from a fixed set of trusted routers (Universal Router 2.1.2 and the V4Quoter,
/// via IMsgSender). When the Universal Router reports our PaymentRouter as its caller, the hook asks the
/// PaymentRouter for the original payer. Unwraps are charged to that Hot wallet's Instant budget by the Vault.
///
/// Route shape: exact-in only. The input must already be in the PoolManager when the hook runs, so Universal
/// Router routes SETTLE the input first, then SWAP, then TAKE (the pool has no liquidity to borrow from).
contract VaultHook is BaseHook {
    using PoolIdLibrary for PoolKey;

    uint24 public constant FEE = 0;
    int24 public constant TICK_SPACING = 1;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    struct Pool {
        address vault;
        address underlying;
        address protectedToken;
    }

    address public immutable factory;
    address public immutable universalRouter;
    address public immutable quoter;
    address public immutable paymentRouter;

    mapping(PoolId => Pool) public pools;
    /// vault => underlying => pool key id
    mapping(address => mapping(address => PoolId)) public poolIdOf;

    bool private transient _entered;

    event VaultPoolCreated(PoolId indexed poolId, address indexed vault, address underlying, address protectedToken);
    event VaultSwap(PoolId indexed poolId, address indexed swapper, address indexed vault, bool isUnwrap, uint256 amount);

    error NotFactory();
    error PoolNotAllowed();
    error LiquidityNotAllowed();
    error UntrustedRouter(address sender);
    error UnknownPayer();
    error ExactInputOnly();
    error Reentrancy();

    constructor(IPoolManager pm, address factory_, address universalRouter_, address quoter_, address paymentRouter_)
        BaseHook(pm)
    {
        factory = factory_;
        universalRouter = universalRouter_;
        quoter = quoter_;
        paymentRouter = paymentRouter_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    // ------------------------------------------------------------------
    // Pool creation (factory only, at onboarding)
    // ------------------------------------------------------------------

    /// Called by the VaultFactory in the onboarding transaction: one pool per (Vault, Underlying).
    function initializePools(address vault, address[] calldata underlyings, address[] calldata tokens) external {
        if (msg.sender != factory) revert NotFactory();
        for (uint256 i; i < underlyings.length; i++) {
            PoolKey memory key = poolKeyFor(underlyings[i], tokens[i]);
            PoolId id = key.toId();
            pools[id] = Pool(vault, underlyings[i], tokens[i]);
            poolIdOf[vault][underlyings[i]] = id;
            poolManager.initialize(key, SQRT_PRICE_1_1);
            emit VaultPoolCreated(id, vault, underlyings[i], tokens[i]);
        }
    }

    function poolKeyFor(address underlying, address protectedToken_) public view returns (PoolKey memory key) {
        (address c0, address c1) =
            underlying < protectedToken_ ? (underlying, protectedToken_) : (protectedToken_, underlying);
        key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), FEE, TICK_SPACING, IHooks(address(this)));
    }

    /// Only pools this hook initializes itself (from `initializePools`) with the registered key pass.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != address(this)) revert PoolNotAllowed();
        Pool memory p = pools[key.toId()];
        if (p.vault == address(0) || key.fee != FEE || key.tickSpacing != TICK_SPACING) revert PoolNotAllowed();
        return IHooks.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityNotAllowed();
    }

    // ------------------------------------------------------------------
    // Swaps
    // ------------------------------------------------------------------

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (_entered) revert Reentrancy();
        _entered = true;

        PoolId id = key.toId();
        Pool memory p = pools[id];
        if (p.vault == address(0)) revert PoolNotAllowed();
        if (params.amountSpecified >= 0) revert ExactInputOnly();
        address swapper = realSwapper(sender);

        uint256 amount = uint256(-params.amountSpecified);
        Currency input = params.zeroForOne ? key.currency0 : key.currency1;
        bool isUnwrap = Currency.unwrap(input) == p.protectedToken;

        if (isUnwrap) {
            // Protected token PM -> Vault (allowed by the token), Vault burns, sends Underlying to the PM.
            poolManager.take(Currency.wrap(p.protectedToken), p.vault, amount);
            poolManager.sync(Currency.wrap(p.underlying));
            IVault(p.vault).hookUnwrap(p.underlying, amount, swapper);
        } else {
            // Underlying PM -> Vault, Vault mints the Protected token into the PM. It can only leave the PM to
            // one of the Owner's Hot wallets (or back to the Vault), whoever the route's recipient is.
            poolManager.take(Currency.wrap(p.underlying), p.vault, amount);
            poolManager.sync(Currency.wrap(p.protectedToken));
            IVault(p.vault).hookWrap(p.underlying, amount);
        }
        poolManager.settle();

        emit VaultSwap(id, swapper, p.vault, isUnwrap, amount);
        _entered = false;
        // exact-in: the hook took `amount` of the input (specified, +) and paid `amount` of the output (-).
        int128 a = int128(int256(amount));
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(a, -a), 0);
    }

    /// The real swapper behind a PoolManager `sender`: trusted routers only, PaymentRouter resolved to its payer.
    function realSwapper(address sender) public view returns (address swapper) {
        if (sender != universalRouter && sender != quoter) revert UntrustedRouter(sender);
        swapper = IMsgSender(sender).msgSender();
        if (swapper == paymentRouter && paymentRouter != address(0)) {
            swapper = IPayerContext(paymentRouter).payer();
            if (swapper == address(0)) revert UnknownPayer();
        }
    }
}
