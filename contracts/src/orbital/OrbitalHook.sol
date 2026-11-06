// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-hooks-public/src/base/BaseHook.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IOrbitalVault} from "./IOrbitalVault.sol";
import {OrbitalMath} from "./OrbitalMath.sol";

/// @notice Singleton v4 hook: one N-token Orbital sphere over every org's Protected token (ADR-0010).
/// @dev NoOp custom curve (LitePSM pattern): each pair PoolKey is a facade over shared reserves, which
///      sit in the PoolManager as this hook's ERC-6909 claims. Single sphere, no ticks (#35), no
///      settlement (#34). A token is in the sphere once it has reserves; swaps need both legs in.
contract OrbitalHook is BaseHook, IUnlockCallback {
    using SafeERC20 for IERC20Metadata;
    using SafeCast for uint256;
    using SafeCast for int256;

    uint24 public constant FEE = 0;
    int24 public constant TICK_SPACING = 1;
    uint160 internal constant SQRT_PRICE_1_1 = 1 << 96;

    address public immutable factory;
    mapping(address router => bool) public trustedRouter;

    struct TokenInfo {
        IOrbitalVault vault;
        uint64 scale; // 10**(18 - decimals): token units -> WAD
        bool registered;
    }

    address[] public tokens;
    mapping(address token => TokenInfo) public info;
    /// @notice Pool-held amount of each token, in token units (== this hook's ERC-6909 claim balance).
    mapping(address token => uint256) public reserveOf;
    /// @notice Cumulative own-token liquidity each token's vault put in (LP exit lands in #34).
    mapping(address token => uint256) public liquidityOf;

    event TokenRegistered(address indexed token, address indexed vault);
    event LiquidityAdded(address indexed token, uint256 amount);
    event OrbitalSwap(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    error NotFactory();
    error NotVault();
    error NotHook();
    error AlreadyRegistered();
    error UnknownToken();
    error BadPoolKey();
    error LiquidityNotAllowed();
    error UntrustedRouter();
    error Frozen(address token);
    error RecipientNotWallet(address recipient);
    error InactiveToken(address token);
    error ZeroAmount();

    constructor(IPoolManager pm, address factory_, address[] memory routers) BaseHook(pm) {
        factory = factory_;
        for (uint256 k; k < routers.length; ++k) {
            trustedRouter[routers[k]] = true;
        }
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    // ---------------------------------------------------------------- registry + liquidity

    /// @notice Factory adds a new org's Protected token and initializes its pair facade with every existing token.
    function registerToken(IOrbitalVault vault) external {
        if (msg.sender != factory) revert NotFactory();
        address token = vault.token();
        if (info[token].registered) revert AlreadyRegistered();
        uint8 dec = IERC20Metadata(token).decimals();
        info[token] = TokenInfo({vault: vault, scale: uint64(10 ** (18 - dec)), registered: true});
        for (uint256 k; k < tokens.length; ++k) {
            poolManager.initialize(pairKey(token, tokens[k]), SQRT_PRICE_1_1);
        }
        tokens.push(token);
        emit TokenRegistered(token, address(vault));
    }

    /// @notice A vault adds its own token (pulled via allowance). Counts as no outflow: value stays its own.
    function addLiquidity(IOrbitalVault vault, uint256 amount) external {
        if (msg.sender != address(vault)) revert NotVault();
        address token = vault.token();
        TokenInfo memory t = info[token];
        if (address(t.vault) != address(vault)) revert UnknownToken();
        if (vault.isFrozen()) revert Frozen(token);
        if (amount == 0) revert ZeroAmount();
        poolManager.unlock(abi.encode(token, address(vault), amount));
        reserveOf[token] += amount;
        liquidityOf[token] += amount;
        _radius(); // reverts if the new reserves admit no sphere (too one-sided)
        emit LiquidityAdded(token, amount);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (address token, address from, uint256 amount) = abi.decode(data, (address, address, uint256));
        Currency c = Currency.wrap(token);
        poolManager.sync(c);
        IERC20Metadata(token).safeTransferFrom(from, address(poolManager), amount);
        poolManager.settle();
        poolManager.mint(address(this), c.toId(), amount);
        return "";
    }

    // ---------------------------------------------------------------- hook callbacks

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != address(this)) revert NotHook();
        if (
            key.fee != FEE || key.tickSpacing != TICK_SPACING || address(key.hooks) != address(this)
                || !info[Currency.unwrap(key.currency0)].registered || !info[Currency.unwrap(key.currency1)].registered
        ) revert BadPoolKey();
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

    /// @dev hookData = abi.encode(recipient). The trusted router must deliver output to that recipient.
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!trustedRouter[sender]) revert UntrustedRouter();
        address user = IMsgSender(sender).msgSender();
        address recipient = abi.decode(hookData, (address));
        (Currency cIn, Currency cOut) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bool exactIn = params.amountSpecified < 0;
        uint256 specified = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);

        (uint256 amountIn, uint256 amountOut) = _swap(user, recipient, cIn, cOut, exactIn, specified);

        // exact-in: hook took `in` (specified +), owes `out` (unspecified -). exact-out: mirror.
        BeforeSwapDelta delta = exactIn
            ? toBeforeSwapDelta(amountIn.toInt256().toInt128(), -amountOut.toInt256().toInt128())
            : toBeforeSwapDelta(-amountOut.toInt256().toInt128(), amountIn.toInt256().toInt128());
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    function _swap(address user, address recipient, Currency cIn, Currency cOut, bool exactIn, uint256 specified)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        address tokenIn = Currency.unwrap(cIn);
        address tokenOut = Currency.unwrap(cOut);
        IOrbitalVault vIn = info[tokenIn].vault;
        if (vIn.isFrozen()) revert Frozen(tokenIn);
        if (info[tokenOut].vault.isFrozen()) revert Frozen(tokenOut);
        if (!info[tokenOut].vault.isWallet(recipient)) revert RecipientNotWallet(recipient);

        (amountIn, amountOut) = exactIn
            ? (specified, quoteExactIn(tokenIn, tokenOut, specified))
            : (quoteExactOut(tokenIn, tokenOut, specified), specified);
        if (amountIn == 0 || amountOut == 0) revert ZeroAmount();

        // Payer control: swap-in is an outflow of the payer's vault, same budget as an Unwrap.
        vIn.chargeOutflow(user, amountIn);

        reserveOf[tokenIn] += amountIn;
        reserveOf[tokenOut] -= amountOut;
        // Settle our own delta: claim the input, release the output. Returned delta nets them to zero.
        poolManager.mint(address(this), cIn.toId(), amountIn);
        poolManager.burn(address(this), cOut.toId(), amountOut);
        emit OrbitalSwap(user, tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    // ---------------------------------------------------------------- quotes

    function quoteExactIn(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        (uint256 r, uint256 si, uint256 so) = _prep(tokenIn, tokenOut);
        uint256 out = OrbitalMath.exactIn(r, reserveOf[tokenIn] * si, reserveOf[tokenOut] * so, amountIn * si);
        return out / so; // round down
    }

    function quoteExactOut(address tokenIn, address tokenOut, uint256 amountOut) public view returns (uint256) {
        (uint256 r, uint256 si, uint256 so) = _prep(tokenIn, tokenOut);
        uint256 inW = OrbitalMath.exactOut(r, reserveOf[tokenIn] * si, reserveOf[tokenOut] * so, amountOut * so);
        return (inW + si - 1) / si; // round up
    }

    function pairKey(address a, address b) public view returns (PoolKey memory) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(t0), Currency.wrap(t1), FEE, TICK_SPACING, IHooks(address(this)));
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// @notice Current sphere radius (WAD) over tokens with reserves.
    function radius() external view returns (uint256) {
        return _radius();
    }

    function _prep(address tokenIn, address tokenOut) internal view returns (uint256 r, uint256 si, uint256 so) {
        si = info[tokenIn].scale;
        so = info[tokenOut].scale;
        if (si == 0 || so == 0) revert UnknownToken();
        if (reserveOf[tokenIn] == 0) revert InactiveToken(tokenIn);
        if (reserveOf[tokenOut] == 0) revert InactiveToken(tokenOut);
        r = _radius();
    }

    /// @dev r from reserves (not stored), so rounding dust and one-sided adds are absorbed each call.
    function _radius() internal view returns (uint256) {
        (uint256 s, uint256 q, uint256 n) = (0, 0, 0);
        for (uint256 k; k < tokens.length; ++k) {
            address t = tokens[k];
            uint256 x = reserveOf[t] * info[t].scale;
            if (x == 0) continue;
            s += x;
            q += x * x;
            ++n;
        }
        return n < 2 ? 0 : OrbitalMath.radius(s, q, n);
    }
}
