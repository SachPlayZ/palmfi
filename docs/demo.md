# Demo script (~4 min, Arc testnet)

Live on the deployment in [`deployments/arc.json`](../deployments/arc.json). Amounts are faucet-sized (brief §6.7): Instant budget $5/24h, Hard cap $50, Floor 1 min, MaxDelay 72h, CapDelay 24h, usual max payout $10.

## Before the demo

- [ ] 8 browser-wallet accounts funded from [faucet.circle.com](https://faucet.circle.com) (Arc Testnet), about 20 USDC each: `n1..n5` for nvidia, `p1..p3` for palantir. One wallet can hold all of them as separate accounts.
- [ ] `cd web && pnpm dev`, open http://localhost:3000. Close other tabs and scripts that use the public Arc RPC (it rate-limits at load).
- [ ] `cre` CLI on PATH, `cre/.env` set (`CRE_ETH_PRIVATE_KEY`, `ARC_RPC_URL`).
- [ ] A **payroll history** on nvidia, so the Sentinel has a baseline: about 8 small payments ($3–6) from different wallets to one payee address, made with `Send` before the demo. Scores below assume about 12 such outflows.
- [ ] The Arc Studio app open: https://studio.arc.io/app/bd02f044-7cea-4167-b4b8-b41c3dc41502
- [ ] Telegram linked for at least one nvidia wallet (dashboard, Notifications card).

**Scoring a request live:** every queued request emits `RequestQueued` on the Hub. Copy the tx hash from the toast's "view" link and run the Sentinel against it, writing the result onchain:

```bash
cd cre && cre workflow simulate sentinel --target staging-settings --non-interactive --broadcast --trigger-index 0 --evm-tx-hash <tx> --evm-event-index 1
```

(`--evm-event-index` is the Hub log's index in the receipt: 1 for `requestUnwrap`, 0 for `proposeChange`.)

## Scenes

### 1. Onboard (30s)
`/onboard` as `n1`: name `nvidia`, wallets `n1..n5`, a Recovery vault address, demo limits. One transaction creates the Vault, its token `nvidiaUSDC`, its name in the Hub and its seat in the Orbital pool. Repeat for `palantir` (`p1..p3`). Deposit 15 USDC each (Deposit card) and add 10 of each token as pool liquidity (Orbital pool liquidity card).
**Say:** each org's money sits behind its own token; no protocol admin can touch wallets, recovery or funds.

### 2. Pay by name through the Orbital pool (40s)
As `p1`, `/pay` → your Vault `palantir` → payee `nvidia`, amount 3. The card shows the payee's status, the verified badge and the exact quote. Pay. Nvidia's receiving wallet `n1` gets exactly 3 `nvidiaUSDC`; the swap-in is charged to palantir's Instant budget.
Show the pool line on both dashboards (pool holds more `palantirUSDC`, less `nvidiaUSDC`), then **Settle pool**: palantir's Vault burns its excess tokens and sends the USDC to nvidia's Vault, which mints its own token back into the pool.
**Say:** one pool for every org's token, Uniswap v4 hook, Paradigm Orbital math; nobody ever ends up holding another org's token.

### 3. Payroll, fast-tracked (30s)
As `n2`, Send $8 to the payroll address: above the $5 budget, so it queues (1 USDC bond) at MaxDelay. Score it: about **3.5 bits → about 3 min**. Open **Why this delay?** to show the per-term breakdown (the UI re-runs the Sentinel's exact model on the same onchain inputs). As `n1`, `n3`, `n4` click **Fast-track**: 3 of 5 YES → executable at the 1-min Floor → **Execute**.
**Say:** routine payments barely wait; a majority can always speed them up.

### 4. Hacked engineer (60s)
`n5` is "hacked".
1. **Sybil attempt:** as `n5`, propose **Add wallet** (attacker puppet) in Settings. Score the `ConfigChange` (event index 0): every open request is re-scored with `CONFIG_CHANGE_PENDING` (+4 bits). Any honest wallet clicks **Cancel** on the proposal (a single wallet can cancel a loosening change, but never a removal, unfreeze or migration).
2. **Drain attempt:** as `n5`, Send $45 to a fresh address. Score it: amount, new destination and velocity add up to **about 13–21 bits → about 40 min to 5 h** (more at night UTC, and from a wallet under 7 days old). The Telegram alert reaches every Voter. As `n1`, `n2`, `n3` click **Veto**: 3 of the 4 non-requester wallets → **Vetoed**. The escrowed tokens go back to `n5` (still behind the budget); only a FLAG forfeits the bond. The money never left the Vault.
3. **Freeze:** as `n1`, **Freeze Vault**. Every outflow and pool swap stops at once; deposits and incoming payments still arrive. Show the **Incident view**: what happened, and recovery options (a majority votes Unfreeze or Remove wallet, which the hacked wallet can't cancel; or Migrate to the fixed Recovery vault).
**Say:** one valid signature only buys the budget; above it, the more unusual it is, the longer the team has to say no.

### 5. Frozen org in the pool (20s)
With nvidia frozen, as `p1` try to pay `nvidia` again: the quote fails (`FrozenToken`). The frozen token is out of the pool until a majority unfreezes. Unfreeze: `n1` proposes **Unfreeze** on the Incident view, `n2` and `n3` vote → active.

### 6. Chainlink CRE and Arc Studio (30s)
- `cd cre && bun run simulate`: the failure-matrix fixtures (baseline heartbeat, replay skipped, Sybil re-score). Logs: [`cre/fixtures/logs/`](../cre/fixtures/logs).
- Arc Studio: the app's chat shows the build, the 58/58 test run on an Arc fork and the security review; [`docs/audits/`](audits) shows the 7 fixes that came out of it.

**Close:** *Your keys can be stolen. Your money can't leave faster than your team can say no.*

## Calibration note

The FLAG threshold (28 bits) is calibrated for treasury scale: a $3M payment at 3am to a new address from a new wallet scores about 30 bits. At faucet scale the same attack scores about 25 bits, so scene 4 shows the long-delay-and-veto path, and a live FLAG (automatic freeze plus network blocklist) is covered by the unit tests and fixtures instead. Lowering `scoring.sFlag` in `cre/sentinel/config.staging.json` to 20000 would make scene 4's drain attempt FLAG live.
