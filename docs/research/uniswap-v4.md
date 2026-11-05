# Uniswap v4 research for palmfi VaultHook (Ethereum Sepolia)

Date: 2026-11-06. Sources: primary only (Uniswap docs, Uniswap/* GitHub at pinned commits, OZ uniswap-hooks, CertiK blog named in brief §17).
Pinned commits read (permalinks below use these):
v4-core `bea7f6d` (2026-10-23), v4-periphery `c6e4754` (2026-10-26), universal-router `f270612` (2026-11-05), v4-hooks-public `e354058` (2026-11-05), v4-template `1fbf955`, OZ uniswap-hooks `b5f1057` (2026-10-07).

Link shorthands (expanded in every link, listed here only for reading):
CORE = `github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6`,
PERI = `github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64`,
UR = `github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f`,
HP = `github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7`.

---

## TL;DR: what palmfi should do

1. Build VaultHook as a **NoOp custom-curve hook with zero LPs**, copying the structure of Uniswap Labs' own `BaseAggregatorHook` + `LitePSMAggregator` (flags: `beforeSwap`, `beforeSwapReturnDelta`, `beforeInitialize`, `beforeAddLiquidity`) ([BaseAggregatorHook.sol L84-90](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L84-L90)).
2. In `_beforeSwap`: `poolManager.take(input)` -> vault deposit/redeem -> `sync` -> transfer output to PM -> `settle` -> return `toBeforeSwapDelta(specified, unspecified)` that fully consumes the swap so the CL math is skipped ([LitePSMAggregator.sol L181-232](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/implementations/LitePSM/LitePSMAggregator.sol#L181-L232)).
3. `_beforeAddLiquidity` reverts always (LitePSM does exactly this) ([BaseAggregatorHook.sol L128-135](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L128-L135)). Initialization is permissionless, so `_beforeInitialize` must pin currency pair, fee, tickSpacing to the factory's vault and allow one canonical pool per vault ([LitePSM L158-179](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/implementations/LitePSM/LitePSMAggregator.sol#L158-L179); [CertiK](https://www.certik.com/resources/blog/uniswap-v4-hooks-security-considerations)).
4. Identify the user via `IMsgSender(sender).msgSender()` ONLY when `sender` is in an immutable trusted-router set (UR 2.1.2 `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3`, V4Quoter `0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244`) ([docs: msg.sender](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/accessing-msg.sender); [deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)). Reference implementation of the same pattern: [PermissionedHooks.sol](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/permissioned-pools/PermissionedHooks.sol).
5. Mine the hook address with `HookMiner` (CREATE2 proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C` in `forge script`; `deployCodeTo` in tests). The old `v4-periphery/src/utils/HookMiner.sol` was deleted (Feb 2026); use `v4-hooks-public/src/utils/HookMiner.sol` or the v4-template's pinned periphery ([doc/code mismatch, section 3](#3-hook-address-bits-and-hookminer)).
6. Do the "pay any token" legs on **UR 2.1.2** with `V4_SWAP`; **encode the 2.1.x structs with the new `minHopPriceX36` fields** (the official docs example still shows the old struct) ([IV4Router.sol](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/interfaces/IV4Router.sol#L30-L47); [supported-chains note](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)).
7. Enforce the whitelist **at the token layer on transfers out of the PoolManager** (that is the only place the real final recipient is visible, and it also closes the ERC-6909 cash-out path) [design inference from [PoolManager.take](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L291-L297)].
8. Do not use Permissioned Pools for the core: it exists on Sepolia but uses its own UR build, needs Uniswap Labs allowlisting for routing, and checks addresses only ([deploy page](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/deploy-a-permissioned-pool)).
9. Test with Foundry: v4-template `BaseTest`/`Deployers` (hookmate artifacts) + `deployCodeTo`; fuzz/invariant the 1:1 accounting; there is NO dedicated testing page in the docs.
10. Treat Aggregator-hook mainnet availability (brief gotcha 14) as UNVERIFIED from primary sources; the repo and docs do not state live chains (section 1.4).

---

## 1. Custom-curve / NoOp pattern

### 1.1 Core mechanics (v4-core)

- Hook needs both `BEFORE_SWAP_FLAG` (`1<<7`) and `BEFORE_SWAP_RETURNS_DELTA_FLAG` (`1<<3`); a return-delta flag without its base flag is an invalid address ([Hooks.sol L38-L46, L111](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L38-L46)).
- `Hooks.beforeSwap` requires the hook to return exactly 96 bytes (selector, delta, fee); if the return-delta flag is set, the delta's *specified* part is added to `amountToSwap`, and the swap type must not flip (exact-in stays <= 0, exact-out stays >= 0), else `HookDeltaExceedsSwapAmount` ([Hooks.sol L248-L282](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L248-L282)):

```solidity
if (self.hasPermission(BEFORE_SWAP_RETURNS_DELTA_FLAG)) {
    hookReturn = BeforeSwapDelta.wrap(result.parseReturnDelta());
    int128 hookDeltaSpecified = hookReturn.getSpecifiedDelta();
    if (hookDeltaSpecified != 0) {
        bool exactInput = amountToSwap < 0;
        amountToSwap += hookDeltaSpecified;
        if (exactInput ? amountToSwap > 0 : amountToSwap < 0) HookDeltaExceedsSwapAmount.selector.revertWith();
```
- Sign convention: "Positive: the hook is owed/took currency, negative: the hook owes/sent currency" ([IHooks.sol beforeSwap natspec](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/interfaces/IHooks.sol#L95-L103)). `BeforeSwapDelta` packs `specified` in the upper 128 bits, `unspecified` in the lower 128 ([BeforeSwapDelta.sol](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/types/BeforeSwapDelta.sol#L5-L16)).
- Specified currency = the side the user fixed: input for exact-in (`amountSpecified < 0`), output for exact-out (`amountSpecified > 0`). Unspecified = the other side.
- If `amountToSwap` becomes 0 the pool math is skipped: `Pool.swap` returns `ZERO_DELTA` immediately when `amountSpecified == 0` ([Pool.sol L320](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Pool.sol#L320)). The zero-amount check in `PoolManager.swap` runs BEFORE the hook, so the user cannot pass 0 but the hook can zero it ([PoolManager.sol L193-L202](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L193-L202)). Docs call this a **NoOp swap**; hooks doing it routinely "are essentially implementing custom trading logic or custom curves" ([security framework](https://developers.uniswap.org/docs/protocols/v4/security)).
- After the swap, the hook's delta is attributed to the hook and the *caller* pays/receives the opposite: `swapDelta = swapDelta - hookDelta`; `_accountPoolBalanceDelta(key, hookDelta, address(key.hooks))` ([Hooks.afterSwap L285-L313](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L285-L313); [PoolManager.sol L220-L226](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L220-L226)). Net: hook must end the callback with zero outstanding delta, so it must `take` what it is owed (input) and `settle` what it owes (output).
- PoolManager primitives used: `take(currency, to, amount)` (debits msg.sender's delta, transfers out), `sync(currency)` + ERC-20 transfer + `settle()` (credits msg.sender) ([PoolManager.sol L279-L307](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L279-L307)).

### 1.2 Reference implementation: Uniswap Labs aggregator hooks + LitePSM

Repo: [Uniswap/v4-hooks-public](https://github.com/Uniswap/v4-hooks-public/tree/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks) (docs list it as the home of "Aggregator Hooks ... LitePSM" ([hooks overview](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks))). README: LitePSM is a singleton, "zero-slippage, fixed-fee conversion", one pool per gem/USDS pair enforced at init ([aggregator README](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/README.md)).

Flow in `BaseAggregatorHook._beforeSwap` ([L137-L152](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L137-L152), [L154-L186](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L154-L186), [L205-L220](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L205-L220)):

1. `_internalSettle`: `settleCurrency` = swapper's output currency, `takeCurrency` = swapper's input currency; calls subclass `_conductSwap`.
2. `LitePSMAggregator._conductSwap` ([L181-L232](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/implementations/LitePSM/LitePSMAggregator.sol#L181-L232)):
   - exact-in: `poolManager.take(takeCurrency, address(this), amountTake)` where `amountTake = -amountSpecified`; call PSM (`sellGem`/`buyGem`); compute `amountSettle`.
   - exact-out: `amountSettle = amountSpecified`; compute required input with ceiling rounding; `take` that; call PSM.
   - then `poolManager.sync(settleCurrency); IERC20(tokenOut).safeTransfer(address(poolManager), amountSettle); poolManager.settle();` and returns `hasSettled = true`.
3. `_innerBeforeSwap` builds the delta (the "cancel core" trick):

```solidity
int128 unspecifiedDelta = _processAmounts(amountIn, amountOut, params.amountSpecified < 0);
int128 specified = int128(-params.amountSpecified); // cancel core
...
if (params.amountSpecified >= 0) {
    // For exactOut, in cases where the implementation's amountOut may be off.
    specified = -int128(uint128(amountOut));
}
...
return (IHooks.beforeSwap.selector, toBeforeSwapDelta(specified, unspecifiedDelta), 0);
```
   - `_processAmounts`: exact-in -> `unspecifiedDelta = -amountOut` (hook owes output); exact-out -> `unspecifiedDelta = +amountIn` (hook is owed input) ([L188-L203](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L188-L203)).
   - So exact-in: `specified = +X` (hook took X in), `unspecified = -Y` (hook sent Y out). Exact-out: `specified = -Y` (hook sent Y), `unspecified = +X`. Hook delta nets to zero with its own take/settle.
4. Protocol-fee skim and `quote()` are Uniswap-specific (token jar); **VaultHook can drop `ProtocolFees`/`IFeeClassifiedHook`** (UNVERIFIED that dropping them is accepted by Uniswap Labs routing allowlist; irrelevant on Sepolia).
5. 1:1 specifics for palmfi: if protected token and underlying have equal decimals there is no rounding: exact-in `amountOut = amountIn`, exact-out `amountIn = amountOut`. Make `_beforeSwap` revert if the hook cannot fully satisfy the swap; otherwise the leftover `amountToSwap != 0` runs against an empty pool and moves its price (exact-out would revert in the router as unfilled) ([V4Router exact-out unfilled check, IV4Router.sol L26-L29](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/interfaces/IV4Router.sol#L26-L29)).

Other Uniswap Labs examples of the same shape (fixed-rate conversion hook, no LPs): [WETHHook.sol](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/WETHHook.sol), [WstETHHook.sol](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/WstETHHook.sol), base [BaseTokenWrapperHook.sol](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/base/BaseTokenWrapperHook.sol) (NOT read in depth; UNVERIFIED how they differ; `BaseTokenWrapperHook` may be an even closer template for a 1:1 wrapper, read it first).

OZ alternative: `BaseCustomCurve` ([source](https://github.com/OpenZeppelin/uniswap-hooks/blob/b5f1057/src/base/BaseCustomCurve.sol)) is built around hook-held LP liquidity using ERC-6909 claim mint/burn in the hook (L181-L241); it does NOT fit a no-LP vault wrapper. OZ library is "not an official Uniswap Labs product ... without warranties" ([docs](https://developers.uniswap.org/docs/community/tooling/openzeppelin)).

### 1.3 Differences VaultHook needs vs LitePSM

- LitePSM does not restrict `sender` or user at all (open conversion); VaultHook must (section 4).
- LitePSM keeps zero custody between calls (take -> external call -> settle in same callback). Keep the same: hook should hold no balance after the call.
- The external call (vault deposit/redeem, token transfers of a permissioned protected token) happens while PoolManager is unlocked: security doc says assume all state can change across external calls and test reentrancy into same pool and other pools using the same hook ([security framework](https://developers.uniswap.org/docs/protocols/v4/security)). Add a reentrancy guard on `_beforeSwap`.

### 1.4 Aggregator hooks availability (brief §9.3, gotcha 14)

- UNVERIFIED from primary sources: I could not find a Uniswap-owned page stating "live only on Ethereum mainnet, Base, Robinhood Chain". Only a secondary web-search hit ([The Block, 2026-10-22](https://theblock.co/news/defi/2026-10-22-uniswaps-aggregator-hooks-go-live-ethereum-base-robinhood-chain-421932); not opened). The aggregator-hooks README states no chains; the hooks-public docs index lists Sepolia deployments only for StablePair/VolatilePair ([docs index](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/docs/autogen/src/pages/index.mdx#L74)). No Sepolia LitePSM deployment is documented. Keep "demo aggregator routing on a mainnet fork".

---

## 2. No-LP and pool-key restriction

- `beforeAddLiquidity` fires only when `liquidityDelta > 0`; everything else (<= 0) goes to `beforeRemoveLiquidity` ([Hooks.sol L196-L206](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L196-L206)). Reverting in `beforeAddLiquidity` is enough to guarantee zero LP liquidity; no remove hook needed. Official pattern:

```solidity
function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
    internal pure override returns (bytes4) { revert LiquidityNotAllowed(); }
```
([BaseAggregatorHook.sol L128-L135](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/BaseAggregatorHook.sol#L128-L135)).
- `donate` is not blocked, but `Pool.donate` reverts `NoLiquidityToReceiveFees` when liquidity is 0 ([Pool.sol L468](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Pool.sol#L468)), so with zero LPs donations cannot land.
- `PoolManager.initialize` is permissionless; it only validates ordering/tickSpacing/hook address and then calls the hook's `beforeInitialize(msg.sender, key, price)` ([PoolManager.sol L117-L142](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L117-L142); [Hooks.sol L177-L181](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L177-L181)). CertiK: "Anyone can create a pool with fake tokens and point it at a hook. Hooks for specific pairs should validate the PoolKey in `beforeInitialize()`" ([CertiK](https://www.certik.com/resources/blog/uniswap-v4-hooks-security-considerations)).
- LitePSM pattern (copy): pair check + canonical-pool-per-pair mapping, reverting `TokensNotSupported` / `PairAlreadyHasCanonicalPool` ([LitePSMAggregator.sol L158-L179](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/aggregator-hooks/implementations/LitePSM/LitePSMAggregator.sol#L158-L179)).
- VaultHook recommendation [inference]: in `_beforeInitialize`, require (a) `factory.vaultOfProtectedToken(token)` matches the pair, (b) `key.fee` and `key.tickSpacing` equal fixed constants, (c) one pool per vault, and optionally (d) `sender == factory` so only the factory initializes. Without (b)/(c) an attacker can pre-initialize the legit pair with unexpected fee/tickSpacing, producing a PoolKey (different PoolId) routers don't expect, or squat the canonical slot.
- Since the vault is 1 hook : N pools (one per vault) the hook is a singleton; state must be keyed by PoolId (docs: "a single hook contract should be able to service multiple pools" ([swap-hooks guide](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks))).

---

## 3. Hook address bits and HookMiner

- Permissions = low 14 bits of the hook address. Flags: BEFORE_INITIALIZE `1<<13`, AFTER_INITIALIZE `1<<12`, BEFORE_ADD_LIQ `1<<11`, AFTER_ADD_LIQ `1<<10`, BEFORE_REMOVE_LIQ `1<<9`, AFTER_REMOVE_LIQ `1<<8`, BEFORE_SWAP `1<<7`, AFTER_SWAP `1<<6`, BEFORE_DONATE `1<<5`, AFTER_DONATE `1<<4`, BEFORE_SWAP_RETURNS_DELTA `1<<3`, AFTER_SWAP_RETURNS_DELTA `1<<2`, AFTER_ADD_LIQ_RETURNS_DELTA `1<<1`, AFTER_REMOVE_LIQ_RETURNS_DELTA `1<<0` ([Hooks.sol L27-L47](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L27-L47)).
- VaultHook flags = `BEFORE_INITIALIZE | BEFORE_ADD_LIQUIDITY | BEFORE_SWAP | BEFORE_SWAP_RETURNS_DELTA` = `0x2000|0x0800|0x0080|0x0008` = low bits `0x2888`. Same four flags the LitePSM fork test mines ([LitePSMAggregator.fork.t.sol `_deployHook`](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/test/aggregator-hooks/LitePSM/LitePSMAggregator.fork.t.sol#L103-L108)). Address must have EXACTLY these bits: `BaseHook` constructor calls `Hooks.validateHookPermissions`, reverting on any extra or missing bit ([BaseHook.sol](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/base/BaseHook.sol#L17-L30); [Hooks.sol L83-L103](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L83-L103)).
- Mining: `HookMiner.find(deployer, flags, creationCode, constructorArgs)` loops salts up to `MAX_LOOP = 160_444`; in `forge script` the deployer is the CREATE2 proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`, in `forge test` it is `address(this)`/the pranker ([HookMiner.sol (hooks-public)](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/utils/HookMiner.sol); [docs: hook deployment](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment)). Docs snippet:

```solidity
bytes memory constructorArgs = abi.encode(POOLMANAGER);
(address hookAddress, bytes32 salt) =
    HookMiner.find(CREATE2_DEPLOYER, flags, type(PointsHook).creationCode, constructorArgs);
vm.broadcast();
PointsHook pointsHook = new PointsHook{salt: salt}(IPoolManager(POOLMANAGER));
require(address(pointsHook) == hookAddress, "PointsHookScript: hook address mismatch");
```
- Constructor args are part of the CREATE2 hash: if the vault factory address or trusted-router list is a constructor arg, mine AFTER those addresses are fixed.
- **Doc/code disagreement**: docs and v4-template import `v4-periphery/src/utils/HookMiner.sol` ([docs](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment); [template script L5](https://github.com/Uniswap/v4-template/blob/1fbf955/script/00_DeployHook.s.sol#L5)), but v4-periphery main removed `src/utils` (commit `5da22e6` 2026-02-06 "remove hooks and move to hook repo (#510)"); HookMiner now lives in `v4-hooks-public/src/utils/` and in periphery only under `test/shared/HookMiner.sol` ([PERI test/shared](https://github.com/Uniswap/v4-periphery/tree/c6e4754dab11bd38c6f08ac51c3c868569e93d64/test/shared)). The template still works because it resolves periphery through its pinned `uniswap-hooks` submodule (remappings: `@uniswap/v4-periphery/=lib/uniswap-hooks/lib/v4-periphery/`, [remappings.txt](https://github.com/Uniswap/v4-template/blob/1fbf955/remappings.txt)). Plan: vendor `HookMiner.sol` + `BaseHook.sol` from hooks-public (MIT) or use the template as-is.
- Test shortcut (template): `deployCodeTo("Counter.sol:Counter", constructorArgs, flags)` where `flags = address(uint160(FLAGS) ^ (0x4444 << 144))` ([Counter.t.sol](https://github.com/Uniswap/v4-template/blob/1fbf955/test/Counter.t.sol)). Docs: "For local testing, `deployCodeTo` cheatcode in Foundry can be used to deploy hook contract to any address" ([docs](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment)).
- Pitfall: a wrongly mined salt can enable undesired permissions or disable required callbacks; verify the permission bitmap in the deploy pipeline ([security framework](https://developers.uniswap.org/docs/protocols/v4/security)). Add a script `require` that `uint160(hook) & Hooks.ALL_HOOK_MASK == FLAGS`.
- UNVERIFIED: whether the Sepolia CREATE2 proxy `0x4e59...` exists on Sepolia (it is deployed on essentially all chains incl. Sepolia in practice; confirm with `cast code`).

---

## 4. Real user identity: `sender` is the router

- Hook callbacks receive `msg.sender` of `PoolManager.swap` as `sender`; it is "typically a swap router" ([swap-hooks guide](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/swap-hooks); [Hooks.beforeSwap passes `msg.sender`](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/libraries/Hooks.sol#L256)).
- Official pattern: "Maintain a trusted list of swap routers in the hook ... check if the sender is a trusted router ... call `msgSender()` view function on the router" ([docs: accessing msg.sender](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/accessing-msg.sender)). Interface ([IMsgSender.sol](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/interfaces/IMsgSender.sol)):

```solidity
interface IMsgSender { function msgSender() external view returns (address); }
```
- **Doc weakness**: the docs sample calls `msgSender()` on ANY `sender` (try/catch) and shows an *unauthenticated* `addRouter` ([same page](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/accessing-msg.sender)); the text says to check the trusted list but the final code sample does not. Do not copy it. Uniswap's own PermissionedHooks trusts `msgSender()` only through an adapter-level `allowedWrappers(router)` check ([PermissionedHooks.sol L137-L156](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/permissioned-pools/PermissionedHooks.sol#L137-L156)).
- Who implements `msgSender()`:
  - Universal Router: `msgSender()` returns `_getLocker()` = the caller of `execute()` ([Dispatcher.sol L43-L49](https://github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f/contracts/base/Dispatcher.sol#L43-L49); [Lock.sol](https://github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f/contracts/base/Lock.sol#L28-L30)); introduced Jul-Aug 2024 ("Make msgSender public (#365)" `43f1443`, in the v4 routing commit lineage); all Sepolia 2.x deployments post-date it.
  - V4Router/PositionManager (`msgSender()` via locker) ([V4Quoter.sol L155-L158](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/lens/V4Quoter.sol#L155-L158) shows the Quoter returns the quote caller). This means quotes via V4Quoter run through your hook with `msgSender()` = quote caller: set `from` in `eth_call` to the user to get accurate quotes, or quotes for non-whitelisted callers revert.
- Gotchas for palmfi:
  1. If Alice calls PaymentRouter, which calls `UR.execute`, `msgSender()` is the **PaymentRouter**, not Alice. The hook must whitelist-check the PaymentRouter (a trusted contract) or the PaymentRouter must do the user check itself. [inference from Dispatcher.msgSender]
  2. `executeSigned` exists in UR main ([UniversalRouter.sol L47-L64](https://github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f/contracts/UniversalRouter.sol#L47-L64)); `msgSender()` is still the submitter, with the signer in `signedRouteContext()`. UNVERIFIED whether deployed 2.1.2 includes `executeSigned`; ignore it, and trusting `msgSender()` only fails closed.
  3. The final recipient of output tokens is chosen by the router (`TAKE`/`TAKE_ALL` recipient); the hook cannot see it ([V4Router.sol L55-L80](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/V4Router.sol#L55-L80)). `TAKE_ALL` sends to `msgSender()`, `TAKE` to an arbitrary address. See brief gotcha 13 and the token-layer fix in TL;DR 7.
  4. Trusted-router set must be immutable or timelocked (brief: hooks immutable). UR 2.0 and 2.1.1 are sunset by Uniswap on 2026-10-21 ([notice](https://developers.uniswap.org/docs/changelog/active-notifications/sunset-of-universal-router-2-0-and-2-1-1)); trust 2.1.2 (+ Quoter) only, unless you also want the 2.1.1 address for direct-chain use.
  5. Other known router named in docs: [z0r0z/v4-router](https://github.com/z0r0z/v4-router) (third party, not Uniswap; do not trust by default).

---

## 5. ERC-6909 claims leakage

- Anyone holding a positive delta inside an unlock can `PoolManager.mint(to, id, amount)` to turn it into an ERC-6909 claim ([PoolManager.sol L322-L329](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L322-L329)); claims are freely transferable ERC-6909 balances and `burn`+`take` cash them out ([L331-L336](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L331-L336)).
- Uniswap's own statement: "A permissioned token held directly by the PoolManager could be minted into an ERC-6909 claim and traded without the allowlist. The adapter prevents this by restricting minting to authorized periphery contracts" ([Permissioned Pools architecture](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/architecture)).
- For VaultHook: a swapper that is allowed (or acts via a custom unlock-callback contract) could mint a claim of the protected token and circulate it among non-whitelisted parties. Cash-out (`burn` + `take`) performs an ERC-20 `transfer(PoolManager -> recipient)`, so a protected token that checks `to` on transfers whose `from == PoolManager` blocks it [design inference from [PoolManager.take](https://github.com/Uniswap/v4-core/blob/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/src/PoolManager.sol#L291-L297)]. Claims do not give vault redemption rights by themselves, but they can lock supply inside the PM and carry value among non-members; state that in docs (brief gotcha 12).
- Note: the `hookData`-less UR path (`V4_SWAP` actions) has `MINT_6909`/`BURN_6909` actions in the Actions library (0x17/0x18) ([Actions.sol L57-L58](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/libraries/Actions.sol#L57-L58)); whether `V4Router._handleAction` dispatches them is UNVERIFIED (the V4Router dispatch I read handles swap/settle/take actions only, [V4Router.sol L34-L80](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/V4Router.sol#L34-L80)), but a custom unlock contract can always call `mint`.
- CertiK post does not mention ERC-6909 ([CertiK](https://www.certik.com/resources/blog/uniswap-v4-hooks-security-considerations)).

---

## 6. Universal Router v4 integration

### 6.1 Versions
- UR is "unowned and non-upgradeable"; supports v2/v3/v4 ([overview](https://developers.uniswap.org/docs/protocols/universal-router/overview)). `V4_SWAP = 0x10`, `V4_INITIALIZE_POOL = 0x13`, `V4_POSITION_MANAGER_CALL = 0x14` ([Commands.sol](https://github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f/contracts/libraries/Commands.sol#L35-L39)). Docs table "Supported Commands (v2)" matches ([commands page](https://developers.uniswap.org/docs/protocols/universal-router/concepts/commands)).
- First UR with v4 routing: commit "Add v4 routing (#360)" 2024-08-03, i.e. the v2.0 line ("UniversalRouterV2") ([git history, `1b67109`](https://github.com/Uniswap/universal-router/commit/1b67109)); no doc states "minimum version" in one sentence. So: UR **>= 2.0** supports `V4_SWAP`. Sepolia recommended: **2.1.2** (the API default; 2.0/2.1.1 sunset 2026-10-21) ([sunset notice](https://developers.uniswap.org/docs/changelog/active-notifications/sunset-of-universal-router-2-0-and-2-1-1); [supported-chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)).
- **ABI break 2.0 -> 2.1.1**: "From 2.1.1 onward, the V2 and V3 swap commands carry an extra `minHopPriceX36` per-hop slippage array, and the v4 swap actions have the same field" ([supported-chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)). 2.1.1 -> 2.1.2 has "no calldata or ABI changes" ([sunset notice](https://developers.uniswap.org/docs/changelog/active-notifications/sunset-of-universal-router-2-0-and-2-1-1)). **The official swap guide still shows the old 5-field `ExactInputSingleParams`** ([guide](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/swapping)) versus the current struct below. Encode against the struct matching 2.1.2; confirm with a Sepolia dry-run. (The UR main submodule pin includes the minHop fields: [IV4Router.sol L30-L66](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/interfaces/IV4Router.sol#L30-L66).) UNVERIFIED: exact periphery commit of the deployed 2.1.2 bytecode; use Quoter + simulation to confirm decoding.

```solidity
struct ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn;
    uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }
struct ExactInputParams { Currency currencyIn; PathKey[] path; uint256[] minHopPriceX36;
    uint128 amountIn; uint128 amountOutMinimum; }
struct PathKey { Currency intermediateCurrency; uint24 fee; int24 tickSpacing; IHooks hooks; bytes hookData; }
```
([PathKey.sol](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/libraries/PathKey.sol#L9-L15)). `minHopPriceX36` may be empty (length 0) for exact-in multi-hop (the router only validates length if non-zero) ([V4Router.sol L102-L124](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/V4Router.sol#L102-L124)).

### 6.2 Actions (v4-periphery `Actions.sol`)
`SWAP_EXACT_IN_SINGLE 0x06`, `SWAP_EXACT_IN 0x07`, `SWAP_EXACT_OUT_SINGLE 0x08`, `SWAP_EXACT_OUT 0x09`, `SETTLE 0x0b`, `SETTLE_ALL 0x0c`, `TAKE 0x0e`, `TAKE_ALL 0x0f`, `TAKE_PORTION 0x10`, `SWEEP 0x14`, `WRAP 0x15`, `UNWRAP 0x16` ([Actions.sol](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/libraries/Actions.sol#L28-L58)).
- `SETTLE_ALL(currency, maxAmount)`: pulls the full debt from `msgSender()` (user via Permit2), reverts if debt > max. `TAKE_ALL(currency, minAmount)`: sends full credit to `msgSender()`, reverts if < min ([V4Router.sol L55-L66](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/V4Router.sol#L55-L66)). Use `TAKE` with an explicit recipient to pay a vendor/PaymentRouter.

Official single-hop example (old struct; add `minHopPriceX36` for 2.1.x) ([swap guide](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/swapping)):

```solidity
bytes memory commands = abi.encodePacked(uint8(Commands.V4_SWAP));
bytes memory actions = abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
params[1] = abi.encode(key.currency0, amountIn);      // SETTLE_ALL
params[2] = abi.encode(key.currency1, minAmountOut);  // TAKE_ALL
inputs[0] = abi.encode(actions, params);
router.execute(commands, inputs, deadline);
```
Docs note: "Never use block.timestamp or type(uint256).max as the deadline."

### 6.3 Multi-hop (palmfi "UNI -> USDC (regular pool) -> vUSDC (VaultHook)")
- Use `SWAP_EXACT_IN` with `currencyIn = UNI` and `path = [PathKey{intermediateCurrency: USDC, fee/tickSpacing/hooks of the regular pool}, PathKey{intermediateCurrency: vUSDC, fee/tickSpacing, hooks: VaultHook}]`. The router derives each hop's `PoolKey` and direction from the current currency and `intermediateCurrency` ([PathKey.sol getPoolAndSwapDirection](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/libraries/PathKey.sol#L26-L40)); the loop passes each hop's output as the next hop's input ([V4Router.sol L102-L124](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/V4Router.sol#L102-L124)). Then `SETTLE_ALL(UNI, max)` + `TAKE_ALL(vUSDC, min)`. Flash accounting nets the intermediate USDC to zero, so no USDC ever reaches the router or user.
- The router's `sender` for BOTH hops (and thus for VaultHook) is the UR; VaultHook sees `msgSender()` = whoever called `execute`.
- Docs warn hooks "may be invoked multiple times in the same transaction during routing; test ... multi-hop induced value leakage" ([security framework](https://developers.uniswap.org/docs/protocols/v4/security)).
- Exact-out through a no-LP hook: recent periphery work touched this: commit "tolerate hook-funded input on exact-output swaps (#584)" (Aug 2026) was **reverted** in #601 on 2026-09-16 and the UR 2.1.2-era submodule points at the revert state ([v4-periphery `bbd4346`](https://github.com/Uniswap/v4-periphery/commit/bbd4346); [UR submodule pin `a7af5b3`](https://github.com/Uniswap/v4-periphery/commit/a7af5b3)). Takeaway: exact-out through a custom-curve hook that pays the input is a shape routers are touchy about; for palmfi, prefer **exact-in** routes in the demo and test exact-out explicitly on Sepolia. (Exact-out output must be fully delivered else `V4ExactOutputUnfilled`.)
- ETH and native: use `address(0)` currency; not needed (USDC/vUSDC are ERC-20).

### 6.4 Permit2
- "Universal Router pulls a user's ERC-20 tokens through Permit2, so the user first approves the Permit2 contract once per token and then authorizes the router by signature. Native ETH does not require Permit2" ([UR overview FAQ](https://developers.uniswap.org/docs/protocols/universal-router/overview)). On-chain flow: `token.approve(permit2, max)`, then `permit2.approve(token, universalRouter, amount, expiration)` or `PERMIT2_PERMIT` command ([swap guide step 2](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/swapping)). Permit2 on Sepolia: `0x000000000022D473030F116dDEE9F6B43aC78BA3`.
- palmfi protected token must allow `transferFrom(user -> PoolManager)` initiated by Permit2 and `PoolManager -> recipient`; the PM is the counterparty for input settle and output take.

---

## 7. Ethereum Sepolia addresses (chain 11155111)

Source: [Uniswap v4 Deployments, "Sepolia: 11155111"](https://developers.uniswap.org/docs/protocols/v4/deployments) (fetched 2026-11-06; also mirrored in [UR deploy-addresses/sepolia.json](https://github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f/deploy-addresses/sepolia.json)). The page warns not to assume same addresses across chains.

| Contract | Address |
|---|---|
| PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| PositionManager | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4` |
| Universal Router 2.1.2 (recommended) | `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3` |
| Universal Router 2.1.1 (sunset 2026-10-21) | `0x7dfd4f31be6814d2906bde155c3e1b146eac1468` |
| Universal Router (unlabeled, "UniversalRouterV2" in repo = 2.0; sunset) | `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` |
| V4Quoter | `0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244` |
| StateView | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` |
| ReservesLens | `0x0000001b173C3bbF3984D417d8614E3eed34865B` |
| PoolSwapTest (core test router, NOT msgSender-capable, do not trust) | `0x9b6b46e2c869aa39918db7f52f5557fe577b6eee` |
| PoolModifyLiquidityTest | `0x0c478023803a644c94c4ce1c1e7b9a087e411b0a` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Notes: the unlabeled "Universal Router" row's version is not stated on the docs page; the repo's deploy file names `UniversalRouterV2` = `0x3a9d...` ([sepolia.json](https://github.com/Uniswap/universal-router/blob/f27061204cfe0cee4542fcb0e02db33d5c0c401f/deploy-addresses/sepolia.json)); treating it as v2.0 is an inference. The docs also say Ethereum Sepolia is available in the Uniswap web interface and API ([supported-chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)); the interface only routes pools it recognizes (hook allowlisting is manual and not needed for on-chain `execute` calls) ([hook routing](https://developers.uniswap.org/docs/protocols/v4/concepts/hook-routing)). Do not rely on the Uniswap UI for the demo; call UR directly.

---

## 8. Foundry testing setup

- Docs: "No dedicated testing page"; closest are [Your First Hook](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/your-first-hook) and the [v4-template page](https://developers.uniswap.org/docs/community/tooling/v4-template).
- **v4-template** ([repo @1fbf955](https://github.com/Uniswap/v4-template/tree/1fbf955)): `foundry.toml` (solc 0.8.30, evm_version cancun, ffi on) ([foundry.toml](https://github.com/Uniswap/v4-template/blob/1fbf955/foundry.toml)); `test/utils/BaseTest.sol` -> `deployArtifactsAndLabel()` deploys Permit2, PoolManager, PositionManager, V4 swap router via `hookmate` artifacts on chain 31337, or uses canonical addresses elsewhere (fork mode) ([Deployers.sol](https://github.com/Uniswap/v4-template/blob/1fbf955/test/utils/Deployers.sol)). Works with `forge test` unchanged on a Sepolia fork (`--fork-url`), where `AddressConstants.getPoolManagerAddress(chainid)` is used. Template tests deploy hook with `deployCodeTo` and `poolManager.initialize(poolKey, Constants.SQRT_PRICE_1_1)` ([Counter.t.sol](https://github.com/Uniswap/v4-template/blob/1fbf955/test/Counter.t.sol)).
- **v4-core `Deployers`** (alternative, no hookmate): `v4-core/test/utils/Deployers.sol`, with `PoolSwapTest` (test router: no `msgSender()`, so use only for hooks that do not require it; for VaultHook either write a tiny mock router exposing `IMsgSender` or test through the real UR) ([v4-core test/utils](https://github.com/Uniswap/v4-core/tree/bea7f6d1c11cd5dc4f0d5151ffa37a1c239feee6/test/utils)).
- **Best template: LitePSM tests** in hooks-public: unit test with mocks ([LitePSM unit test](https://github.com/Uniswap/v4-hooks-public/tree/e354058156f8f4f1aff1594a932513e7064956c7/test/aggregator-hooks/LitePSM)), fork test pattern (mine hook, `manager.initialize`, `deal` tokens to PM, swap via test router) ([fork test](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/test/aggregator-hooks/LitePSM/LitePSMAggregator.fork.t.sol)); shared `SafePoolSwapTest` router helper ([shared](https://github.com/Uniswap/v4-hooks-public/tree/e354058156f8f4f1aff1594a932513e7064956c7/test/aggregator-hooks/shared)). Their `foundry.toml` sets `[fuzz] runs = 2048` and invariants `runs=256 depth=32` ([foundry.toml](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/foundry.toml)).
- Security doc asks for invariant/stateful fuzzing for "delta conservation, fee bounds, and balance consistency across full PoolManager flows" ([security framework](https://developers.uniswap.org/docs/protocols/v4/security)). Suggested palmfi invariants [inference]: hook token balances == 0 after every swap; PM balance deltas == vault accounting; `liquidity == 0` always; swaps from untrusted `sender` revert; exact-in and exact-out symmetric.
- Remember `.t.sol` needs the real UR to test the full path: UR repo's Foundry tests show the v4 integration ([UR test/](https://github.com/Uniswap/universal-router/tree/f27061204cfe0cee4542fcb0e02db33d5c0c401f/test)) (not read in depth). Easiest: Sepolia fork test calling UR `0x7E4f...43f3` with a hook deployed via `deployCodeTo`-mined-address on the fork.

---

## 9. Permissioned Pools (brief §9.4) quick confirm

- "Address-level checks": CONFIRMED. The hook calls `adapter.isAllowed(msgSender, permission)` and `allowedWrappers(router)`; flags `SWAP_ALLOWED`/`LIQUIDITY_ALLOWED` only; no amount concept ([PermissionedHooks.sol L137-L172](https://github.com/Uniswap/v4-hooks-public/blob/e354058156f8f4f1aff1594a932513e7064956c7/src/permissioned-pools/PermissionedHooks.sol#L137-L172); [architecture](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/architecture)).
- UR 2.2.0+: CONFIRMED by docs: "Permissioned swap routing requires Universal Router 2.2.0 or higher" ([architecture](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/architecture); [swapping API](https://developers.uniswap.org/docs/trading/swapping-api/swapping-permissioned-pools)). The SDK table lists 2.2.0 ([supported-chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)).
- Sepolia: CONFIRMED available, with its OWN permissioned-build addresses (not the standard UR): PermissionsAdapterFactory `0xE6B0d96919334C33d06266d1420F97f6f434fA2B`, PermissionedPositionManager `0x864C37908Aa5e10b100CaCEe1c62E3954d76f5E1`, PermissionedHooks `0x51247E2291d290d17C08813A175AC86465EdE8c0`, Universal Router `0x5093f1CDED83d99FfEd6602dA6260672ae16787c`, V4Quoter `0x68aF...8244`, MixedRouteQuoterV2 `0xd172b04456774b817f9433517fDE6569bF973422` ([deploy page](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/deploy-a-permissioned-pool)). The standard Sepolia UR (2.1.2) is NOT 2.2.0, so permissioned swaps need that dedicated router; the plain deployments page lists no 2.2.0 on Sepolia ([deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)).
- Extra constraints: requires an adapter token (the pool trades a virtual ERC-6909-backed token; "Primary Technology: ERC6909 Wrapped Token Proxy" ([hooks overview](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks))); adapter must be verified by seeding via factory; swapping is disabled by default until the owner enables it; Uniswap Labs routing needs manual allowlisting "on every network, including mainnet and Sepolia" (not needed for direct on-chain use) ([deploy page](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/deploy-a-permissioned-pool)). Issuer can recall/unwind positions (LPs only) ([architecture](https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks/permissioned-pools/architecture)). Verdict: brief §9.4 rejection stands; keep as stretch.

---

## 10. Security considerations for hooks

From Uniswap's Security Framework ([source](https://developers.uniswap.org/docs/protocols/v4/security)), mapped to VaultHook:
- BeforeSwapDelta/NoOp: "extremely powerful ... can unintentionally introduce value-extraction paths or unbalanced token flows ... tested extensively"; custom curves "must be extremely careful with input/output math and internal accounting". Custom-curve minimum actions: audit incl. a math/invariants specialist; unit tests of intermediate steps and boundaries; stateful fuzz/invariant testing recommended.
- Accounting/token handling: fee-on-transfer, rebasing, ERC-777, pausable/blacklistable tokens "silently break accounting, introduce reentrancy, or cause DoS". Protected token and vault-share semantics fall in "pausable/freezable"; a frozen vault should make the hook revert cleanly (brief §9.1) and never leave a half-settled delta.
- External calls/reentrancy during `beforeSwap`: reentrancy into same pool and other pools of the same hook; "assume every piece of state may change".
- Flash accounting/transient state: ensure deltas cannot be manipulated mid-execution.
- Permission-bit pitfalls (salt grinding) and multi-pool/multi-hop interactions (see sections 3, 6.3).
- Checklist: minimal access control (multisig/immutable), reentrancy protection on all externally reachable paths, CEI, OZ libraries, validate rounding and deltas in every callback, invariant and integration tests, publish audits ([Best practices checklist](https://developers.uniswap.org/docs/protocols/v4/security)). Monitoring/tooling list incl. [Hacken uni-v4-hooks-checker](https://github.com/hknio/uni-v4-hooks-checker) (listed by Uniswap, not reviewed by me).
- Real-world example named by Uniswap: Bunni (custom curve/distribution accounting flaw) ([security framework](https://developers.uniswap.org/docs/protocols/v4/security)).

From CertiK ([Uniswap v4 Hooks: Security Considerations](https://www.certik.com/resources/blog/uniswap-v4-hooks-security-considerations), the post referenced by brief §17):
- Permission bits are fixed at deployment; mismatch makes calls no-ops or revert; `BaseHook` constructor validates.
- Callbacks must be `onlyPoolManager` (else anyone can call `beforeSwap` with a victim's address and pull approved tokens).
- Validate PoolKey in `beforeInitialize`; enforce single-pool use if the hook keeps one `poolKey`.
- Return-delta hooks shift who must settle deltas; wrong accounting favors the operator or one user group.
- Upgradeable hooks + privileged mint/burn roles = rug vector; use immutable or multisig/timelock. Avoid reverts in remove-liquidity paths that trap funds (irrelevant here: no LPs).
- The post does NOT cover router trust, ERC-6909 or custom curves in depth (by its own coverage) ([same post](https://www.certik.com/resources/blog/uniswap-v4-hooks-security-considerations)).

palmfi-specific checklist [inference]:
1. `onlyPoolManager` on every callback (inherit `BaseHook`).
2. Immutable trusted-router set; reject unknown `sender` for swaps, return nothing on failure.
3. Per-`msgSender` instant-budget accounting updated in the same call; revert with "use requestUnwrap" above budget (brief §9.1).
4. Hook holds zero token balance after callback; no approvals left to vault beyond need.
5. Freeze flag read fresh from vault each swap (CRE freezes kill the route the same block).
6. Revert (never partially fill) when output cannot be fully delivered, so `amountToSwap` is always zeroed.
7. Reentrancy guard on `_beforeSwap`; no callback into user-controlled addresses.

---

## Disagreements and gaps

| Item | Docs say | Code says |
|---|---|---|
| HookMiner location | `v4-periphery/src/utils/HookMiner.sol` ([docs](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/hook-deployment)) | removed Feb 2026; now `v4-hooks-public/src/utils/HookMiner.sol` |
| Single swap params | 5-field `ExactInputSingleParams` ([guide](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/swapping)) | 6 fields incl. `minHopPriceX36` from UR 2.1.1 ([IV4Router](https://github.com/Uniswap/v4-periphery/blob/c6e4754dab11bd38c6f08ac51c3c868569e93d64/src/interfaces/IV4Router.sol#L30-L47)) |
| msgSender sample | text says check trusted list | code sample queries any `sender`; `addRouter` has no access control |
| UR "minimum version for v4" | not stated | `V4_SWAP` arrived with the v2.0 line (Aug 2024) |
| Aggregator hook chains | brief says mainnet/Base/Robinhood | no primary source found (UNVERIFIED) |

Other UNVERIFIED: exact periphery commit of deployed Sepolia UR 2.1.2; whether UR 2.1.2 dispatches `MINT_6909/BURN_6909`; whether the `0x4e59...` CREATE2 proxy is on Sepolia; `BaseTokenWrapperHook` as closer template; whether Uniswap Labs would allowlist a protocol-fee-less VaultHook for interface routing.
