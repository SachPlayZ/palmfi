# palmfi

Protected vaults: each Owner deposits assets into their own Vault and holds a personal Protected token, so a valid signature alone can only move a bounded amount.

## Parties

**Owner**:
The individual or institution a Vault belongs to.
_Avoid_: User, customer, account holder

**Individual**:
An Owner that is a person, whose own devices (EOA, passkey, hardware wallet) are its Voters.
_Avoid_: Retail user, personal account

**Institution**:
An Owner that is a business; its staff's Hot wallets are its Voters.
_Avoid_: Company account, org, enterprise

**Voter**:
A Hot wallet (or passkey) of a Vault, one vote each; at least 3 per Vault.
_Avoid_: Member, signer, participant

## Holdings

**Vault**:
The per-Owner contract that holds the Underlying and enforces every spending rule.
_Avoid_: Wallet, account, safe

**Underlying**:
USDC, held 1:1 behind the Protected token, through Arc's ERC-20 interface only.
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
An Owner's optional cold key that can unfreeze or migrate to the Recovery vault; never spends.
_Avoid_: Admin key, master key, cold wallet

**Recovery vault**:
The destination fixed at onboarding to which a Vault's funds can be migrated after an incident.
_Avoid_: Backup wallet, cold wallet

## Movement

**Orbital pool**:
The single Uniswap v4 hook pool holding every org's Protected token on an Orbital curve; payers swap their token in, payees receive theirs out.
_Avoid_: Network transfer, burn-and-mint

**Settlement**:
Redeeming a foreign token the Orbital pool holds from its issuer's Vault into the under-supplied token's Vault.
_Avoid_: Rebalance, netting

**Lifeline**:
A payment a Frozen Vault makes to a counterparty it already paid, approved by its Recovery key and a wallet majority, fronted by the Orbital pool and repaid from the frozen reserves once the freeze resolves (ADR-0013).
_Avoid_: Emergency loan, credit line, bridge loan

**Unwrap**:
Turning Protected tokens back into the Underlying, sent to a destination.
_Avoid_: Withdrawal, redeem

## Oversight

**Hub**:
The single network contract every Vault reports its events through and every CRE Verdict arrives through.
_Avoid_: Router, registry, event bus

**Sentinel**:
The shared CRE workflow that scores every Owner's requests sets delays from the Deviation score, and raises the incident on a FLAG.
_Avoid_: Scorer, risk engine, per-vault workflow

**Reconciler**:
The shared CRE workflow that runs on a schedule to catch missed requests, check reserves and delegations, run Settlement and write the heartbeat.
_Avoid_: Cron job, keeper

**Deviation score**:
The Sentinel's deterministic surprisal (in bits) of a request vs that wallet's and Vault's onchain baseline.
_Avoid_: Risk score, probability

**Queued request**:
A request to Unwrap more than the Instant budget allows, which waits for a Verdict and a delay before it can be executed.
_Avoid_: Withdrawal request, pending tx

**Verdict**:
The Sentinel's ruling on a Queued request: a delay set from the Deviation score, or FLAG.
_Avoid_: Score, decision, result

**Floor**:
The shortest delay any Queued request must wait, even when Cleared.
_Avoid_: Minimum delay, cooldown

**Hard cap**:
The amount above which a request waits at least CapDelay unless fast-tracked.
_Avoid_: Max withdrawal, limit

**Veto**:
>50% of a Vault's Voters other than the requester voting NO, which cancels a Queued request.
_Avoid_: Cancel, reject

**Fast-track**:
>50% of all a Vault's Voters voting YES, which makes a Queued request executable at the Floor.
_Avoid_: Approve, CLEAR

**Freeze**:
The Vault state in which every outflow stops, except migration to the Recovery vault; any one Voter can Freeze, a majority or the Recovery key unfreezes.
_Avoid_: Pause, lock, halt

**Vote**:
A Vault's own Voters' decision: Veto, Fast-track, unfreeze, wallet or settings change, migration to its own Recovery vault.
_Avoid_: Governance, DAO, proposal

**Vault status**:
A Vault's public standing: active, frozen, migrated or revoked, held in the Hub's name directory.
_Avoid_: State, health

**Blocklist**:
The network-wide list of attacker addresses that every Vault refuses as a destination.
_Avoid_: Denylist, sanctions list
