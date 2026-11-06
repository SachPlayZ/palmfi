# Arc Studio audit (2026-11-06): resolution

Source: Arc Studio session `palmfi` ([app](https://studio.arc.io/app/bd02f044-7cea-4167-b4b8-b41c3dc41502)), report in `arc-studio-2026-11-06.md`. Every PoC was re-run locally against `v2-arc-core` @ 3847099 and reproduced before fixing. Regressions: `contracts/test/AuditFixes.t.sol`.

| ID | Status | Change |
|----|--------|--------|
| F-1 | Fixed | `cancelChange` refuses REMOVE_WALLET / UNFREEZE / MIGRATE (`NotCancellable`); all delays bounded `Floor ≤ CapDelay ≤ MaxDelay ≤ 5 days` (`BadLimits`) at onboarding, `tightenLimits` and LIMITS proposals |
| F-2 | Fixed | `_migrate` keeps USDC equal to the token supply still outside wallets; a Migrated Vault can still `settleOut`; router pays only a wallet of the payee Vault (`BadRecipient`) |
| F-3 | Accepted for testnet (decided 2026-11-06) | Testnet Hub uses the CRE simulation forwarder so `cre workflow simulate --broadcast` can drive the demo. Production: deploy the workflows, set the KeystoneForwarder (`config/arc.json` `cre.forwarder`) and `pinWorkflow` |
| F-4 | Fixed | Sphere fits only tokens with liquidity; a full pool no longer blocks onboarding (the Vault just gets no pool seat) |
| F-5 | Accepted by design (decided 2026-11-06) | Veto = majority of the non-requester Voters: an attack needs >50% of wallets compromised, or a compromised minority plus absent honest wallets. Long Sentinel delays and per-Voter Telegram alerts exist to keep honest wallets present |
| F-6 | Accepted | LP is an org-level position by design (any wallet of the org may move it, only to its own wallets; spending still goes through the budget) |
| F-7 | Fixed | A FLAG blocklists network-wide only if the flagging Vault is verified |
| F-8 | Accepted | Dust outflows can pre-seed a destination; the amount term still scores the real request |
| F-9 | Fixed | A removed or leaving wallet's tokens move to the receiving wallet |
| F-10 | Accepted | LP moves stay inside the org's own wallets |
| F-11 | Fixed | See F-1 delay bound |
| F-12 | Fixed | No sphere (`radius == 0`) or an unfunded side → `InsufficientLiquidity` instead of a panic |
| F-13, F-14 | Accepted | Admin powers are documented; implementation contracts hold nothing |
