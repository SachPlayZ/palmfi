# palmfi — protected vaults: wrapped assets with brakes

> ENS parent name: `palmfi.eth`.
> Target chain: **Ethereum Sepolia**. Built for ETHGlobal Mumbai (Nov 5–7, 2026).

---

## 1. One-liner

A factory that gives every company and every individual a **protected vault**: deposit USDC, ETH or another listed asset, receive a personal wrapped token, and know that a stolen key or a hijacked signing system can only move what you'd tolerate losing on a bad day. Member institutions settle with each other inside the network, share attack signals, and back each other up. Every vault is reachable from any Uniswap route and named in ENS.

**Closing line for judges:** *Your keys can be stolen. Your money can't leave faster than you can say no.*

---

## 2. The problem

On **October 29, 2026**, roughly **$6.3–6.4B** left Binance hot wallets across about ten chains, most of it in under an hour.

- Binance says there is no evidence its private keys leaked. The attackers got Binance's **signing infrastructure to sign** for them.
- The entry path took months:
  - a trojanized Homebrew installer in June
  - malware delivered through a fake job interview in September
  - lateral movement through internal AI tools into the system that authorizes wallet transactions
- On Ethereum, a transaction carried **50 pre-signed EIP-7702 authorizations** pointing a hot wallet at an attacker sweeper contract. One was accepted, and the wallet was emptied of 64 tokens (~$2.5B) **in a single transaction**.
- The attacker swapped ~$325M of stablecoins into ETH within ~20 minutes to outrun Tether and Circle freezes.

**Lesson:** the threat to design for is *"the attacker can produce valid signatures,"* not just *"the attacker has the key."* Any defense that lives in the same infrastructure as the signer fails with it. Protection has to sit where a valid signature cannot override it.

---

## 3. Where the idea started and how it evolved

**Original idea (iUSDC):** wrap USDC into a personalized ERC-20. Only whitelisted addresses can unwrap it, so stolen tokens moved to another wallet are useless.

**Gap:** a thief with the key, or with control of the signer, doesn't move the token. They unwrap it directly from the whitelisted wallet.

**Design principles that close the gap:**

1. **Limit what any valid signature can do *right now*:** budgets, queues, timelocks.
2. **Give an independent party time to say no:** CRE scoring, a veto-only guardian, the owner's second factor.
3. **Fix in advance where rescued funds go:** a recovery vault set at onboarding, so no one (not even voters) can redirect funds during an incident.
4. **Turn one victim's incident into everyone's early warning:** a shared blocklist across the network.

---

## 4. Solution overview

| Piece | Job |
|---|---|
| **VaultFactory** | Onboards a user or verified company. Deploys their vault, token(s), Uniswap pool and ENS name in one transaction. |
| **Vault + protected token(s)** | Holds the underlying asset 1:1 and enforces every spending rule. Immutable. One token per asset per vault (e.g. Nvidia's `nUSDC`, Alice's `vETH` / `vUSDC`). |
| **Hub** | Single contract every vault routes its events through, so CRE watches one address. Also exposes batched views for the Reconciler. |
| **NetworkRegistry** | Member institutions, shared blocklist of attacker addresses, votes. |
| **Uniswap v4 VaultHook** | Exposes each vault as a 1:1 underlying ⇄ protected-token pool, so any Uniswap route can pay into or out of it under the same rules. |
| **PaymentRouter** | "Pay with any token" helper. Takes protocol fees and composes Universal Router routes. |
| **TJAR Token Jar + Releaser** | Collects protocol fees in any token. Searchers convert them to USDC, which goes to the Safety Fund. |
| **SafetyFund** | Shared USDC backstop. Reimburses false-positive freeze costs and covers losses. Payouts by member vote. |
| **ENSv2 subname registry** (`palmfi.eth`) | Factory-issued, non-transferable names pointing at verified vaults, with a live `status` record. |
| **Chainlink Data Feeds** | Dollar-denominated budgets, minimum outputs for safe-harbor swaps, per-asset market modes. |
| **Chainlink CRE (5 workflows)** | The security brain: score, approve, freeze, reconcile, respond. |
| **Passkeys (P-256 precompile, EIP-7951)** | Second factor for individuals, verified onchain. |

---

## 5. Architecture

### 5.1 Onchain (Ethereum Sepolia)

- **VaultFactory**
  - Deploys vaults as immutable clones (EIP-1167). Each user gets their own vault, which limits the blast radius of any bug.
  - Registers the vault in the Hub and NetworkRegistry.
  - Initializes the vault's Uniswap v4 pool with the VaultHook.
  - Mints the ENS subname.
  - Has **no path** to edit any vault's whitelist, recovery address or funds.
- **Vault**
  - Holds assets.
  - Mints and burns the protected tokens.
  - Enforces roles, the two exit lanes, timelocks, the delegation check, second factors and invariants (section 6).
  - Implements the CRE consumer interface via the Hub (section 8.4).
- **Hub**
  - Event router for all vaults: `UnwrapRequested`, `ConfigChangeRequested`, `HookSwap`, `SafeHarborSwap`, `Flagged`, `Frozen`, `Migrated`, `Heartbeat`.
  - Receives CRE reports (KeystoneForwarder → `onReport`) and dispatches verdicts to vaults.
  - Holds the ENS role that edits **only** `status` text records.
- **NetworkRegistry**
  - Membership (verified institutions only).
  - Blocklist entries with expiry.
  - Votes: extend freeze, migrate to pre-committed recovery, rotate the trusted CRE workflow ID (timelocked).
- **VaultHook (Uniswap v4)**
  - Custom-curve 1:1 hook modeled on Uniswap Labs' LitePSM aggregator hook (USDC ⇄ USDS).
  - Calls into the vault's own wrap/unwrap logic, so there is one policy engine.
- **PaymentRouter**
  - Builds Universal Router routes (any token → USDC → protected token of the payee).
  - Takes the protocol fee in the input token and sends it to the Token Jar.
- **TJAR**
  - Token Jar + Releaser deployed from the open-source `Uniswap/tjar` repo onto Sepolia.
  - The threshold is in USDC; the recipient is the SafetyFund.
- **SafetyFund**
  - USDC treasury; payouts by member vote.
- **ENSv2**
  - Factory-run subname registry under `palmfi.eth`.
  - Permissioned resolver with Enhanced Access Control.

### 5.2 Offchain

- **CRE workflows:** Sentinel, Reconciler, Market watcher, Approvals inbox, Incident responder (section 8).
- **Notification service:** push, Telegram or email. CRE calls it over HTTP.
- **Company approval system:** a mock API for the demo. Returns an approver signature over a request hash when a matching approved payout exists.
- **Frontend:** two personas (individual, institution); name-based payments; passkey prompts; incident view.

---

## 6. Vault rules

### 6.1 Roles

| Role | Can | Cannot |
|---|---|---|
| **Whitelisted hot wallets** | Spend within the instant budget; create queued requests; run safe-harbor swaps | Change recovery, guardian or limits without a timelock |
| **Guardian** (veto-only) | Cancel a pending request; pause; evacuate everything to the recovery vault | Send funds anywhere else; unfreeze |
| **Recovery** (cold) | Unfreeze; migrate funds to a fresh vault; approve requests during a CRE outage (institutions) | — (changing the recovery address itself takes a 7-day timelock) |
| **Second factor** | Individual: phone passkey. Institution: approver keys from the approval system. Confirms large requests. | Spend on its own |
| **CRE (via Hub)** | Freeze instantly; issue CLEAR / HOLD / FLAG; set market modes | Shorten a delay below the floor; clear above the hard cap without the owner's second factor; unfreeze |

A compromised guardian can only cause griefing: funds move to the owner's own recovery vault. CRE is **never the only key**.

### 6.2 Tokens and transfers

- Protected tokens move **only between whitelisted wallets of the same owner**. A transfer to any other address reverts. This kills the "rotate tokens out of the hacked EOA" scenario completely.
- **Paying another member:** a network transfer **burns the payer's token and mints the payee's token**, moving the backing between vaults in the same transaction.
  - Each company only ever holds its own token.
  - An incident at Palantir can never freeze Nvidia's receivables.
- Protected tokens keep the ERC-20 interface so wallets display balances.

### 6.3 Exit lanes

**Instant lane**
- Any non-blocklisted destination.
- Must fit inside the rolling **24h and 7d USD budgets**.
- Direct unwraps and Uniswap hook swaps **share the same budget**.
- **No CRE in the path**, so small spending works even if Chainlink is down.

**Queued lane**
- Above budget: `requestUnwrap` → CRE verdict → execute or freeze.
- Destinations not on the owner's allowlist score `NEW_DESTINATION`.
- Adding a destination to the allowlist takes **48h**; removing one is instant.

Resolution of a queued request:

| CRE verdict | Owner second factor | Executable |
|---|---|---|
| FLAG | any | Never. The vault freezes and the request is cancelled. |
| CLEAR, amount ≤ hard cap | not needed | After the **floor** (15 min) |
| CLEAR, amount > hard cap | present | After the floor |
| CLEAR, amount > hard cap | missing | After the full delay (24h) |
| HOLD | present | After the full delay, or after the floor once the Sentinel re-scores to CLEAR with the confirmation as input |
| HOLD | missing | Never (the request expires) |
| None (CRE silent) | — | **Individual:** after the fail-open delay (72h) unless the guardian cancels. **Institution:** only with approver + recovery signatures (fail closed). |

**Recovery migration**
- The recovery key (or a member vote, for institutions that can't act) moves everything to the **pre-committed recovery vault**.
- The factory deploys a fresh vault and re-points the ENS name.

### 6.4 Config changes are asymmetric

- **Tightening** takes effect instantly: lower budget, longer delay, remove a destination, pause, add a blocklist entry.
- **Loosening** is timelocked: raise budget (48h), add destination (48h), change guardian or recovery (7 days), change approver keys (7 days).
- Without this, an attacker's first move is setting the delay to zero.
- **Any withdrawal request while a loosening change is pending is flagged.**
- Only the owner's cold key can edit the whitelist. The protocol admin has **no path** to any vault's whitelist, recovery or funds.

### 6.5 Signer integrity (the Binance vector)

- When a delegated EOA calls the vault, the vault reads the caller's code. Under EIP-7702 this is a delegation designator (`0xef0100` + target).
- If the delegation target is **not on an approved-delegate list**, the call is refused. Known smart-account delegators such as MetaMask's stay on the approved list.
- The Reconciler also polls each hot wallet's delegation state through a vault view and raises `DELEGATION_CHANGED`.

### 6.6 Second factors

- **Individuals:** a phone passkey (P-256 / WebAuthn) signs the request hash. The vault verifies it onchain with the **P256VERIFY precompile at `0x100` (EIP-7951, live since Fusaka)**. Laptop malware that steals the EOA key cannot produce this signature.
- **Institutions:** the company's approval system returns an approver signature (ECDSA) over the request hash. The vault checks it against approver keys registered at onboarding.
  - **Approver keys must live on infrastructure separate from the hot wallets.** Otherwise a Binance-style compromise owns both.

### 6.7 Invariants (tested)

- The underlying asset leaves a vault only through:
  - (a) the instant lane within budget
  - (b) an executable queued request
  - (c) migration to the pre-committed recovery vault
- Reserves ≥ total supply of protected tokens, per asset.
- A FLAG always beats a CLEAR. Once frozen, only recovery or a vote unfreezes.

### 6.8 Suggested demo parameters

| Parameter | Individual | Institution |
|---|---|---|
| Instant budget | $500 per rolling 24h; $2,000 per 7d | From profile (e.g. 2× typical daily outflow) |
| Full queue delay | 24h | 24h |
| CLEAR floor | 15 min | 15 min |
| Hard cap (above this a CLEAR also needs the second factor) | $5,000 | From profile (e.g. $250k) |
| Destination allowlist addition | 48h | 48h |
| Guardian / recovery / approver change | 7 days | 7 days |
| Max pending requests | 3 | 10 |
| Request bond | Small, refunded on execution or cancel | Same |
| If CRE is down | Fail open after 72h unless guardian cancels | Fail closed (approvers + recovery) |
| Safe-harbor slippage cap | 2% normal; up to 5% in volatile mode (hard max) | Same |

---

## 7. Pricing and volatile assets (Chainlink Data Feeds)

- **Dollar-denominated limits.** Budgets, hard caps and velocity are measured in USD using Chainlink Data Feeds read onchain. "$500 a day" stays $500 whether ETH is at $1,800 or $4,000.
- **Feed hygiene (non-negotiable):**
  - Check `updatedAt` against **each feed's own heartbeat**. Feeds differ, and a single global timeout accepts stale prices.
  - Read `decimals()` from the feed; never hard-code it.
  - List only assets that have a Sepolia feed.
  - For stablecoins, use their own feed where one exists instead of assuming $1.
  - The vault enforces staleness itself, independent of CRE.
- **Safe-harbor swaps.** In a crash, owners must be able to de-risk instantly.
  - Swaps from a volatile asset into an allowlisted stablecoin **stay inside the vault**, run through Uniswap, and don't use the budget.
  - **Abuse guard:** an attacker with the key could otherwise dump the vault's ETH into a rigged pool. So:
    - the swap is allowed only into allowlisted assets, through allowlisted pool keys
    - output must be ≥ oracle value × (1 − slippage cap)
  - Maximum extractable value is the slippage cap.
- **Market mode per asset** (set onchain by the CRE Market watcher; the vault's own staleness check also forces degraded mode):
  - **Normal:** everything works as usual.
  - **Volatile:** the safe-harbor slippage cap widens, within a hard maximum.
  - **Degraded:** the feed is stale, or Chainlink and the Uniswap pool price deviate beyond a threshold.
    - Safe-harbor swaps pause for that asset.
    - Its instant budget drops to zero; only stablecoin budgets keep working.
    - Queued requests on it HOLD.
- **Roadmap: Data Streams.** Pull-based, sub-second prices for fast-moving assets. Currently early access, with testnet guides on Arbitrum Sepolia. On Ethereum Sepolia we build on Data Feeds and present Streams as the production upgrade.

---

## 8. Chainlink CRE: the security brain

### 8.1 Ground rules

1. **CRE is never the only key.**
   - It can freeze instantly.
   - Its CLEAR only shortens a delay to the floor, never to zero.
   - Above the hard cap, a CLEAR also needs the owner's second factor.
   - A compromised or buggy workflow can cause delays, not theft.
2. **When unsure, HOLD.** Timeouts, stale prices and missing data never produce CLEAR.
3. **Fast to freeze, careful to release.**
   - Log triggers listen at `LATEST` so flags land within seconds; a reorged flag only costs a delay.
   - Before writing a CLEAR, re-read the request at `FINALIZED`.
   - (Log triggers support LATEST / SAFE / FINALIZED; chain reads support LATEST / FINALIZED. On Sepolia, FINALIZED maps to the native finalized tag.)
4. **The instant lane never depends on CRE.**
5. **Reports are authenticated, bound and single-use** (section 8.4).
6. **Deterministic and explainable.** The same inputs always produce the same verdict, with onchain reason codes. Use block timestamps from the trigger, not node clocks. Aggregate HTTP results via consensus.

### 8.2 Workflows (split by job)

CRE caps a workflow at **10 triggers, 5 concurrent executions, a 5-minute execution timeout, 15 EVM reads and 5 HTTP calls per execution**. Executions over quota are queued and retried for up to 10 minutes, then dropped. Splitting by job keeps one flood from starving everything else.

| Workflow | Trigger | Job |
|---|---|---|
| **Sentinel** | Hub log events at `LATEST` | Scores `UnwrapRequested`, `ConfigChangeRequested`, `HookSwap`, `SafeHarborSwap` → CLEAR / HOLD / FLAG |
| **Reconciler** | Cron, every 1–2 min (cron minimum is 30s) | Decides anything still pending (missed logs, dropped executions); checks reserves ≥ supply; checks hot-wallet delegation state; writes a heartbeat. Uses **batched views** so one read returns many requests; processes the largest USD amounts first. |
| **Market watcher** | Cron | Checks feed freshness and Chainlink-vs-Uniswap deviation (pool price read) → writes per-asset market mode |
| **Approvals inbox** | HTTP trigger (callers must sign with authorized EVM keys) | Receives company approval-system confirmations → feeds the Sentinel / writes CLEAR with the approver signature |
| **Incident responder** | `Flagged` events | Freezes; flips the ENS `status`; pushes attacker addresses to the NetworkRegistry blocklist; notifies the owner and members; opens a vote for institutions |

- **Secrets:** company profiles and approval-system API keys live in the **Vault DON**.
- **Confidential HTTP:** calls to company systems use Confidential HTTP, so secrets are injected inside a secure enclave and responses can be encrypted.
- **Privacy:** only coarse caps go onchain. Detailed profiles never do.

### 8.3 Decision engine

**Inputs**
- Amount in USD (oracle).
- Destination: allowlisted / first-time / blocklisted / contract.
- 1h / 24h / 7d velocity vs declared profile or learned baseline.
- Time of day vs profile hours.
- Signer delegation state.
- Pending loosening config change.
- Market mode of the asset.
- Owner second factor or approver signature present.
- Approved-payout match (institutions, via the approval system).

**Verdicts**

| Verdict | Typical triggers | Effect |
|---|---|---|
| **FLAG** | Blocklisted destination; `DELEGATION_CHANGED` to an unknown target; withdrawal while recovery or whitelist change pending; reserves < supply | Freeze + incident |
| **HOLD** | New destination + large amount; velocity spike; off-hours; no approved-payout match; missing or stale data; approval API timeout | Full delay + owner second factor required |
| **CLEAR** | In-profile, known destination, data fresh, confirmation present where required | Delay shortened to the floor |

**Reason codes (onchain bitmap):** `NEW_DESTINATION`, `OVER_BUDGET`, `VELOCITY_1H`, `VELOCITY_24H`, `VELOCITY_7D`, `OFF_HOURS`, `NO_APPROVED_PAYOUT`, `DELEGATION_CHANGED`, `CONFIG_CHANGE_PENDING`, `BLOCKLISTED_DEST`, `ORACLE_STALE`, `PRICE_DEVIATION`, `API_UNAVAILABLE`, `RESERVE_MISMATCH`.

### 8.4 Report format and authenticity

- Reports arrive via the **KeystoneForwarder → `onReport(metadata, report)`** on the Hub. The Hub uses the ReceiverTemplate pattern:
  - checks the caller is the forwarder
  - checks **workflow ID, name and owner** from the metadata
- Payload (abi-encoded):
  `reportType, vault, requestId, requestHash, verdict, reasonCodes, approverSig/passkeySig (optional), expiry, nonce`
- **`requestHash` binds the exact parameters** (amount, asset, destination). A CLEAR can't be applied to a modified request.
- **Nonce + expiry** make reports single-use.
- A **FLAG beats a CLEAR**, regardless of arrival order.
- A write reply means the report was *included*, not finalized. The Reconciler re-sends if state doesn't reflect it.
- Rotating the trusted workflow ID requires a timelock + member vote.

### 8.5 Failure matrix

| Situation | What happens |
|---|---|
| Missed log / dropped execution | The Reconciler picks it up on the next pass. |
| Reorg removes the event | The log arrives with `removed=true`. A CLEAR bound to that request hash fails harmlessly. |
| Duplicate or replayed report | Rejected by request ID + nonce + expiry. |
| Request modified after CLEAR | Rejected: hash mismatch. |
| CLEAR after FLAG | Ignored. Only recovery or a vote unfreezes. |
| CRE fully down | The heartbeat goes stale. The instant lane keeps working. Queued requests: institutions fail closed, individuals fail open after 72h unless the guardian cancels. |
| Oracle stale or deviating | The asset enters degraded mode; requests on it HOLD. |
| Company API timeout / error | HOLD + retry. CRE's HTTP caching is best effort, so the destination API must be **idempotent** (idempotency key = request hash). |
| Request flood to bury a large request | Pending-request cap + bond per request; the Reconciler handles the largest USD amounts first. |
| Low-and-slow drain | Rolling 24h / 7d USD caps onchain; the Sentinel tracks the cumulative total. |
| Config attack (add destination, change recovery) | Timelocked; the owner is alerted on every channel; any withdrawal while it's pending is flagged. |
| 7702 sweeper delegation | The vault refuses the call; the Reconciler flags `DELEGATION_CHANGED`. |
| Price crash | Safe-harbor swaps to stablecoins stay instant with oracle-enforced minimum output. |
| Workflow bug or compromise | Bounded powers (freeze, floor, hard cap); workflow ID pinned; rotation needs timelock + vote. |
| Gas spike / failed write | The Reconciler re-sends; reports carry an expiry. |
| False-positive freeze | The owner unfreezes with recovery (+ passkey for individuals). The SafetyFund can reimburse costs by vote. |

### 8.6 Proving it

- Every row of the failure matrix is a **CRE CLI simulation fixture** with an expected verdict.
- Run the suite with `cre workflow simulate --limits default`, which applies production quotas locally.
- Show it passing in the demo.

---

## 9. Uniswap integration

### 9.1 VaultHook: every vault is a Uniswap pool

- Aggregator hooks wrap an outside liquidity source so that any router sees it as a v4 pool. Our vault is exactly such a source: a 1:1 conversion with no LPs, where the vault is the liquidity.
- **Wrap (underlying → protected):** allowed only if the recipient is a whitelisted wallet of that vault.
- **Unwrap (protected → underlying):** uses the **same instant budget** as a direct unwrap.
  - Above budget, the swap reverts with "use `requestUnwrap`"; swaps can't wait for CRE.
  - A frozen vault reverts.
  - Degraded market mode reverts for that asset.
- **Payoff:**
  - Any Uniswap route can end inside a vault.
  - The freeze propagates: when CRE flags a vault, its Uniswap route dies in the same block.

### 9.2 Universal Router flows

- **Pay with any token:** e.g. UNI → USDC (regular v4 pool) → `vUSDC` (VaultHook). The PaymentRouter takes the fee in UNI → Token Jar.
- **Pay an outside vendor:** `nUSDC` → USDC (VaultHook, within budget) → ETH (regular pool) → vendor.
- **Safe-harbor swaps:** the vault itself swaps through allowlisted pool keys with recipient = vault, under the oracle minimum output (section 7).

### 9.3 Aggregator hooks (as users)

- Uniswap's own aggregator hooks are live only on **Ethereum mainnet, Base and Robinhood Chain**, through the Uniswap web app and API.
- On Sepolia, the "any token" leg uses a normal v4 pool. The same route would include aggregator hooks on mainnet.
- To show real aggregator routing, demo that leg on a mainnet fork.

### 9.4 Alternative considered: Uniswap Permissioned Pools

- Shared hook + Permissions Adapter, live on mainnet and Sepolia. The issuer plugs in its own allowlist checker; ours would be "whitelisted and vault not frozen".
- It supports pools where both tokens are permissioned by different issuers.
- **Rejected for the core** because its checks are **address-level, not amount-level**. A pool would become an exit path that skips the budget unless pool liquidity is capped at the budget.
- Also requires Universal Router 2.2.0+.
- Kept as a stretch option for company-to-company FX pairs.

---

## 10. TJAR and the SafetyFund

- **How TJAR works:**
  - A Token Jar accumulates any assets.
  - A Releaser lets anyone pay a fixed **threshold** of a chosen token (USDC) to a chosen recipient and, in exchange, receive the jar's contents.
  - It is a posted-price mechanism: no oracle adjusts the threshold; only the operator can change it.
- **Our use:**
  - Protocol fees go into one jar: PaymentRouter fees in whatever token payers used, plus onboarding fees.
  - The threshold is in USDC; the recipient is the **SafetyFund**.
  - "A hack affects everyone" becomes "everyone funds the backstop."
- **Variant (stretch):** a per-company receivables jar, with the company's vault as the recipient. Searchers keep the spread, which is fine for small fees and costly for large receivables.
- **Gotchas:**
  - TJAR is officially live on Ethereum, Optimism, BNB Chain, Polygon, Base, Arbitrum and Robinhood Chain, **not Sepolia**. Deploy it from the open-source `Uniswap/tjar` repo. In the demo, our own script acts as the searcher.
  - The Releaser owner / config setter can change the payout token, threshold and **destination**. That is one more privileged key: **lock the terms permanently** or give the role to a cold multisig.

---

## 11. ENSv2: identity and live status

- **Same chain:** ENSv2 runs on Ethereum mainnet and **Sepolia**, the same chain as our contracts. Naming happens atomically in the factory's deploy transaction, and contracts and apps can read names directly.
- **Factory-run registry:** the **factory runs its own subname registry** under `palmfi.eth` (we own our parent; we do not own `usdc.eth`). Only factory-deployed vaults get names.
- **Subnames:** non-transferable and revocable (e.g. on fraud).
  - Institutions: `nvidia.palmfi.eth`, with `verified=true` only after business verification.
  - Individuals: `alice.palmfi.eth`, with `type=personal`.
- **Records:**
  - `addr` → vault
  - text records: `type`, `verified`, `status` (`active` / `frozen` / `migrated`), `tokens`
  - profile fields the owner can edit (url, avatar)
- **Enhanced Access Control:** the Hub may edit **only** `status`; owners edit only their own profile fields; nobody but the factory sets `verified`.
- **Live status:** when CRE flags a vault, the Incident responder flips `status=frozen`. Any app resolving the name sees it, and the PaymentRouter refuses to pay a name that isn't `active`.
- **Gotcha:** names stop impersonation **only because the factory verifies businesses before issuing a verified name**. A fake "Nvidia USDC" can exist elsewhere, but it can never resolve from this name.
- **Prize requirement:** functional demo, no hard-coded values, live demo link, open-source code.

---

## 12. The network layer

- **Members:** verified institutions only (Sybil resistance). Individuals are protected users, not voters.
- **Shared blocklist:**
  - When any vault is flagged, the attacker's addresses are added with an expiry.
  - **Every vault refuses them as destinations.**
  - Members can vote to remove false entries.
- **Votes are the backstop, never the brake.**
  - The automatic freeze happens without any vote; hacks move in minutes.
  - Votes can only:
    - (a) extend a freeze
    - (b) migrate funds to the affected member's **pre-committed** recovery vault
    - (c) rotate the trusted CRE workflow ID (timelocked)
  - Votes **never choose a destination**, so colluding or compromised members can't "recover" funds into their own contract.
  - The affected company's own recovery key can unfreeze or migrate without a vote. The vote is for when it can't act.
- **The CFO pitch:** other members can delay your money or send it home, but never take it.

---

## 13. User flows

### 13.1 Individual: Alice (normal MetaMask EOA)

**1. Onboarding (one transaction)**
- Alice connects her EOA. Nothing about her wallet changes.
- She sets up:
  - name `alice.palmfi.eth`
  - recovery = her hardware wallet
  - a phone passkey (Face ID)
  - guardian = our watcher (+ optional friend)
  - the default budget ($500/day)
- The factory:
  - deploys her vault clone
  - stores her passkey public key and recovery address
  - registers her vault with the Hub and NetworkRegistry
  - mints her ENS name (`type=personal`, `status=active`)
- The CRE Sentinel already watches the Hub, so her vault is covered from the first block.

**2. Depositing**
- She deposits 3 ETH and receives 3 `vETH`.
- She converts UNI into protected dollars in **one Universal Router transaction**: UNI → USDC (v4 pool) → `vUSDC` (VaultHook).
- The fee in UNI goes to the Token Jar.

**3. Everyday spending (instant lane)**
- She pays a friend $40 in ETH. The vault checks:
  1. the caller is whitelisted
  2. no unapproved 7702 delegation
  3. the ETH/USD feed is fresh
  4. $40 fits the rolling budget
- It sends immediately. **No CRE involved.**

**4. Market crash**
- ETH drops 15%. The Market watcher sets ETH to **volatile** mode.
- Alice taps **"Move to safety"**: `vETH` → USDC through Uniswap, **inside her vault**.
  - The output must be ≥ Chainlink price − cap.
  - No budget used, because the value never left protection.

**5. Big withdrawal (queued lane)**
- She wants $8,000 sent to a new exchange deposit address.
  1. The vault emits `UnwrapRequested`.
  2. The Sentinel scores `NEW_DESTINATION` + `OVER_BUDGET` → **HOLD**.
  3. CRE notifies her phone.
  4. She approves with Face ID. The passkey signs the request hash, and the vault verifies it via P256VERIFY.
  5. The Sentinel re-scores to **CLEAR**, so the floor applies (15 min). Funds go out.
- To allowlist that exchange address for next time: 48h to add.

**6. Alice gets hacked (laptop malware steals her EOA key)**

| Attacker tries | Result |
|---|---|
| Transfer `vETH` to own address | Reverts (not whitelisted) |
| 7702-delegate her EOA to a sweeper | The vault refuses calls from unknown delegated code; the Reconciler flags `DELEGATION_CHANGED` |
| Large swap out through Uniswap | Reverts (same budget in the hook) |
| Change recovery address | 7-day timelock; any withdrawal while pending is flagged |
| Small drains within budget | Possible only until the flag lands. **Worst case: one day's budget.** |
| Safe-harbor swap into a rigged pool | Blocked: allowlisted pools only, plus oracle minimum output |

- On the flag, the Incident responder:
  - freezes the vault (instant lane and Uniswap route included)
  - flips her ENS status to `frozen`
  - blocklists the attacker's addresses network-wide
  - notifies Alice on every channel

**7. Recovery**
- Alice signs with her passkey + hardware wallet.
- Funds migrate to a fresh vault bound to a new EOA, and the factory re-points `alice.palmfi.eth`.
- No vote needed.

### 13.2 Institution: Nvidia (with Palantir as fellow member)

**1. Onboarding**
- Nvidia passes business verification offchain and submits:
  - a transaction profile (frequency, typical sizes, hours, regular counterparties)
  - whitelisted treasury-ops wallets
  - approval-system endpoint + approver keys (on separate infrastructure)
  - a guardian (security-team multisig)
  - a cold recovery multisig
  - fail-closed mode
- The detailed profile and API credentials go into the **Vault DON**. Only coarse caps go onchain.
- The factory:
  - deploys the vault + `nUSDC`
  - initializes its v4 pool with the VaultHook
  - mints `nvidia.palmfi.eth` (`verified=true`)
  - registers Nvidia as a voting member

**2. Funding**
- The treasury deposits USDC → `nUSDC` across its ops wallets.

**3. Getting paid by a member**
- Palantir types `nvidia.palmfi.eth`. The app shows the verified badge and `status=active`.
- Palantir pays $1.2M from `pUSDC`:
  - burn `pUSDC` → mint `nUSDC` to Nvidia's whitelisted wallet
  - the backing moves between vaults
- The money never leaves protection. The fee goes to the jar.

**4. Paying an outside vendor**
- One Universal Router transaction: `nUSDC` → USDC (hook, within budget) → ETH (regular pool) → vendor.

**5. Payroll ($2M, legitimate)**
1. `requestUnwrap` → the Sentinel checks the profile (payroll day, business hours, known counterparty).
2. Via Confidential HTTP, it asks the approval system: *is there an approved payout matching this amount, destination and request hash?* Yes → the system returns an approver signature.
3. CRE writes a **CLEAR** with the signature through the forwarder.
4. The vault verifies the workflow ID, request hash and approver signature. The floor applies, and payroll executes.
- If the API times out → **HOLD**, never CLEAR.

**6. The Binance replay (attackers control Nvidia's signing infrastructure; every signature is valid)**

| Attacker tries | Result |
|---|---|
| Delegate a hot wallet to a sweeper | Refused; the Reconciler raises `DELEGATION_CHANGED` |
| $50M `requestUnwrap` at 2am to a fresh address | The Sentinel finds no approved payout, off-hours, new destination → **FLAG** within seconds (LATEST confidence) |
| Exploit safe-harbor swaps | Allowlisted pools + oracle minimum output |
| Drip within budget | Bounded by remaining budget and rolling 24h/7d caps, and only until the freeze |
| Rush funds to a DEX before freezes (the Binance move) | Nothing to rush: funds never left the vault |

- The Incident responder:
  - freezes the vault and cuts the Uniswap route
  - flips the ENS status to `frozen`
  - pushes attacker addresses to the network blocklist; **Palantir's vault and every other vault now refuse them**
  - notifies members

**7. Recovery**
- Nvidia's cold recovery multisig migrates funds to its **pre-committed** recovery vault.
- If Nvidia can't act, members vote. The vote can only extend the freeze or send funds to Nvidia's own recovery vault.
- The factory deploys a fresh vault and re-points the ENS name.

**8. If Chainlink is down**
- The instant lane keeps operations running.
- Large requests wait for approvers + recovery (fail closed).

**9. Fees**
- The Token Jar fills with mixed tokens. A searcher pays the USDC threshold, and that USDC flows to the SafetyFund. The fund reimburses false-positive costs and acts as the shared backstop, by member vote.

---

## 14. Threat model summary

| Threat | Defense | Residual risk |
|---|---|---|
| Stolen EOA key (individual) | Budget, queue, passkey, CRE scoring, freeze | ≤ remaining instant budget before the flag |
| Compromised signing infrastructure (institution) | Approval-system cross-check, profile scoring, freeze | ≤ instant budget; approval system **must** be independent of hot wallets |
| EIP-7702 sweeper delegation | Approved-delegate check in vault + Reconciler flag | Vault funds safe; non-vault assets in the EOA still exposed |
| Moving tokens out of the wallet | Whitelist-only transfers | None |
| Draining via Uniswap | Hook shares budget and freeze | ≤ budget |
| Bad-price swap extraction | Allowlisted pools + oracle minimum output | ≤ slippage cap |
| Oracle stale or manipulated | Per-feed staleness, deviation check vs pool, degraded mode | Reduced functionality, not loss |
| Config-change attacks | Asymmetric timelocks; flag withdrawals while pending | None if the owner responds within the timelock |
| Protocol admin key compromise | No admin path to whitelists, recovery or funds; immutable vaults | Could disrupt *new* onboarding only |
| Malicious or Sybil voters | Members are verified; votes only freeze or send home | Griefing (delays) |
| CRE compromise or bug | Bounded powers; workflow ID pinned; floor + hard cap | Requires key + CRE compromise together; bounded by hard cap and pending cap |
| CRE outage | Instant lane unaffected; fail-open (individual) / fail-closed (institution) | Delays |
| Guardian compromise | Veto-only | Griefing (funds sent to own recovery) |
| Recovery key compromise | Cold, rarely used; changes timelocked | Losing both recovery and hot keys can still lose funds |
| Request flooding | Pending cap + bonds; largest first | — |
| Low-and-slow drain | Rolling 24h / 7d USD caps | ≤ caps |
| Contract bug | Immutable, per-user clones, invariant tests | Limited to the affected vault |
| Impersonation (fake token or name) | Factory-only ENS names; verified flag after business verification | Users must pay by name |

---

## 15. Gotchas and known limitations (master list)

**Design**
1. **CRE can't stop a transaction in flight.** It reacts to events after they land. Hence the two-step queued lane.
2. **Votes are too slow to be the brake and too powerful if they pick destinations.** Automatic freeze first; votes only extend freezes or migrate to a pre-committed recovery vault.
3. **The whitelist admin would be a honeypot.** Only each owner's cold key edits its whitelist; the protocol admin has no path.
4. **Holding each other's tokens spreads incidents.** Use burn-and-mint routing between vaults.
5. **Upgradeability is just another key to steal.** Vaults and hooks are immutable.
6. **Pooled vaults concentrate risk** (one bug, or one issuer blacklist, hits everyone). Use per-user clones.
7. **Guardian, approver keys and CRE must run on infrastructure separate from the signing systems they protect.**
8. **Delays cost UX.** The instant budget keeps everyday spending fast.

**Uniswap**

9. **A hook sees the router as `sender`, not the user.** Trust only known routers and read the real user from the router's `msgSender()`.
10. **Restrict the hook to factory-created pool keys** (check in `beforeInitialize`). Otherwise attackers can initialize pools with fake tokens on our hook.
11. **Hook permissions are encoded in its address.** Mine the address with CREATE2 (HookMiner).
12. **ERC-6909 claims leak.** A permissioned token held by the PoolManager can be minted into an ERC-6909 claim and traded outside the allowlist. Claims can circulate, but cashing out still hits our checks. State it, or front the token with Uniswap's Permissions Adapter (stretch).
13. **The hook path can't see the final USDC recipient** (the router decides it). Destination allowlist and blocklist checks apply to direct unwraps; the hook path is therefore limited to the instant budget.
14. **Aggregator hooks are live only on Ethereum mainnet, Base and Robinhood Chain.** On Sepolia, use a normal v4 pool; use a mainnet fork to demo real aggregator routing.
15. **Permissioned Pools check addresses, not amounts.** They would bypass the budget unless liquidity is capped.

**TJAR**

16. **Not deployed on Sepolia.** Deploy from the `Uniswap/tjar` repo; our script acts as the searcher.
17. **The Releaser owner can change payout token, threshold and destination.** Lock the terms or use a cold multisig.
18. **Posted price, no oracle: searchers keep the spread.** Fine for fees, poor for large receivables.

**Chainlink Data Feeds**

19. **Use a per-feed heartbeat staleness check and read `decimals()`.** Never use one global timeout.
20. **Only a few feeds exist on Sepolia.** List only assets with feeds; price stablecoins via their feed where available.
21. **You can't move a real Sepolia feed.** The crash scene needs a mock aggregator behind the same interface, clearly labeled as demo mode.
22. **Data Streams are early access, with testnet guides on Arbitrum Sepolia.** Roadmap only.

**CRE**

23. **Quotas:**
    - 10 triggers per workflow
    - 5 concurrent executions
    - 5-minute timeout
    - 15 EVM reads and 5 HTTP calls per execution
    - over-quota executions retried for 10 minutes, then dropped

    Hence: split workflows, batch views, a single Hub address and a Reconciler.
24. **Use LATEST for flags and a FINALIZED re-read before clears.** A write reply means included, not finalized.
25. **Authenticate reports:** forwarder + workflow ID / name / owner; bind to the request hash; nonce + expiry; FLAG beats CLEAR.
26. **CRE HTTP caching is best effort.** Downstream APIs must be idempotent.
27. **Deploying to the live CRE network may require access approval.** A CLI simulation qualifies for the prize.
28. **Fail-safe direction:** unsure → HOLD.

**ENS**

29. **We own `palmfi.eth`, not `usdc.eth`.**
30. **Names only stop impersonation with business verification before issuing `verified=true`.**
31. **ENSv2 must be central and the demo free of hard-coded values** (prize rule).

**Scope**

32. **ERC-20 assets on EVM chains only.** Native BTC, XRP and the like (also lost in the Binance hack) are out of scope.
33. **Assets held in the EOA outside the vault are not protected.**
34. **Losing both the recovery key and the hot keys can still lose funds.** Recovery must be cold and rarely used.

---

## 16. Hackathon plan

### 16.1 Prize targets (three partner picks)

| Partner | Prize | What we show | Requirements |
|---|---|---|---|
| **Uniswap Foundation** | Build with Uniswap ($10k: 4k / 3k / 2k / 1k) | Custom v4 VaultHook, Universal Router payment flows, safe-harbor swaps, TJAR | Public repo; `FEEDBACK.md`; Uniswap developer feedback form linking it; README pointing to exact contracts and lines |
| **ENS** | Best Use of ENSv2 ($7k) | Factory-run subname registry; non-transferable verified / personal names; live `status` record driven by CRE; Enhanced Access Control | ENSv2 on Sepolia, central to the product; functional demo with no hard-coded values; live demo link; open source |
| **Chainlink** | Best workflow with CRE ($1.5k) | Five workflows, decision engine, failure-matrix simulation suite, Data Feeds | CRE CLI simulation or live deployment; CRE used as an orchestration layer |

Optional: Chainlink's core prizes require **CCIP making a state change**. The natural fit is a cross-chain "lifeboat" recovery vault on a second chain, reached via CCIP. Stretch only.

### 16.2 Scope

**Must have**
- Factory, Vault (budgets, queue, freeze, migration, whitelist-only transfers, 7702 check, passkey verify), Hub, NetworkRegistry (blocklist).
- VaultHook (1:1 wrap / unwrap, shared budget) + Universal Router "pay with any token" route.
- PaymentRouter fee → one TJAR jar → SafetyFund.
- ENSv2 subname minting + `status` updates.
- Data Feed USD budgets + safe-harbor swap with oracle minimum output (mock aggregator for the crash scene).
- CRE Sentinel, Reconciler, Incident responder (simulated) + mock approval API.
- Frontend for both personas.

**Should have**
- Minimal member vote (extend freeze, migrate to recovery).
- Market watcher with deviation check.
- Approvals inbox via HTTP trigger.

**Stretch**
- Permissions Adapter in front of protected tokens.
- Permissioned Pools for company-to-company pairs.
- Per-company receivables jar.
- CCIP lifeboat.
- Data Streams.
- Mainnet-fork demo of aggregator-hook routing.

### 16.3 Demo script (~4 minutes)

1. **Onboard** Nvidia and Palantir: one factory transaction each; names appear on ENS with `verified=true`.
2. **Alice onboards**, deposits ETH, and converts UNI → `vUSDC` in one Uniswap route; the fee lands in the Token Jar.
3. **Palantir pays `nvidia.palmfi.eth`**: burn-and-mint settlement.
4. **Crash scene** (mock feed): ETH −15% → volatile mode → Alice's "Move to safety" at the oracle-checked price.
5. **Alice's $8k withdrawal**: HOLD → Face ID → CLEAR → executes at the floor.
6. **Binance replay on Nvidia**:
   - 7702 sweeper refused
   - 2am $50M request → FLAG
   - vault frozen, Uniswap route dead, ENS shows `frozen`
   - Palantir's vault refuses the attacker
7. **Recovery**: migration to Nvidia's pre-committed recovery vault (show the member vote path).
8. **Searcher releases the jar** → USDC lands in the SafetyFund.
9. **CRE simulation suite** passing under production limits.

### 16.4 Submission checklist

- [ ] Public repo with README (setup, architecture diagram, contract addresses on Sepolia, pointers to exact contracts and lines)
- [ ] `FEEDBACK.md` + Uniswap developer feedback form submitted
- [ ] Live demo link + demo video
- [ ] ENSv2 Sepolia addresses; demo uses real resolution, nothing hard-coded
- [ ] CRE workflow code + simulation logs (`cre workflow simulate --limits default`)
- [ ] Clear statement of which prize each part targets

### 16.5 Suggested work split (merge lanes if the team is smaller)

- **Contracts A:** Factory, Vault, Hub, NetworkRegistry, invariant tests.
- **Contracts B:** VaultHook, PaymentRouter, TJAR deployment, SafetyFund, safe-harbor swaps.
- **CRE:** five workflows, decision engine, simulation fixtures, mock approval API, notifications.
- **Frontend + ENS:** two personas, name-based payments, passkey flow, incident view, ENSv2 registry.

---

## 17. References

**Binance hack**
- TRM Labs: https://www.trmlabs.com/resources/blog/north-korea-steals-usd-6-36-billion-from-binance-in-the-largest-hack-in-history
- The Conversation: https://theconversation.com/the-binance-hack-exploited-familiar-weaknesses-all-organisations-should-learn-from-it-295627
- Chainalysis: https://www.chainalysis.com/blog/binance-exploit-latest-findings-and-response/
- SecurityHQ: https://www.securityhq.com/blog/the-binance-incident/

**Uniswap**
- Uniswap Labs hooks (LitePSM, Permissioned Pools, WETH / wstETH): https://developers.uniswap.org/docs/protocols/uniswap-labs-hooks
- Permissioned Pools overview: https://developers.uniswap.org/docs/protocols/v4/permissioned-pools/overview
- Permissioned Pools architecture: https://developers.uniswap.org/docs/protocols/v4/permissioned-pools/architecture
- Aggregator hooks launch: https://theblock.co/news/defi/2026-10-22-uniswaps-aggregator-hooks-go-live-ethereum-base-robinhood-chain-421932
- TJAR repo: https://github.com/Uniswap/tjar
- How TJAR works: https://blog.uniswap.org/how-tjar-works-uniswaps-onchain-fee-conversion-system
- v4 hook security (CertiK): https://www.certik.com/resources/blog/uniswap-v4-hooks-security-considerations

**Chainlink**
- CRE finality and confidence levels: https://docs.chain.link/cre/concepts/finality-ts
- CRE service quotas: https://docs.chain.link/cre/service-quotas
- CRE consumer contracts / ReceiverTemplate: https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts
- CRE EVM log trigger: https://docs.chain.link/cre/reference/sdk/triggers/evm-log-trigger-ts
- CRE Confidential HTTP: https://docs.chain.link/cre/reference/sdk/confidential-http-client-ts
- CRE simulation limits: https://docs.chain.link/cre/guides/operations/understanding-limits
- CRE supported networks: https://docs.chain.link/cre/supported-networks-go
- Data Streams getting started: https://docs.chain.link/data-streams/getting-started-hardhat
- Oracle security considerations (Cyfrin): https://medium.com/cyfrin/chainlink-oracle-defi-attacks-93b6cb6541bf

**ENS**
- ENSv2 docs: https://docs.ens.domains/ensv2/overview/
- Permissioned Registry: https://docs.ens.domains/ensv2/permissioned-registry
- Enhanced Access Control: https://docs.ens.domains/ensv2/enhanced-access-control/

**Ethereum**
- EIP-7951 (P256VERIFY): https://eips.ethereum.org/EIPS/eip-7951

**Hackathon**
- ETHGlobal Mumbai prizes: https://ethglobal.com/events/mumbai/prizes
