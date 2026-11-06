"use client";

import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hash } from "viem";
import { useAccount, useChainId, useConfig, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { sepolia } from "wagmi/chains";
import { useQueryClient } from "@tanstack/react-query";

/** Loosely typed write params: call sites pick functions dynamically (e.g. by role). */
export type WriteParams = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

export type TxState = { status: "idle" | "pending" | "mining" | "done" | "error"; hash?: Hash; message?: string };

/** Human-readable error from a viem/wagmi failure, naming custom errors (e.g. OverBudget) when decodable. */
export function explainError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name) return `${name}${hints[name] ? `: ${hints[name]}` : ""}`;
      return revert.reason ?? revert.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

const hints: Record<string, string> = {
  OverBudget: "above the remaining Instant budget, create a Queued request instead",
  NotHotWallet: "the connected account is not one of this Vault's Hot wallets",
  NotRecoveryKey: "connect the Recovery key",
  NotGuardian: "connect the Guardian",
  NotActive: "the Vault is not active (Frozen, migrated or revoked)",
  Paused: "the Vault is paused",
  Blocklisted: "the destination is on the network Blocklist",
  BadBond: "a Queued request needs exactly 0.001 ETH bond",
  TooManyPending: "too many pending Queued requests",
  NotExecutable: "not executable yet",
  BadSignature: "the Second factor signature was rejected",
  TimelockActive: "the timelock hasn't elapsed",
  NameTaken: "that name is taken",
  BadFee: "onboarding needs exactly 0.001 ETH",
  DelegateNotApproved: "this Hot wallet's EIP-7702 delegation is not approved",
  TransferNotAllowed: "Protected tokens only move between this Owner's Hot wallets",
  Degraded: "the asset is in Degraded Market mode",
  FeedStale: "the Chainlink price is stale",
  NotFactoryVault: "the payee is not a palmfi Vault",
};

/** Sends a contract write on Sepolia, waits for the receipt and refreshes cached reads. */
export function useTx() {
  const config = useConfig();
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const send = useCallback(
    async (params: WriteParams, label = "Transaction"): Promise<boolean> => {
      if (!isConnected) {
        setState({ status: "error", message: "Connect a wallet first" });
        return false;
      }
      try {
        if (chainId !== sepolia.id) await switchChainAsync({ chainId: sepolia.id });
        setState({ status: "pending", message: `${label}: confirm in your wallet` });
        const hash = await writeContract(config, { ...params, chainId: sepolia.id } as Parameters<typeof writeContract>[1]);
        setState({ status: "mining", hash, message: `${label}: waiting for Sepolia` });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: sepolia.id });
        if (receipt.status !== "success") throw new Error(`${label} reverted`);
        setState({ status: "done", hash, message: `${label}: confirmed` });
        await qc.invalidateQueries();
        return true;
      } catch (e) {
        setState({ status: "error", message: `${label}: ${explainError(e)}` });
        return false;
      }
    },
    [config, chainId, isConnected, switchChainAsync, qc],
  );

  return { state, send, setState, busy: state.status === "pending" || state.status === "mining" };
}

export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle" || !state.message) return null;
  const color =
    state.status === "error" ? "text-red-600 dark:text-red-400" : state.status === "done" ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--subtle)]";
  return (
    <p className={`mt-2 text-xs ${color}`} role="status" aria-live="polite">
      {state.message}
      {state.hash && (
        <>
          {" "}
          <a className="underline" href={`https://sepolia.etherscan.io/tx/${state.hash}`} target="_blank" rel="noreferrer">
            view
          </a>
        </>
      )}
    </p>
  );
}
