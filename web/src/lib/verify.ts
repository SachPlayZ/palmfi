import type { Address } from "viem";

export type VerifyRequest = {
  vault: Address;
  name: string;
  legalName: string;
  website: string;
  email: string;
  jurisdiction: string;
  signer: Address;
  at: number;
};

/** Message a voter signs to request the verified badge. */
export const verifyMessage = (vault: string, issuedAt: number) => `palmfi: request verification for Vault ${vault} (issued ${issuedAt})`;
/** Message the Hub admin signs to read requests. */
export const adminMessage = (issuedAt: number) => `palmfi: read verification requests (issued ${issuedAt})`;
