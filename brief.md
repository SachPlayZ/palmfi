# palmfi: protected org vaults with brakes, on Arc

> Target chain: **Arc testnet** (chain ID `5042002`, USDC is the gas token). Built for ETHGlobal Mumbai (Nov 5–7, 2026).
> Partners: **Chainlink** (CRE), **Arc** (USDC-native chain), **Uniswap** (v4 Orbital hook). ENS is dropped.
> v1 (Sepolia, ENS, cross-org Member votes, burn-and-mint) is superseded. Cut list in §4.

---

## 1. One-liner

Every organisation (or person) gets a **protected vault**: deposit USDC, receive a personal Protected token, and know that one stolen key, or one hijacked signer, can only move a bounded amount before the **rest of your own team** can say no. The longer a request strays from how that wallet and that vault normally behave, the longer it waits. Orgs pay each other through a single **Orbital pool** of every org's token on Uniswap v4.

**Closing line for judges:** *Your keys can be stolen. Your money can't leave faster than your team can say no.*

---

## 2. The problem

On **October 29, 2026**, roughly **$6.3–6.4B** left Binance hot wallets, most of it in under an hour. The attackers got Binance's **signing infrastructure to sign** for them, after months of lateral movement. One Ethereum transaction carried 50 pre-signed EIP-7702 authorizations to a sweeper. ~$325M of stablecoins were swapped to ETH in ~20 minutes to outrun freezes.

**Lesson:** design for *"the attacker can produce valid signatures"*. A defense inside the same infrastructure as the signer fails with it.

---

## 3. Design principles

1. **Limit what any one valid signature can do right now.** Instant budget; everything above it waits.
2. **Wait in proportion to surprise.** A deterministic CRE score measures how far a request deviates from that wallet's and that vault's history. Delay grows with deviation.
3. **The org's own majority is the brake.** During the delay, >50% of the vault's whitelisted wallets (one wallet, one vote) can veto, or fast-track it. Unless more than half the org's wallets are compromised, an attacker can't get money out above the budget.
4. **Fix in advance where rescued funds go.** Recovery vault set at onboarding; no vote chooses a destination.
5. **One victim's incident is everyone's early warning.** CRE flags push attacker addresses to a shared blocklist (no cross-org votes needed).

---

## 4. Solution overview

| Piece | Job |
|---|---|
| **VaultFactory** | Onboards an Org or Individual. Deploys the vault + Protected token, registers it in the Hub directory (name → vault) and the Orbital pool. |
| **Vault + Protected token** | Holds USDC 1:1; enforces budget, delays, votes, freeze, recovery. Immutable clone. One token per vault (`nUSDC`, `pUSDC`, `aUSDC`). |
| **Hub** | Event router for all vaults; receives CRE reports; holds the **name directory** (first-come names + a `verified` badge the factory owner sets after KYB, no fund powers) and vault status (replaces ENS); shared blocklist. |
| **OrbitalHook (Uniswap v4)** | One N-token Orbital AMM (Paradigm, June 2025) over every org's Protected token, with nested spherical-cap ticks. Each pair `PoolKey` is a facade over the shared reserves. |
| **Chainlink CRE (Sentinel + Reconciler)** | Deviation scoring → delay; FLAG → freeze + blocklist; catch-up, reserves, heartbeat, pool settlement. |
| **Arc** | USDC-native chain: gas in USDC, deterministic sub-second finality, Uniswap v4 + CRE forwarders deployed. |

**Cut from v1:** ENS, TJAR, SafetyFund, cross-org Members + Votes, ETH/WETH, Safe-harbor swaps, Market modes, burn-and-mint Network transfers, ApprovalBook / Payout approvals, Guardian.

---

## 5. Arc specifics (verified onchain 2026-11-06)

| Item | Address |
|---|---|
| RPC | `https://rpc.testnet.arc.network` |
| USDC ERC-20 (6 dec) | `0x3600000000000000000000000000000000000000` |
| Uniswap v4 PoolManager | `0x1d70945634f618eefdf9edaadb59b9a183cef929` (third-party listed; code present, `owner()` responds) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` |
| CRE MockKeystoneForwarder (sim) | `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1` |
| CRE KeystoneForwarder (live) | `0x76c9cf548b4179F8901cda1f8623568b58215E62` |

**Gotchas**
- **USDC is both native gas (18 dec) and an ERC-20 (6 dec) over the same balance.** The Vault holds and accounts USDC **only through the ERC-20 interface**; `receive()`/`msg.value` deposits are rejected. Never sum native and ERC-20 balances.
- **Deterministic finality.** LATEST ≈ FINALIZED; reorg branches in CRE become no-ops (keep the code paths, drop the demo claims).
- **To verify before relying on:** Universal Router address, P-256 precompile (`0x100`), EIP-7702 support, Chainlink Data Feeds. Fallbacks: our own swap router (PoolSwapTest-style); Solidity P-256 verifier library; keep the 7702 check (harmless if unsupported); no feeds needed (USDC-only, $1 by definition).
- **Gas re-estimate.** Sepolia's 5–7× code-storage gas lesson may not hold; measure with `cast estimate --create` on Arc.

---

## 6. Vault rules

### 6.1 Roles

| Role | Can | Cannot |
|---|---|---|
| **Whitelisted wallet** (Voter) | Spend within the Instant budget; create Queued requests; vote veto / fast-track; **freeze alone** | Execute above budget without the delay; change settings alone |
| **Majority** (snapshotted at proposal) | Veto a request (>50% of wallets **other than the requester**); fast-track to the Floor (>50% of all wallets); unfreeze; add/remove wallets; loosen settings; migrate to the Recovery vault | Choose a new destination for rescued funds |
| **Recovery key** (cold, optional) | Unfreeze; migrate to the Recovery vault | Spend |
| **CRE (via Hub)** | Score → set delay within `[Floor, MaxDelay]`; FLAG → freeze + blocklist | Shorten below the Floor; shorten below `CapDelay` above the Hard cap; unfreeze |

- **Minimum 3 whitelisted wallets per vault.** With 2, one hacked wallet blocks every honest veto.
- **One wallet, one vote.** "Higher-ups have a say" = they hold whitelisted wallets like everyone else.
- **Individuals** vote with their own devices: EOA + phone passkey + hardware wallet = 3 voters, same rules.
- **Independence requirement:** the >50% guarantee holds only if voter keys don't share a signer. Wallets behind one MPC/HSM count as one compromise. Onboarding UI warns; demo uses separate keys.

### 6.2 Tokens

- Protected tokens move only between the vault's own whitelisted wallets, into the PoolManager, or out of it to a whitelisted wallet of **that token's** vault (ADR-0006 unchanged).
- Keeps the ERC-20 interface so wallets show balances.

### 6.3 Exit lanes

**Instant lane:** non-blocklisted destination, within the rolling 24h / 7d USD budget. Direct Unwraps and Orbital swap-ins share it. No CRE in the path.

**Queued lane** (anything above budget, including payments into the Orbital pool):
1. `requestUnwrap` / `requestPayment` → `RequestQueued` via Hub. Default delay = `MaxDelay` (CRE silent ⇒ slowest path).
2. Sentinel scores deviation `S` (§7) → report sets `delay = f(S)`, or FLAG.
3. All voters are notified (Telegram/push). During the delay:
   - >50% **NO** of the wallets other than the requester → cancelled.
   - >50% **YES** → executable at the Floor (fast-track; payroll path).
4. After the delay with no veto → executable by anyone.

| Condition | Delay |
|---|---|
| CRE silent | `MaxDelay` (72h) |
| `S < S_flag` | `clamp(Floor · 2^(S/k), Floor, MaxDelay)` |
| amount > Hard cap | `max(f(S), CapDelay)` (24h) unless fast-tracked |
| `S ≥ S_flag`, blocklisted destination, `DELEGATION_CHANGED`, reserves < supply | **FLAG** → freeze |
| >50% YES | Floor (15 min) |

- **Pending cap per wallet** (3) + small bond stops voter-fatigue floods.
- **Why not pure optimistic:** silence lets the attacker win, so the delay must outlast honest response time. Steep `f(S)`, `MaxDelay` when CRE is silent, `CapDelay` above the Hard cap, and FLAG at extreme deviation close that.

### 6.4 Settings

- **Tightening is instant, by any single wallet:** freeze, lower budget, self-remove, remove a destination.
- **Loosening needs >50% YES + 48h timelock:** add a wallet, raise the budget, change the Recovery vault (7d), change the Hard cap.
- **Sybil guard:** adding wallets is the main attack (1 hacked wallet adds 10 puppets). Hence majority + timelock, a voter snapshot at proposal time, and any request while a wallet-add is pending scores `CONFIG_CHANGE_PENDING`.
- The protocol admin has **no path** to any vault's wallets, recovery or funds.

### 6.5 Signer integrity (7702)

Unchanged from v1: the vault refuses callers whose 7702 delegation target isn't approved; the Reconciler flags `DELEGATION_CHANGED`. Inert if Arc lacks 7702.

### 6.6 Invariants (tested)

- USDC leaves a vault only via (a) the instant lane, (b) an executable queued request, (c) migration to the Recovery vault, (d) Orbital settlement of tokens that already passed (a) or (b).
- Reserves ≥ Protected token supply.
- FLAG beats any score; a frozen vault's token can't be swapped in the Orbital pool.
- Voter set used for a decision = snapshot at proposal.

### 6.7 Demo parameters

| Parameter | Value |
|---|---|
| Instant budget | $500/24h, $2,000/7d (Individual); profile-based for orgs |
| Floor | 15 min (demo: 60s) |
| MaxDelay (CRE silent) | 72h |
| CapDelay / Hard cap | 24h / $5k (Individual), $250k (org) |
| `k` (bits per doubling) | 2.5 (routine ≈ 3 bits → ~35 min) |
| `S_flag` | 28 bits (sentinel config `scoring.sFlag`) |
| Pending per wallet | 3 |
| Loosening timelock | 48h; Recovery change 7d |

---

## 7. CRE: deterministic deviation scoring

### 7.1 Ground rules

1. **CRE is never the only key.** It can only lengthen delays above the Floor (and freeze). A compromised workflow can make the Floor apply, but CapDelay and votes still bound it.
2. **Deterministic.** No randomness (DON consensus). "Probability" means a fixed-point likelihood model over onchain data only, with the trigger's block timestamp.
3. **Unsure → slow.** Missing data ⇒ `MaxDelay`, never the Floor.
4. Reports are authenticated (forwarder + workflow ID/owner), bound to `requestHash`, nonce + expiry, single-use; FLAG beats everything (ADR-0005 still applies).

### 7.2 Score (surprisal, in bits)

`S = S_amount + S_dest + S_time + S_velocity + S_flags`, computed at **two scopes** (this wallet, this vault); take the max.

| Term | Model | Bits |
|---|---|---|
| `S_amount` | log-amount vs robust baseline (median / MAD of `ln(amount)`) | `log2(1 + z²)` style, fixed-point |
| `S_dest` | Laplace-smoothed destination frequency `p = (c+1)/(N+K)` | `−log2 p` (first-time ≈ `log2(N+K)`) |
| `S_time` | 24-bucket hour histogram, Laplace-smoothed | `−log2 p(hour)` |
| `S_velocity` | Poisson tail of 1h / 24h count and sum vs rate λ | `−log2 P(X ≥ x)` |
| `S_flags` | `CONFIG_CHANGE_PENDING`, `NEW_WALLET` (whitelisted < 7d) | fixed adds |

- **Baseline lives onchain** in the vault as a 32-entry ring buffer of executed outflows `{wallet, destination, amount, timestamp}` plus per-destination counts. Written **only on executed, un-vetoed outflows**, so a vetoed attack never teaches the model.
- **Robust stats + relative terms:** median / MAD (floor ±√2×) for amount; time and velocity are measured relative to the usual hour / a lone request, so routine payroll scores ≈ 0–3 bits. A few planted outliers can't move a median of 32 (boiling-frog poisoning needs > 16 executed, un-vetoed outflows).
- **Cold start:** the coarse profile set at onboarding (hours, usual max payout, known destinations; ADR-0007) seeds the baseline as pseudo-counts.
- **Explainable:** the report carries the total score + reason bitmap; the per-term bits are recomputed by the same pure function (`cre/shared/deviation.ts`) for notifications and the UI; the UI shows "+9 bits: new destination, +6 bits: 3am".
- **Quota fit:** one batched view returns baseline + request (≤ 15 EVM reads); pure math, no HTTP except notify.

### 7.3 Workflows (ADR-0003: ≤ 3 per CRE org)

| Workflow | Trigger | Job |
|---|---|---|
| **Sentinel** | Hub logs `RequestQueued`, `ConfigChange`, `Outflow` (viaPool) | Score → `SET_DELAY` or `FLAG`; on FLAG: freeze, blocklist, notify all voters |
| **Reconciler** | Cron 1–2 min | Score anything missed; reserves ≥ supply; delegation checks; heartbeat; **Orbital settlement** (§8.4) |

### 7.4 Failure matrix (each row = sim fixture)

| Situation | Result |
|---|---|
| CRE down | Instant lane works; queued requests wait MaxDelay; majority YES still fast-tracks |
| Missed log / dropped execution | Reconciler scores it |
| Replay / modified request | Nonce / requestHash reject (ADR-0005) |
| Compromised CRE sets Floor | Bounded by budget + CapDelay; voters still veto |
| Baseline poisoning | Learn-on-executed-only + drift cap |
| Voter fatigue flood | Pending cap + bond |
| Sybil wallet add | Majority + 48h + snapshot + `CONFIG_CHANGE_PENDING` |
| Attacker freezes (grief) | Majority or Recovery key unfreezes |
| >50% wallets compromised | **Out of scope; stated residual risk** |

---

## 8. Uniswap: the Orbital pool

### 8.1 Why Orbital

Every Protected token is 1:1 USDC-backed, so all trade near $1, the case Orbital is built for. Its **nested ticks** isolate LPs from a token that **depegs**. Here a token "depegs" when its vault freezes (redemption stops). Orbital's tick boundary behaviour is exactly the contagion limiter v1 got from burn-and-mint (ADR-0001), while giving one pool, one route, and Uniswap composability.

### 8.2 Math (per Paradigm "Orbital", Robinson / Moallemi / White, June 2025)

- Reserves `x ∈ ℝⁿ`, sphere invariant `‖r·1 − x‖² = r²`; equal-price point `x_i = r(1 − 1/√n)`.
- **Ticks** = spherical caps `x · v ≤ k` (v = (1,…,1)/√n), nested; interior ticks share one sphere, boundary ticks pinned to their plane. Consolidated as a torus: interior sphere ⊕ boundary circle.
- Trade solve: fix in/out amounts on 2 coordinates, solve the consolidated invariant (Newton, fixed-point, ≤ 8 iterations onchain), check for tick crossings, cross and re-solve.
- Fixed-point via `PRBMath`/`FixedPointMathLib` sqrt; fuzz vs a Python reference.

### 8.3 Hook shape

- Singleton `OrbitalHook` holds all N reserves (in PoolManager as ERC-6909 claims). Each pair `PoolKey(tokenA, tokenB, hook)` is initialized by the factory only (`beforeInitialize` pin); `beforeAddLiquidity` reverts (LP goes through the hook's own `addLiquidity(tick, amounts)`).
- `beforeSwap` + `beforeSwapReturnDelta`: NoOp custom curve (LitePSM pattern; docs/research/uniswap-v4.md).
- **Payer controls on swap-in:** the hook calls the payer's vault `chargeOutflow(user, amount)`. Within budget it passes; above it reverts "use `requestPayment`", which queues and later executes the swap from the vault.
- Read the real user via `msgSender()` only from trusted routers.
- Any swap touching a **frozen** vault's token reverts.
- Swap output goes only to a whitelisted wallet of the output token's vault (token-level check, ADR-0006).

### 8.4 Liquidity and settlement

- **Each org LPs its own token** (from its own vault, counts as no outflow: value stays its own) into a tick of its choice.
- After Palantir pays Nvidia, the pool holds extra `pUSDC` that only Palantir can redeem. Outsiders can't arbitrage closed-loop tokens.
- **Settlement:** the Reconciler (or anyone) calls `settle(token)`. The hook redeems excess foreign inventory from the issuing vault (`pUSDC` → USDC, a **pre-authorized** outflow already charged at swap-in) and deposits it into the under-supplied token's vault, minting that token back into the pool. Net effect = deferred burn-and-mint, and pool reserves return toward balance.
- **LP withdrawal settles first:** an org's LP exit triggers settlement of the foreign inventory backing its share, then returns **only its own token** to its vault. Nobody ever holds another org's token.
- **Frozen issuer halts settlement** of its token (frozen = depeg); that slice waits for unfreeze or migration.
- **Contagion window:** between swap and settlement, LPs hold foreign tokens. If the issuer freezes first, that token sits at its tick boundary. Exposure is bounded by tick choice; settlement every Reconciler pass keeps it small.

### 8.5 Gotchas

- v4 pools are 2-token; Orbital is N-token, hence facades + shared reserves.
- `beforeInitialize` pin, HookMiner address bits, trusted-router `msgSender()`, ERC-6909 leak handled by the token-level whitelist.
- **Attacker-org exit:** anyone can onboard `evilcorp`; a hacked Palantir wallet swapping `pUSDC → eUSDC` is charged to Palantir's budget/queue like an Unwrap, so no bypass.
- Universal Router on Arc unverified, so ship our own minimal router as fallback.
- Full tick math is the riskiest build item. Fallback ladder: (1) ticks; (2) single sphere, no ticks; (3) 1:1 constant-sum. Each passes the same hook interface.

---

## 9. User flows

### 9.1 Nvidia (org, 5 wallets: CFO, controller, 3 treasury engineers)
1. **Onboard:** one factory tx; name `nvidia` in the Hub directory; 5 voters; recovery vault; coarse profile as prior.
2. **Fund:** deposit USDC → `nUSDC`; LP 40% into the Orbital pool.
3. **Get paid:** Palantir pays `nvidia` by name: `pUSDC → nUSDC` via the Orbital pool, out to Nvidia's wallet. Reconciler settles inventory.
4. **Payroll $2M:** queued; S = 5 bits (usual day/size/dest) → ~1h delay; CFO + controller + 1 engineer vote YES → executes at the Floor.
5. **Engineer's key hacked:** attacker requests $3M to a fresh address at 3am. S = 27 bits → **FLAG**, freeze, blocklist, all voters pinged. If they try $400k instead: S = 18 bits → 2^9 × Floor ≈ 5 days (clamped 72h); 4 honest wallets vote NO → cancelled. The attacker tries to add 3 wallets → needs 3/5 YES + 48h; rejected. Majority removes the hacked wallet, adds a new one.
6. **Small drips:** bounded by the instant budget.

### 9.2 Alice (Individual: EOA + passkey + Ledger)
- $8k to a new exchange: S = 12 bits → ~16h; she fast-tracks with passkey + Ledger (2/3) → Floor.
- Laptop malware takes the EOA: attacker = 1/3 voters; can't veto Alice, can't fast-track; worst case one day's budget.

---

## 10. Threat model

| Threat | Defense | Residual |
|---|---|---|
| 1 wallet key stolen | Budget + deviation delay + majority veto | ≤ instant budget |
| Signing infra compromise (all wallets) | Independent-key requirement; deviation FLAG | If >50% share a signer: loss above budget possible |
| Sybil wallet adds | Majority + timelock + snapshot | None if majority honest |
| Baseline poisoning | Learn-on-executed + drift cap | Slow, visible |
| Silent voters | Steep delay, MaxDelay default, CapDelay, notifications | Delay length vs responsiveness |
| CRE compromise | Can't go below Floor / CapDelay; can't unfreeze | Bounded |
| Orbital contagion | Ticks + frequent settlement + frozen-token swap halt | LP's chosen tick exposure |
| Attacker org as exit | Swap-in charged to payer rules | None |
| USDC dual interface | ERC-20-only accounting | None |
| Admin compromise | No admin path; immutable | New onboarding only |

---

## 11. Hackathon plan

### 11.1 Prize targets
| Partner | Show |
|---|---|
| **Uniswap** | Orbital N-token hook with ticks on v4; payments by name through one pool; `FEEDBACK.md` |
| **Chainlink CRE** | Deterministic deviation scoring, delay-setting reports, FLAG incident response, failure-matrix sims (`cre workflow simulate --limits default`) |
| **Arc** | USDC-native org treasury vaults on Arc testnet, USDC gas, dual-interface handled |

**Arc bounties (two tracks; name the one we submit for):**
- *DeFi / onchain finance on Arc* (payments + liquidity infra): Orbital pool + protected treasuries.
- *Advanced programmable logic with USDC* (treasury management, programmable payroll, conditional flows): deviation-delayed payouts, majority veto/fast-track, multi-step settlement. **Primary pick.**
- **Hard requirements:**
  - **Built in Arc Studio**: shareable Studio project URL; show Studio in the demo. Drive it from Claude Code via `@circle-fin/arc-studio-cli` (`arc-studio agent-guide`). Import the repo through Studio's "From GitHub" and deploy/trace from Studio.
  - Working frontend + backend.
  - **Architecture diagram**.
  - Video + docs on how we used Arc Studio and Circle dev tools.
  - Repo link.

### 11.2 Scope
**Must:** Arc redeploy; votes (veto / fast-track / freeze / wallet changes); delay-from-score in Vault + Hub; Sentinel scoring v2; Hub name directory; OrbitalHook (ladder §8.5); web: votes + pay by name via pool.
**Should:** Orbital ticks; settlement in the Reconciler; Individuals with passkey voter.
**Stretch:** UR integration on Arc; 7702 on Arc; CCTP lifeboat.

### 11.3 Demo (~4 min)
1. Onboard Nvidia (5 wallets) + Palantir + Alice on Arc.
2. Palantir pays `nvidia` via the Orbital pool; show reserves + settlement.
3. Payroll fast-tracked by majority.
4. Hacked engineer: 3am $3M → FLAG/freeze; $400k → long delay → 4 NO → cancelled; Sybil add blocked.
5. Frozen Palantir: its token halts in the pool; Nvidia's LP exposure bounded by its tick.
6. CRE sim suite passing.
