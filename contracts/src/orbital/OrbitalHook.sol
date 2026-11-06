// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {BaseHook} from "@uniswap/v4-hooks-public/src/base/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IMsgSender} from "@uniswap/v4-periphery/src/interfaces/IMsgSender.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {OrbitalMath} from "./OrbitalMath.sol";

/// The Vault as the Orbital pool sees it (ADR-0010).
interface IOrbitalVault {
    function token() external view returns (address);
    function isFrozen() external view returns (bool);
    function isWallet(address) external view returns (bool);
    function chargeOutflow(address wallet, uint256 amount) external;
    function settleOut(uint256 amount, address toVault) external;
    function settleIn(uint256 amount) external;
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// One N-token Orbital pool behind Uniswap v4 (brief §8, ADR-0010). Every Protected token is a coordinate;
/// each 2-token PoolKey(tokenA, tokenB, this) is a facade over the shared reserves, which this hook holds itself.
/// Reserves are ERC-6909 claims this hook holds in the PoolManager (the tokens themselves sit in the PoolManager).
/// Swaps are a NoOp custom curve: `beforeSwap` mints input claims, burns output claims and returns a delta that
/// consumes the whole swap, so v4's concentrated-liquidity math never runs.
///
/// Payer controls: the swap-in is charged to the payer Vault's Instant budget (`chargeOutflow`) like an Unwrap;
/// the payer is read from the one trusted router's `msgSender()`. A swap touching a Frozen Vault's token reverts.
/// Output can only leave the PoolManager to a wallet of the output token's own Vault (token-level whitelist).
///
/// Liquidity: each org adds only its own token (from one of its wallets) and only ever gets its own token back.
/// Foreign inventory the pool accumulates is settled Vault-to-Vault (`settle`): the issuer burns its tokens
/// here and sends their USDC to the under-supplied Vault, which mints its own token back in. A Frozen issuer
/// halts its settlement.
contract OrbitalHook is BaseHook, IUnlockCallback {
    /// Liquidity concentration around the peg (virtual reserves = C × real at balance).
    uint256 public constant CONCENTRATION = 20;
    uint256 public constant MAX_TOKENS = 32;
    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;

    address public immutable factory;
    address public immutable admin;
    address public router;

    address[] public tokens;
    mapping(address => uint256) internal _index; // token → index + 1
    mapping(address => address) public vaultOf; // token → Vault
    /// Real reserves (ERC-6909 claims of this hook), per token.
    mapping(address => uint256) public reserveOf;
    /// Own-token liquidity each org has provided (what it may withdraw), per token.
    mapping(address => uint256) public liquidityOf;

    /// Sphere state, recomputed on every liquidity or settlement event.
    uint256 public virtualOffset;
    uint256 public radius;

    bool transient _initializing;

    event TokenRegistered(address indexed token, address indexed vault, uint256 index);
    event LiquidityAdded(address indexed token, address indexed wallet, uint256 amount);
    event LiquidityRemoved(address indexed token, address indexed wallet, uint256 amount);
    event OrbitalSwap(address indexed tokenIn, address indexed tokenOut, address payer, uint256 amountIn, uint256 amountOut);
    event Settled(address indexed fromToken, address indexed toToken, uint256 amount);

    error OnlyFactory();
    error OnlyAdmin();
    error AlreadySet();
    error UnknownToken();
    error UntrustedRouter();
    error FrozenToken(address token);
    error NotWallet();
    error InsufficientReserve();
    error InsufficientLiquidity();
    error TooManyTokens();
    error PoolNotAllowed();
    error LiquidityNotAllowed();

    constructor(IPoolManager pm, address factory_, address admin_) BaseHook(pm) {
        factory = factory_;
        admin = admin_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeSwap = true;
        p.beforeSwapReturnDelta = true;
    }

    /// The router whose `msgSender()` the hook trusts (set once).
    function setRouter(address router_) external {
        if (msg.sender != admin) revert OnlyAdmin();
        if (router != address(0)) revert AlreadySet();
        router = router_;
    }

    // ------------------------------------------------------------------
    // Registration (factory) and pool facades
    // ------------------------------------------------------------------

    /// A new Vault's token joins the sphere: one facade PoolKey with every existing token.
    function registerToken(address vault) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (tokens.length >= MAX_TOKENS) revert TooManyTokens();
        address t = IOrbitalVault(vault).token();
        tokens.push(t);
        _index[t] = tokens.length;
        vaultOf[t] = vault;
        _initializing = true;
        for (uint256 i; i + 1 < tokens.length; i++) {
            poolManager.initialize(keyFor(tokens[i], t), SQRT_PRICE_1_1);
        }
        _initializing = false;
        emit TokenRegistered(t, vault, tokens.length - 1);
    }

    function keyFor(address a, address b) public view returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), 0, 1, IHooks(address(this)));
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// Only this hook creates its facades (no foreign pools on our hook, no fee/tick variants).
    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal view override returns (bytes4) {
        if (sender != address(this) || !_initializing) revert PoolNotAllowed();
        return IHooks.beforeInitialize.selector;
    }

    /// v4 concentrated liquidity is never used: LP goes through `addLiquidity`.
    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityNotAllowed();
    }

    // ------------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------------

    uint8 internal constant ADD = 0;
    uint8 internal constant REMOVE = 1;
    uint8 internal constant SETTLE = 2;

    /// An org adds its own token from one of its wallets (value stays its own: no outflow).
    function addLiquidity(address token, uint256 amount) external {
        address v = _vault(token);
        if (!IOrbitalVault(v).isWallet(msg.sender)) revert NotWallet();
        poolManager.unlock(abi.encode(ADD, token, amount, msg.sender));
        reserveOf[token] += amount;
        liquidityOf[token] += amount;
        _resize();
        emit LiquidityAdded(token, msg.sender, amount);
    }

    /// Withdraw own-token liquidity to one of the org's wallets. Settles first, so an LP only ever gets its
    /// own token back; if the pool still lacks it (issuers frozen), the rest waits.
    function removeLiquidity(address token, uint256 amount, address to) external {
        address v = _vault(token);
        if (!IOrbitalVault(v).isWallet(msg.sender) || !IOrbitalVault(v).isWallet(to)) revert NotWallet();
        if (amount > liquidityOf[token]) revert InsufficientLiquidity();
        poolManager.unlock(abi.encode(REMOVE, token, amount, to));
        liquidityOf[token] -= amount;
        _resize();
        emit LiquidityRemoved(token, msg.sender, amount);
    }

    /// Deferred burn-and-mint: move every token's excess (held beyond what its issuer provided) to the tokens
    /// that are short, issuer Vault → receiving Vault in USDC. Anyone may call (the Reconciler does each pass).
    function settle() external returns (uint256 moved) {
        moved = abi.decode(poolManager.unlock(abi.encode(SETTLE, address(0), 0, address(0))), (uint256));
        if (moved > 0) _resize();
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (uint8 op, address token, uint256 amount, address who) = abi.decode(data, (uint8, address, uint256, address));
        Currency c = Currency.wrap(token);
        if (op == ADD) {
            poolManager.sync(c);
            IERC20Min(token).transferFrom(who, address(poolManager), amount);
            poolManager.settle();
            poolManager.mint(address(this), c.toId(), amount);
        } else if (op == REMOVE) {
            if (reserveOf[token] < amount) _settle();
            if (reserveOf[token] < amount) revert InsufficientReserve();
            reserveOf[token] -= amount;
            poolManager.burn(address(this), c.toId(), amount);
            poolManager.take(c, who, amount);
        } else {
            return abi.encode(_settle());
        }
        return "";
    }

    function _settle() internal returns (uint256 moved) {
        uint256 n = tokens.length;
        for (uint256 i; i < n; i++) {
            address ti = tokens[i];
            if (reserveOf[ti] <= liquidityOf[ti] || IOrbitalVault(vaultOf[ti]).isFrozen()) continue;
            for (uint256 j; j < n && reserveOf[ti] > liquidityOf[ti]; j++) {
                address tj = tokens[j];
                if (reserveOf[tj] >= liquidityOf[tj] || IOrbitalVault(vaultOf[tj]).isFrozen()) continue;
                uint256 excess = reserveOf[ti] - liquidityOf[ti];
                uint256 short = liquidityOf[tj] - reserveOf[tj];
                uint256 m = excess < short ? excess : short;
                // issuer side: its tokens leave the pool to its Vault, which burns them and pays USDC across
                poolManager.burn(address(this), Currency.wrap(ti).toId(), m);
                poolManager.take(Currency.wrap(ti), vaultOf[ti], m);
                IOrbitalVault(vaultOf[ti]).settleOut(m, vaultOf[tj]);
                // receiving side: its Vault mints the same amount into the pool
                poolManager.sync(Currency.wrap(tj));
                IOrbitalVault(vaultOf[tj]).settleIn(m);
                poolManager.settle();
                poolManager.mint(address(this), Currency.wrap(tj).toId(), m);
                reserveOf[ti] -= m;
                reserveOf[tj] += m;
                moved += m;
                emit Settled(ti, tj, m);
            }
        }
    }

    // ------------------------------------------------------------------
    // Swaps
    // ------------------------------------------------------------------

    /// Quote without state change; reverts like the swap would (unknown / frozen / short reserve).
    function quote(address tokenIn, address tokenOut, uint256 amount, bool exactIn)
        public
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        _vault(tokenIn);
        _vault(tokenOut);
        if (IOrbitalVault(vaultOf[tokenIn]).isFrozen()) revert FrozenToken(tokenIn);
        if (IOrbitalVault(vaultOf[tokenOut]).isFrozen()) revert FrozenToken(tokenOut);
        uint256 ai = radius - (reserveOf[tokenIn] + virtualOffset);
        uint256 aj = radius - (reserveOf[tokenOut] + virtualOffset);
        if (exactIn) (amountIn, amountOut) = (amount, OrbitalMath.outGivenIn(ai, aj, amount));
        else (amountIn, amountOut) = (OrbitalMath.inGivenOut(ai, aj, amount), amount);
        if (amountOut > reserveOf[tokenOut]) revert InsufficientReserve();
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (sender != router || router == address(0)) revert UntrustedRouter();
        address payer = IMsgSender(sender).msgSender();
        (Currency cin, Currency cout) =
            params.zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        address tin = Currency.unwrap(cin);
        address tout = Currency.unwrap(cout);
        bool exactIn = params.amountSpecified < 0;
        uint256 specified = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        (uint256 amountIn, uint256 amountOut) = quote(tin, tout, specified, exactIn);

        // Payer controls: Instant budget (reverts over budget → use the Vault's queued requestPayment).
        IOrbitalVault(vaultOf[tin]).chargeOutflow(payer, amountIn);

        poolManager.mint(address(this), cin.toId(), amountIn);
        poolManager.burn(address(this), cout.toId(), amountOut);
        reserveOf[tin] += amountIn;
        reserveOf[tout] -= amountOut;
        emit OrbitalSwap(tin, tout, payer, amountIn, amountOut);

        // Hook delta: it receives the input and owes the output (LitePSM sign convention).
        (int128 dSpecified, int128 dUnspecified) = exactIn
            ? (int128(int256(amountIn)), -int128(int256(amountOut)))
            : (-int128(int256(amountOut)), int128(int256(amountIn)));
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(dSpecified, dUnspecified), 0);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _vault(address token) internal view returns (address v) {
        if (_index[token] == 0) revert UnknownToken();
        v = vaultOf[token];
    }

    /// Re-fit the sphere to the current reserves: V = (C−1)·L/N, r through X = x + V.
    function _resize() internal {
        uint256 n = tokens.length;
        uint256 total;
        for (uint256 i; i < n; i++) {
            total += reserveOf[tokens[i]];
        }
        if (n < 2 || total == 0) {
            (virtualOffset, radius) = (0, 0);
            return;
        }
        uint256 v = (CONCENTRATION - 1) * total / n;
        uint256[] memory X = new uint256[](n);
        for (uint256 i; i < n; i++) {
            X[i] = reserveOf[tokens[i]] + v;
        }
        virtualOffset = v;
        radius = OrbitalMath.radius(X);
    }
}
