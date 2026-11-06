# Payout approvals are posted onchain, not served by an offchain API

> **Superseded** by ADR-0008 (intra-org majority fast-track replaces Payout approvals) (2026-11-06 pivot).

The brief has the Sentinel ask each Institution's approval system over (Confidential) HTTP whether a request matches an approved payout. Instead, the Institution's Approver key signs an EIP-712 Payout approval and posts it to a contract on Sepolia. The Sentinel reads it with a chain read, and the Vault verifies the signature itself. This keeps the whole flow end to end on Sepolia, with no mocked company API, and the Vault doesn't have to trust the CRE's word on approval. The cost is that payout metadata (amount, destination) becomes public. Confidential HTTP is still used, for Owner notifications.
