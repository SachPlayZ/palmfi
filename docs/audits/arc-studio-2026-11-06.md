# palmfi v2 contracts: build, test and security review

Branch `v2-arc-core` @ `3847099`. Nothing deployed, nothing pushed, repo tree left clean.
Reproducible PoCs: `docs/palmfi-audit/AuditPoC.t.sol` (copy into `palmfi/contracts/test/` and run `forge test --match-path test/AuditPoC.t.sol -vv`). Each finding below marked "PoC" was reproduced; "code" means verified by reading the source only.

## Build and tests

- `forge build --sizes`: success (solc 0.8.29, prague). Runtime sizes: Vault 16,566 B, VaultModule 11,501, Hub 12,805, OrbitalHook 12,716, OrbitalRouter 3,108, ProtectedToken 3,220, VaultFactory 3,744. All under the 24,576 B limit.
- `forge test` (runs on an Arc testnet fork): 58 passed, 0 failed, 0 skipped, 7 suites. Submodules were fetched automatically.

## Summary

| ID | Severity | Where | Issue |
|----|----------|-------|-------|
| F-1 | High | VaultModule.sol:90, :17, :23; Vault.sol:288 | One wallet can freeze the org and cancel every vote that would unfreeze, remove it or migrate; can also brick budgets and delays |
| F-2 | High | OrbitalHook.sol:259-288, :210-236; VaultBase.sol:227 | A throwaway org takes another org's pooled liquidity for tokens it can then un-back (migrate) |
| F-3 | Critical (deployed Hub) | Hub.sol:323-327 | Deployed Hub is not pinned and trusts the simulation forwarder: anyone can forge CRE reports |
| F-4 | Medium | OrbitalHook.sol:112-114, :300; VaultFactory.sol:66 | Permissionless onboarding lets anyone brick the pool (22+ tokens) and onboarding (32) |
| F-5 | Medium | Vault.sol:176 | Veto quorum needs every honest wallet when the attacker holds the largest minority |
| F-6 | Medium | OrbitalHook.sol:173-181 | LP positions are org-level: any wallet can pull another wallet's liquidity |
| F-7 | Medium | Hub.sol:343-352 | Any address can be blocklisted across all Vaults for 30 days by a throwaway org |
| F-8 | Low | VaultBase.sol:201; Vault.sol:136 | Dust outflows poison the Sentinel baseline |
| F-9 | Low | VaultModule.sol:40; VaultBase.sol:214,227 | Tokens of a wallet that leaves or is removed are stranded |
| F-10 | Low | OrbitalHook.sol:161-181 | LP functions skip the EIP-7702 delegate check and the frozen check |
| F-11 | Low | VaultFactory.sol:66-70; VaultModule.sol:23 | No bound of maxDelay against the 7-day request TTL |
| F-12 | Low | OrbitalHook.sol:112-125 | Sphere not resized on token registration (Panic revert on swaps until next LP op) |
| F-13 | Low | Hub.sol:134, :276, :281 | Admin can revoke Vaults, unblock, and re-point the workflow identity |
| F-14 | Info | Vault.sol:17; ProtectedToken.sol:37 | Implementation contracts can be initialized by anyone (harmless, no selfdestruct) |

No finding lets a minority of wallets drain USDC faster than the budget plus veto window through Vault.sol alone: the Instant lane is capped by budget24h/budget7d, fast-track needs more than half of all wallets, the pool swap-in is charged to the same budget (`chargeOutflow`), and pool output only reaches wallets of the output token's own Vault. The drain-speed risk comes from F-3 (forged SET_DELAY) and F-5 (quorum).

## Findings

### F-3 Critical (deployed Hub): CRE reports can be forged by anyone
`Hub.sol:323-327`. `onReport` only checks `msg.sender == forwarder`; the workflow identity check runs only if `pinned`. The deployed Hub (0xA225...0CA0) has `pinned() == false` and `forwarder() == 0x6E9E...Dc1`, which reports `typeAndVersion() = "MockKeystoneForwarder 1.0.0-dev"`. That forwarder accepted a report from a random address with zeroed metadata and no signatures.
Verified on an anvil fork of Arc testnet: a random address called `report(hub, rawReport, 0x, [])` with a type-3 (DELEGATION_FLAG) report and the real deployed Vault 0x4667...302F went from status 1 (Active) to 2 (Frozen). No request id or hash needed.
Exploit: the same path carries SET_DELAY (`Vault.applyDelay`, Vault.sol:223 clamps the delay to `floorDelay`; the request hash is public, see PalmTypes.hashRequest) so a hacked wallet queues a withdrawal and immediately forges a Floor-delay score, shrinking the veto window from MaxDelay to Floor. FLAG forgery freezes a victim Vault, forfeits a bond, and blocklists any non-Vault address for 30 days. Heartbeat forgery hides a dead Sentinel.
Fix: do not accept reports until pinned: `if (!pinned) revert NotPinned();` at the top of `onReport`, set the production KeystoneForwarder (config/arc.json `cre.forwarder`) and call `pinWorkflow` before the Hub holds value; keep the simulation forwarder to disposable Hubs only. Also make `VaultFactory.createVault` refuse to onboard while the Hub is unpinned.

### F-1 High: a single hacked wallet can lock the org and veto all governance
`VaultModule.sol:90` `cancelChange` lets any wallet cancel any change that has not reached a majority, including REMOVE_WALLET, UNFREEZE and MIGRATE. `Vault.sol:288` lets any one wallet freeze. A proposal needs at least two separate transactions from different wallets for N=3 (proposer is 1 vote), so the hacked wallet cancels in between.
PoC `test_poc_singleWalletPermanentlyFreezesOrg`: wallet 0 freezes; honest wallet 1 proposes unfreeze three times, wallet 0 cancels each time, wallet 2 then reverts `BadState`; remove-wallet and migrate proposals are cancelled the same way. With no Recovery key (it is optional) the funds are locked permanently. With a Recovery key the only way out is `recoveryMigrate`.
PoC `test_poc_singleWalletBricksOutflowsAndSettings`: the hacked wallet calls `lowerBudget(0,0)` and `tightenLimits(.., maxDelay = type(uint32).max, ..)` (VaultModule.sol:17, :23, no upper bound); honest queued requests can never execute inside the 7-day TTL, and the restoring CHANGE_LIMITS vote is cancelled.
Fix: only allow `cancelChange` for loosening kinds (ADD_WALLET, ADD_DESTINATION, ADD_DELEGATE, BUDGET up, LIMITS loosen); never for REMOVE_WALLET, UNFREEZE, MIGRATE. Bound `tightenLimits` (`max_ <= REQUEST_TTL - floor`, keep floor <= cap <= max). Make a Recovery key mandatory, or let a majority executed after a long delay bypass cancellation. Exclude the target of REMOVE_WALLET from the quorum denominator.

### F-2 High: rug org takes another org's pooled liquidity
`OrbitalHook.sol:259-288` (swap-in is only charged to the payer's own budget; settlement is deferred, `_settle` :210-236), `VaultBase.sol:227` (`_migrate` sends the entire USDC balance to `recoveryVault`, but tokens held by the pool, hook or Vault itself are not burned).
PoC `test_poc_rugOrgLocksVictimLiquidity`: anyone creates a 3-wallet org with its own budget (1e12) and recovery address, swaps 8,962 of its own tokens for 9,000 of nvidia's 10,000 pooled tokens, delivered to nvidia's Vault address (allowed by `canTransfer`), then migrates with its own 3 votes: it recovers 100% of its 20,000 USDC stake, the pool is left holding unbacked tokens, `settle()` returns 0, nvidia's `removeLiquidity` reverts `InsufficientReserve`, and 9,000 nvidia tokens sit in the Vault contract where no function can move them.
PoC `test_poc_rugOrgHandsHackedWalletTheLiquidity`: same, but the recipient is a hacked nvidia wallet; it ends with 9,000 nvidia tokens for free and unwraps up to the Instant budget at once.
Fix: refuse `_migrate`/`unwrap` that would leave outstanding non-wallet supply unbacked (hold back `tokenSupply - walletBalances` in USDC, or block migrate while `reserveOf(token) > liquidityOf(token)`); settle atomically at swap time (issuer sends USDC to the receiving Vault inside `beforeSwap`) or require swap-in orgs to be admin-verified; reject `recipient == vault` in `ProtectedToken.canTransfer` (pool to Vault).

### F-4 Medium: onboarding spam bricks the pool
`VaultFactory.sol:66` is permissionless and calls `registerToken` (`OrbitalHook.sol:112`), which counts every token toward `n` and caps at `MAX_TOKENS = 32`. `_resize` (:300) uses `V = 19*total/n`; a one-sided reserve (every first LP is one-sided) reverts `OffSphere` once n >= 22 (`OrbitalMath.radius`, a < b).
PoC `test_poc_onboardingSpamBricksPool`: 22 junk Vaults, then the first `addLiquidity` reverts `OffSphere`; after 32, `createVault` reverts `TooManyTokens` for everyone. Cost: gas only. Deployed state today: 1 Vault, 1 token.
Fix: gate listing in the pool (admin or stake), count only tokens with reserves in `_resize`, and let Vault creation succeed even when the pool is full.

### F-5 Medium: veto needs every honest wallet at the largest minority
`Vault.sol:176` vetoes at `no * 2 > voterCount - 1`, and the requester cannot vote no, but the requester's colluding wallets stay in the denominator. With N = 2c+1 and c hacked wallets, all c+1 honest wallets must vote no within the delay.
PoC `test_poc_vetoNeedsEveryHonestWallet`: 5 wallets, 2 hacked, 2 of 3 honest vote no, the request is still pending and executes after 72h.
Fix: choose the threshold deliberately, for example veto at `no >= ceil((voterCount-1)/2)` or one third of voters with a minimum of 2, and accept the grief tradeoff for small orgs; at least document that unavailable honest wallets count toward the attacker.

### F-6 Medium: any wallet can pull any LP position
`OrbitalHook.sol:173-181` `removeLiquidity` is checked against `liquidityOf[token]` (per token) and only requires `msg.sender` and `to` to be wallets of the Vault. PoC `test_poc_anyWalletPullsAnyLp`: wallet 1, which never provided liquidity, withdrew wallet 0's 10,000.
Fix: track `liquidityOf[token][wallet]`.

### F-7 Medium: blocklist griefing across Vaults
`Hub.sol:343-352`: a FLAG blocklists `dest` for 30 days when `dest` is not a Vault, and `isBlocked` is checked by every Vault. A throwaway org only needs the Sentinel to FLAG a request to an arbitrary destination (sFlag = 28,000 milli-bits in cre/sentinel/config.*.json; new wallet, new destination and an amount far above a dust baseline can reach it). Cost is about the 1 USDC bond plus a temporary hold of the amount. Hub side verified (test_flag_freezesForfeitsBondAndBlocks), the scoring side by reading cre/shared/deviation.ts.
Fix: require the requesting Vault to be verified or aged, scope blocks to the flagging Vault plus a review step, or shorten the TTL and add admin-free expiry for unverified sources.

### Low and informational
- F-8: `_record` (VaultBase.sol:201) accepts 1-unit instant outflows; a dust unwrap to the attacker's address sets `destinationCount` and removes NEW_DESTINATION from the Sentinel score. Add a minimum recorded amount.
- F-9: PoC `test_poc_leaveStrandsTokens`: a wallet that leaves keeps its tokens, nobody can transfer or burn them, and `_migrate` only burns current wallets. Require a zero balance to leave or burn on removal.
- F-10: `addLiquidity`/`removeLiquidity` use `isWallet`, not `_checkWallet`, so a delegated EOA with an unapproved 7702 target and a frozen Vault's wallets can still move LP.
- F-11: `createVault` and `tightenLimits` allow `maxDelay` above `REQUEST_TTL` (7 days), which makes queued requests unexecutable.
- F-12: `registerToken` does not call `_resize`; with the pool at n=1 the radius stays 0 and swaps panic (arithmetic underflow) until the next LP operation. Observed while writing the PoC.
- F-13: the Hub admin can revoke a Vault, unblock, and rotate the pinned workflow after 48h; the rotation is not cancellable.
- F-14: `Vault.initialize` and `ProtectedToken.initialize` are callable on the implementation contracts. No impact on clones.
