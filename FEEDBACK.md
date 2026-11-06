# Uniswap v4 developer feedback

From building palmfi's **Orbital pool**: an N-token AMM (Paradigm's Orbital with ticks: nested spherical caps consolidated into a torus invariant) as one v4 hook on Arc testnet. Code: [`contracts/src/orbital/`](contracts/src/orbital).

## What worked well

- **NoOp custom curves** (`beforeSwap` + `beforeSwapReturnDelta`) are the right primitive for a non-CPMM curve: v4's concentrated-liquidity math never runs, and the hook owns pricing completely. The LitePSM-style examples were the most useful reference.
- **ERC-6909 claims** made shared reserves cheap: the hook holds every token's reserve as claims in the PoolManager and mints or burns them per swap, with no ERC-20 transfers inside the swap.
- **Flash accounting** let settlement between two issuers (take the issuer's tokens, it burns them and sends USDC across, the receiver mints into the PoolManager, then `settle`) happen in one `unlock` with no intermediate balances.
- **Hook address mining** (`HookMiner` + the standard CREATE2 deployer) worked unchanged on Arc.

## Friction, and what would have helped

1. **N-token pools have no first-class shape.** A pool is 2 currencies, so N tokens on one curve means N·(N−1)/2 facade `PoolKey`s over shared reserves, each initialized separately (O(N²) initializes as tokens join), and a `beforeInitialize` guard so nobody else attaches our hook to other pairs. A documented "multi-asset hook" pattern, or a way to declare that one hook owns all pairs it is attached to, would remove a lot of boilerplate and gas.
2. **Where custom-curve reserves should live is undocumented.** Our first version `take`-ed output tokens inside `beforeSwap`; it failed with `ERC20TransferFailed` because the PoolManager doesn't hold the input yet at that point. The fix (reserves as the hook's ERC-6909 claims: mint input, burn output, real tokens settled by the router) was obvious only afterwards. One worked example of a custom curve that holds its own inventory would save hours.
3. **`BeforeSwapDelta` signs are hard to get right.** Specified and unspecified swap between exact-in and exact-out, and the hook's sign is the opposite of the swapper's. A table in the docs (exact-in/out × zeroForOne → expected `toBeforeSwapDelta(a, b)` for a full NoOp) would help.
4. **Hook errors arrive wrapped.** Reverts from hooks come back as `WrappedError(hook, selector, reason, details)`, so `vm.expectRevert(MyHook.MyError.selector)` doesn't match and tests fall back to a bare `expectRevert()`. A forge helper (or documented pattern) to assert the inner error would make hook tests much tighter.
5. **Knowing the real user.** Our hook charges the payer's budget, so it must know who is paying. `IMsgSender` is only a convention: every hook keeps its own allow-list of routers it trusts. A canonical registry, or a standard way for routers to attest the original caller, would make policy hooks composable with the Universal Router.
6. **Deployments on newer chains.** On Arc we found the PoolManager through a third-party listing and verified it onchain ourselves; the Universal Router wasn't listed, so we shipped a minimal router. An official per-chain address page covering Arc would remove the guesswork.
7. **Parameters that don't apply to a NoOp curve are still required**: `sqrtPriceLimitX96`, the initial price, and `tickSpacing`. Our facades initialize at 1:1 and swap with MIN/MAX price limits only to satisfy validation. A NoOp mode that skips them would make intent clearer.

8. **Non-CPMM curves with iterative solvers fight the gas model.** Solving the tick torus on-chain is a bisection of a quartic-shaped residual (≈10–40 `sqrt`s per swap). A hook-side `quote` that the router and the PoolManager's `swap` both trust, or a documented pattern for view-only quoting of NoOp curves, would help; we had to expose our own `quote()` and keep it in sync with `beforeSwap`.

## Numbers

- `OrbitalHook` 18.4 KB runtime (with the tick solver), `OrbitalRouter` 3.4 KB.
- Swap gas (forge fork, includes PoolManager + router): ≈0.39M on the plain sphere, ≈0.69M when tight ticks hold liquidity.
- 14 Orbital tests (swaps both directions, exact in/out, frozen-token halt, settlement, LP add/remove, fuzzed invariant) plus audit regressions, on an Arc fork against the live PoolManager.
