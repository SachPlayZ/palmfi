# Network transfers burn and mint; Members never hold each other's tokens

A payment between Members burns the payer's Protected token and mints the payee's in the same transaction, moving the Underlying from one Vault to the other. We rejected letting Members hold each other's Protected tokens: then a freeze at the payer would also freeze the payee's receivables, so one incident would spread across the network. The cost is a vault-to-vault call path that has to be kept apart from the instant lane, the queued lane and the hook.
