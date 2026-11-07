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
import {OrbitalTicks} from "./OrbitalTicks.sol";

/// The Vault as the Orbital pool sees it (ADR-0010).
interface IOrbitalVault {
    function token() external view returns (address);
    function isFrozen() external view returns (bool);
    function canSettleOut() external view returns (bool);
    function isWallet(address) external view returns (bool);
    function chargeOutflow(address wallet, uint256 amount) external;
    function settleOut(uint256 amount, address toVault) external;
    function settleIn(uint256 amount) external;
    function wallets() external view returns (address[] memory);
    function repayLifeline(uint256 principal, uint256 fee, address payeeVault) external;
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
///
/// Lifeline (ADR-0013): a Frozen Vault whose Recovery key and wallet majority approve it can keep paying a payee
/// Vault it already paid before the freeze. The pool fronts the payee's own token from the payee's float; the debt
/// is repaid in USDC from the frozen reserves (which never move while frozen) on the first `settle` after the
/// freeze resolves, and the payee earns a fee for the float it lent.
contract OrbitalHook is BaseHook, IUnlockCallback {
    
    /// Liquidity concentration around the peg (virtual reserves = C × real at balance): keeps unevenly funded
    /// pools on the curve. Ticks are measured on the virtual reserves, as price bands.
    uint256 public constant CONCENTRATION = 20;
    /// The tick an LP lands in by default: the full sphere (no cap).
    uint256 public constant DEFAULT_TICK = 10;
    uint256 public virtualOffset;
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
    uint256 internal constant TICKS = 10;
    /// True while the fitted scale uses tight ticks (otherwise the plain sphere).
    bool public ticksOn;
    uint256 public radius;

    /// Orbital ticks: liquidity per tick (1 = tightest cap near the peg … 10 = the full sphere), pool-wide and per
    /// token, so a Vault withdraws from the tick it deposited in. All weight in tick 10 is the plain sphere.
    uint256[10] internal _tickWeight;
    mapping(address => uint256[10]) internal _tokenTickLiq;

    bool transient _initializing;

    /// Lifeline: outstanding fronted principal per payee token is at most this share of its own liquidity.
    uint256 public constant LIFELINE_POOL_BPS = 5_000;

    struct Debt {
        address from; // frozen payer token
        address to; // payee token whose float fronted it
        uint128 principal;
        uint128 fee;
    }

    /// Open Lifeline debts, repaid (and removed) by `settle`.
    Debt[] public debts;
    /// Fronted principal outstanding, per payee token.
    mapping(address => uint256) public owedTo;

    event TokenRegistered(address indexed token, address indexed vault, uint256 index);
    event LiquidityAdded(address indexed token, address indexed wallet, uint256 amount);
    event LiquidityRemoved(address indexed token, address indexed wallet, uint256 amount);
    event OrbitalSwap(address indexed tokenIn, address indexed tokenOut, address payer, uint256 amountIn, uint256 amountOut);
    event Settled(address indexed fromToken, address indexed toToken, uint256 amount);
    event LifelineFronted(address indexed fromToken, address indexed toToken, address recipient, uint256 amount, uint256 fee);
    event LifelineRepaid(address indexed fromToken, address indexed toToken, uint256 amount, uint256 fee);

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
    error BadTick();
    error TickExhausted();
    error NotFrozen();

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
        if (tokens.length >= MAX_TOKENS) return; // pool full: the Vault still onboards, just without a pool seat
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
    uint8 internal constant FRONT = 3;

    /// An org adds its own token from one of its wallets (value stays its own: no outflow), in the default tick.
    function addLiquidity(address token, uint256 amount) external {
        _add(token, amount, DEFAULT_TICK);
    }

    /// Same, choosing a tick: 1 is the tightest cap around the peg (deepest, but the pool stops trading toward it
    /// sooner once the price runs away), 10 the full sphere.
    function addLiquidity(address token, uint256 amount, uint256 tick) external {
        _add(token, amount, tick);
    }

    function _add(address token, uint256 amount, uint256 tick) internal {
        if (tick == 0 || tick > TICKS) revert BadTick();
        address v = _vault(token);
        if (!IOrbitalVault(v).isWallet(msg.sender)) revert NotWallet();
        poolManager.unlock(abi.encode(ADD, token, amount, msg.sender));
        reserveOf[token] += amount;
        liquidityOf[token] += amount;
        _tokenTickLiq[token][tick - 1] += amount;
        _tickWeight[tick - 1] += amount;
        _resize(true);
        emit LiquidityAdded(token, msg.sender, amount);
    }

    /// Withdraw own-token liquidity (default tick) to one of the org's wallets. Settles first, so an LP only
    /// ever gets its own token back; if the pool still lacks it (issuers frozen), the rest waits.
    function removeLiquidity(address token, uint256 amount, address to) external {
        _remove(token, amount, to, DEFAULT_TICK);
    }

    function removeLiquidity(address token, uint256 amount, address to, uint256 tick) external {
        _remove(token, amount, to, tick);
    }

    function _remove(address token, uint256 amount, address to, uint256 tick) internal {
        if (tick == 0 || tick > TICKS) revert BadTick();
        address v = _vault(token);
        if (!IOrbitalVault(v).isWallet(msg.sender) || !IOrbitalVault(v).isWallet(to)) revert NotWallet();
        if (amount > _tokenTickLiq[token][tick - 1]) revert InsufficientLiquidity();
        poolManager.unlock(abi.encode(REMOVE, token, amount, to));
        liquidityOf[token] -= amount;
        _tokenTickLiq[token][tick - 1] -= amount;
        _tickWeight[tick - 1] -= amount;
        _resize(false);
        emit LiquidityRemoved(token, msg.sender, amount);
    }

    function tickLiquidity(address token, uint256 tick) external view returns (uint256) {
        return _tokenTickLiq[token][tick - 1];
    }

    /// Deferred burn-and-mint: move every token's excess (held beyond what its issuer provided) to the tokens
    /// that are short, issuer Vault → receiving Vault in USDC. Anyone may call (the Reconciler does each pass).
    function settle() external returns (uint256 moved) {
        moved = abi.decode(poolManager.unlock(abi.encode(SETTLE, address(0), 0, address(0))), (uint256));
        if (moved > 0) _resize(false);
    }

    // ------------------------------------------------------------------
    // Lifeline (ADR-0013)
    // ------------------------------------------------------------------

    /// Called by a Frozen Vault (after its Recovery key and wallet majority approved, and it checked the payee is
    /// a known counterparty): pay `amount` of the payee's own token to the payee's wallet from the pool, owed back
    /// in USDC once the payer's freeze resolves.
    function lifelineDraw(address payeeVault, uint256 amount, uint256 fee) external {
        address from = IOrbitalVault(msg.sender).token();
        if (_index[from] == 0 || vaultOf[from] != msg.sender) revert UnknownToken();
        if (!IOrbitalVault(msg.sender).isFrozen() || IOrbitalVault(msg.sender).canSettleOut()) revert NotFrozen();
        address to = IOrbitalVault(payeeVault).token();
        if (_index[to] == 0 || vaultOf[to] != payeeVault) revert UnknownToken();
        if (IOrbitalVault(payeeVault).isFrozen()) revert FrozenToken(to);
        if ((owedTo[to] + amount) * 10_000 > liquidityOf[to] * LIFELINE_POOL_BPS) revert InsufficientLiquidity();
        if (amount > reserveOf[to]) revert InsufficientReserve();
        address recipient = IOrbitalVault(payeeVault).wallets()[0];
        poolManager.unlock(abi.encode(FRONT, to, amount, recipient));
        reserveOf[to] -= amount;
        owedTo[to] += amount;
        debts.push(Debt(from, to, uint128(amount), uint128(fee)));
        _resize(false);
        emit LifelineFronted(from, to, recipient, amount, fee);
    }

    function debtCount() external view returns (uint256) {
        return debts.length;
    }

    /// Repay every Lifeline whose payer can settle again (unfrozen, or migrated with the debt kept back) into a
    /// payee that isn't frozen: USDC payer Vault → payee Vault, which mints the principal back into the pool.
    function _repay() internal returns (uint256 moved) {
        for (uint256 i = debts.length; i > 0; i--) {
            Debt memory d = debts[i - 1];
            (address vf, address vt) = (vaultOf[d.from], vaultOf[d.to]);
            if (!IOrbitalVault(vf).canSettleOut() || IOrbitalVault(vt).isFrozen()) continue;
            IOrbitalVault(vf).repayLifeline(d.principal, d.fee, vt);
            poolManager.sync(Currency.wrap(d.to));
            IOrbitalVault(vt).settleIn(d.principal);
            poolManager.settle();
            poolManager.mint(address(this), Currency.wrap(d.to).toId(), d.principal);
            reserveOf[d.to] += d.principal;
            owedTo[d.to] -= d.principal;
            moved += d.principal;
            debts[i - 1] = debts[debts.length - 1];
            debts.pop();
            emit LifelineRepaid(d.from, d.to, d.principal, d.fee);
        }
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
        } else if (op == FRONT) {
            poolManager.burn(address(this), c.toId(), amount);
            poolManager.take(c, who, amount);
        } else {
            uint256 repaid = _repay();
            return abi.encode(repaid + _settle());
        }
        return "";
    }

    function _settle() internal returns (uint256 moved) {
        uint256 n = tokens.length;
        for (uint256 i; i < n; i++) {
            address ti = tokens[i];
            if (reserveOf[ti] <= liquidityOf[ti] || !IOrbitalVault(vaultOf[ti]).canSettleOut()) continue;
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
        // Only tokens with liquidity sit on the sphere (an unfunded token would trade at a fake price).
        if (liquidityOf[tokenIn] == 0 || liquidityOf[tokenOut] == 0 || radius == 0) revert InsufficientLiquidity();
        if (ticksOn) {
            (OrbitalTicks.Ticks memory t, OrbitalTicks.Pool memory pool) = _tickPool(tokenIn, tokenOut);
            if (exactIn) (amountIn, amountOut) = (amount, OrbitalTicks.outGivenIn(t, pool, amount, reserveOf[tokenOut]));
            else (amountIn, amountOut) = (OrbitalTicks.inGivenOut(t, pool, amount), amount);
            if (amountIn == 0 || amountOut == 0) revert TickExhausted(); // every tick at its boundary: no more in this direction
        } else {
            uint256 ai = radius - (reserveOf[tokenIn] + virtualOffset);
            uint256 aj = radius - (reserveOf[tokenOut] + virtualOffset);
            if (exactIn) (amountIn, amountOut) = (amount, OrbitalMath.outGivenIn(ai, aj, amount));
            else (amountIn, amountOut) = (OrbitalMath.inGivenOut(ai, aj, amount), amount);
        }
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

    /// Sums over the funded tokens' virtual reserves X = x + V.
    function _stats() internal view returns (uint256 n, uint256 sx, uint256 sx2) {
        for (uint256 i; i < tokens.length; i++) {
            if (liquidityOf[tokens[i]] == 0) continue;
            uint256 x = reserveOf[tokens[i]] + virtualOffset;
            n++;
            sx += x;
            sx2 += x * x;
        }
    }

    function _tickPool(address tokenIn, address tokenOut)
        internal
        view
        returns (OrbitalTicks.Ticks memory t, OrbitalTicks.Pool memory pool)
    {
        uint256 n;
        (n, pool.sumX, pool.sumX2) = _stats();
        t = OrbitalTicks.build(n, _tickWeight);
        pool.c = radius;
        pool.xi = reserveOf[tokenIn] + virtualOffset;
        pool.xj = reserveOf[tokenOut] + virtualOffset;
    }

    function _hasTightTicks() internal view returns (bool) {
        for (uint256 b; b < TICKS - 1; b++) {
            if (_tickWeight[b] != 0) return true;
        }
        return false;
    }

    /// Re-fit the curve to the funded tokens' reserves: V = (C−1)·L/N, then the plain sphere, or the tick torus when
    /// any tight tick holds liquidity. Registered tokens without liquidity stay off the curve, so spam
    /// registrations can't push it off-curve. `strict`: a liquidity add whose ticks cannot be fitted reverts;
    /// exits and settlements instead fall back to the plain sphere, so funds never wait on the tick fit.
    function _resize(bool strict) internal {
        (uint256 n, uint256 total) = (0, 0);
        for (uint256 i; i < tokens.length; i++) {
            if (liquidityOf[tokens[i]] == 0) continue;
            n++;
            total += reserveOf[tokens[i]];
        }
        ticksOn = false;
        if (n < 2 || total == 0) {
            (virtualOffset, radius) = (0, 0);
            return;
        }
        virtualOffset = (CONCENTRATION - 1) * total / n;
        if (_hasTightTicks()) {
            (, uint256 sx, uint256 sx2) = _stats();
            OrbitalTicks.Ticks memory t = OrbitalTicks.build(n, _tickWeight);
            try this.fitTicks(t, sx, sx2) returns (uint256 c) {
                (radius, ticksOn) = (c, true);
                return;
            } catch {
                if (strict) revert BadTick();
            }
        }
        uint256[] memory X = new uint256[](n);
        uint256 k;
        for (uint256 i; i < tokens.length; i++) {
            if (liquidityOf[tokens[i]] == 0) continue;
            X[k++] = reserveOf[tokens[i]] + virtualOffset;
        }
        radius = OrbitalMath.radius(X);
    }

    /// External only so `_resize` can catch a failed fit.
    function fitTicks(OrbitalTicks.Ticks memory t, uint256 sx, uint256 sx2) external view returns (uint256) {
        return OrbitalTicks.fit(t, sx, sx2);
    }
}
