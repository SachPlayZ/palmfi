import { encodeAbiParameters, type Address, type Hex } from "viem";

/** EIP-712 Payout approval (contracts/src/ApprovalBook.sol, ADR-0002). */
export const PAYOUT_TYPES = {
  PayoutApproval: [
    { name: "vault", type: "address" },
    { name: "requestHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "destination", type: "address" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export type PayoutApproval = {
  vault: Address;
  requestHash: Hex;
  amount: bigint;
  asset: Address;
  destination: Address;
  expiry: bigint;
};

export function payoutTypedData(approvalBook: Address, chainId: number, message: PayoutApproval) {
  return {
    domain: { name: "palmfi ApprovalBook", version: "1", chainId, verifyingContract: approvalBook },
    types: PAYOUT_TYPES,
    primaryType: "PayoutApproval" as const,
    message,
  };
}

/** The `sig` argument Vault.confirm expects for an Institution: abi.encode(uint64 expiry, bytes ecdsaSig). */
export function encodePayoutSecondFactor(expiry: bigint, signature: Hex): Hex {
  return encodeAbiParameters([{ type: "uint64" }, { type: "bytes" }], [expiry, signature]);
}
