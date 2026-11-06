# Votes can extend a Freeze or send funds home, never choose a destination

> **Superseded** by ADR-0008 (votes are intra-org now; the never-choose-a-destination rule carries over) (2026-11-06 pivot).

When a frozen Member can't act (for example, its recovery key is lost or compromised), the other Members can vote. A vote's only actions are extending the Freeze, migrating the Vault to the Recovery vault that Member fixed at onboarding, and (after a 48h timelock) rotating the Hub's trusted CRE workflow ID. The same vote releases SafetyFund payouts. We rejected letting a vote pick the destination for rescued funds: a vote that can move money anywhere is a theft path for colluding or compromised Members. The cost is that if a Member's Recovery vault is itself lost, a vote can't redirect the funds.
