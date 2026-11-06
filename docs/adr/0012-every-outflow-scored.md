# Every outflow is a scored request while CRE is live

While the Reconciler heartbeat is fresh (`Hub.creLive()`, 10 minutes), every outflow goes through a request the Sentinel scores before any money moves: Unwraps and Vault payments (`requestUnwrap` / `requestPayment`) and Orbital pool swap-ins (`requestSwap`, a clearance the swap consumes in `chargeOutflow`). The direct instant lane (`unwrap`, `pay`, budget-charged swaps) only works when CRE is silent, so silence still fails slow for anything above the budget and no worse than before below it.

Small payments stay instant in practice. Amount surprise is zero up to the onboarding threshold (`usualMaxPayout`) and rises smoothly above it, starting from 0 at the threshold. A request within the threshold whose total score is under `sQuiet` (2.5 bits) gets delay 0. The Vault honours a delay below the Floor only when the amount fits the remaining Instant budget, which it then spends, so a compromised CRE still releases no more than the budget. Requests that fit the budget carry no bond; the per-wallet pending cap still applies.

Because small transfers are now requests too, the velocity term sees a burst of them (smurfing). The burst loses the quiet lane after a few transfers and is FLAGged (freeze + blocklist) when it is improbable enough, before the next one pays out. The model is probabilistic (Laplace / Poisson surprisal) but deterministic: DON consensus rules out randomness (ADR-0009).

The cost: a pool payment is two transactions (clearance, then swap), and the deployed Hub and Vaults must be redeployed for `creLive`, zero delays and `requestSwap`. CRE fixtures 03, 05, 07 and 08 were recorded against the old deployment and need re-recording.
