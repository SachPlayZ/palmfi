- Foundry `cast`/`forge` 1.x: `ETH_PASSWORD` = path to password *file*, not the password (raw password leaks in error). Never export it: makes `cast call` demand --keystore. Pass `--password-file <mktemp file>` only to signing cmds.

## Sepolia state-creation gas >> forge local estimate
- Sepolia (reth 2.10, Nov 2026) charges ~5–7x more gas for contract code storage than Foundry's local EVM simulates (Vault: 33.1M onchain vs 4.7M forge estimate). Default 130% multiplier → "contract creation code storage out of gas".
- Rule: broadcast deploys with `--gas-estimate-multiplier 900`; check sizes with `cast estimate --create` against the node, not forge's simulation. Fork tests still pass because they use forge's EVM rules.
