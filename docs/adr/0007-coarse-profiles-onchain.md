# Institution profiles live onchain in coarse form

The brief keeps detailed Institution profiles (hours, typical sizes, counterparties) in Vault DON secrets. CRE secrets are fixed per deployment, so they can't hold a per-Owner profile that changes as Owners join. Instead, each Vault stores a coarse profile onchain: business hours (UTC), usual maximum payout, and the destination allowlist. The Sentinel reads it with a chain read. The cost is privacy: these coarse numbers are public.
