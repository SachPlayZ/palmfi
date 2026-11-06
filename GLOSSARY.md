# palmfi

Protected vaults: each Owner deposits assets into their own Vault and holds a personal Protected token, so a valid signature alone can only move a bounded amount.

## Parties

**Owner**:
The individual or institution a Vault belongs to.
_Avoid_: User, customer, account holder

**Individual**:
An Owner that is a person, protected by a passkey Second factor.
_Avoid_: Retail user, personal account

**Institution**:
An Owner that is a verified business and a Member of the network.
_Avoid_: Company account, org, enterprise

**Member**:
An Institution admitted to the network; Individuals are never Members.
_Avoid_: Participant, node

## Holdings

**Vault**:
The per-Owner contract that holds the Underlying and enforces every spending rule.
_Avoid_: Wallet, account, safe

**Underlying**:
A listed asset a Vault holds 1:1 behind its Protected tokens: USDC or WETH. Native ETH is accepted but held as WETH.
_Avoid_: Collateral, reserve asset

**Protected token**:
An Owner's personal wrapped token for one Underlying (e.g. `nUSDC`, `vETH`), movable only between that Owner's Hot wallets.
_Avoid_: Wrapped token, iUSDC, receipt token

**Hot wallet**:
An Owner-whitelisted address allowed to spend from the Vault.
_Avoid_: Signer, operator, EOA

**Instant budget**:
The USD amount an Owner's Vault can pay out immediately, shared across all Underlyings and refilling gradually over 24h and 7d windows.
_Avoid_: Daily limit, allowance, spend cap

**Recovery key**:
An Owner's cold key, the only one that can unfreeze, migrate, or loosen the Vault's settings.
_Avoid_: Admin key, master key, cold wallet

**Recovery vault**:
The destination fixed at onboarding to which a Vault's funds can be migrated after an incident.
_Avoid_: Backup wallet, cold wallet

## Movement

**Network transfer**:
A payment between two Members' Vaults that burns the payer's Protected token and mints the payee's, moving the Underlying between the Vaults.
_Avoid_: Internal transfer, settlement swap

**Unwrap**:
Turning Protected tokens back into the Underlying, sent to a destination.
_Avoid_: Withdrawal, redeem

## Oversight

**Hub**:
The single network contract every Vault reports its events through and every CRE Verdict arrives through.
_Avoid_: Router, registry, event bus

**Sentinel**:
The shared CRE workflow that scores every Owner's requests and raises the incident on a FLAG.
_Avoid_: Scorer, risk engine, per-vault workflow

**Reconciler**:
The shared CRE workflow that runs on a schedule to catch missed requests, check reserves and delegations, publish Market modes and write the heartbeat.
_Avoid_: Cron job, keeper

**Approver**:
An Institution's payout-approval key, kept apart from its Hot wallets.
_Avoid_: Signer, co-signer, admin

**Payout approval**:
An Approver's signed, onchain statement that a specific request (amount, asset, destination) is a legitimate payout.
_Avoid_: Approval API response, sign-off

**Queued request**:
A request to Unwrap more than the Instant budget allows, which waits for a Verdict and a delay before it can be executed.
_Avoid_: Withdrawal request, pending tx

**Verdict**:
The Sentinel's ruling on a Queued request: CLEAR, HOLD or FLAG.
_Avoid_: Score, decision, result

**Floor**:
The shortest delay any Queued request must wait, even when Cleared.
_Avoid_: Minimum delay, cooldown

**Hard cap**:
The amount above which a CLEAR also needs the Owner's Second factor.
_Avoid_: Max withdrawal, limit

**Second factor**:
An Owner's independent confirmation of a specific request: a passkey signature for an Individual, a Payout approval for an Institution.
_Avoid_: 2FA, MFA, co-sign

**Guardian**:
An Owner-chosen address that can only cancel, pause, or evacuate to the Recovery vault.
_Avoid_: Watcher, admin, moderator

**Freeze**:
The Vault state in which every outflow stops, except migration to the Recovery vault, unfreeze by the Recovery key, and Guardian evacuation.
_Avoid_: Pause, lock, halt

**Vote**:
A Members' decision that can only extend a Freeze or migrate a Vault to its own Recovery vault.
_Avoid_: Governance, DAO, proposal

**Market mode**:
An Underlying's price condition, Normal, Volatile or Degraded, which sets what the Vault allows for that asset.
_Avoid_: Risk mode, circuit breaker

**Safe-harbor swap**:
A swap from ETH into USDC that stays inside the Vault, is priced against Chainlink, and uses no Instant budget.
_Avoid_: Emergency swap, de-risk, move to safety

**Vault status**:
A Vault's public standing: active, frozen, migrated or revoked. The Hub holds it, and ENS mirrors it.
_Avoid_: State, health

**Blocklist**:
The network-wide list of attacker addresses that every Vault refuses as a destination.
_Avoid_: Denylist, sanctions list
