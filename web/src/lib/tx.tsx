"use client";

import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type Hash } from "viem";
import { useAccount, useChainId, useConfig, useSwitchChain } from "wagmi";
import { waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { arcTestnet, txUrl } from "./network";
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
  OverBudget: "above the remaining Instant budget: queue a request instead",
  NotWallet: "the connected account is not one of this Vault's wallets",
  NotRecoveryKey: "connect the Recovery key",
  OutflowsClosed: "the Vault is Frozen (or migrated): outflows are closed",
  Blocklisted: "the destination is on the network Blocklist",
  TooManyPending: "this wallet already has 3 pending requests",
  NotExecutable: "not executable yet",
  NotEligible: "this wallet was added after the request was made, so it can't vote on it",
  AlreadyVoted: "this wallet already voted",
  TimelockActive: "the timelock hasn't elapsed",
  NameTaken: "that name is taken",
  BadName: "names are lowercase a-z, 0-9 and '-', up to 32 characters",
  TooFewWallets: "a Vault needs at least 3 wallets",
  NotTightening: "that would loosen the setting: propose a change instead",
  DelegateNotApproved: "this wallet's EIP-7702 delegation is not approved",
  TransferNotAllowed: "Protected tokens only move between this Vault's own wallets and the pool",
  NotFactoryVault: "the payee is not a palmfi Vault",
  FrozenToken: "one side of this payment is Frozen",
  InsufficientReserve: "the pool doesn't hold enough of the payee's token right now; try a smaller amount or settle",
  Slippage: "the price moved past your limit",
  BadLimits: "delays must satisfy Floor ≤ CapDelay ≤ MaxDelay ≤ 5 days",
  NotCancellable: "removals, unfreeze and migrate can't be cancelled by one wallet",
  BadRecipient: "payments go to a wallet of the payee Vault",
  InsufficientLiquidity: "both orgs need liquidity in the Orbital pool before paying through it",
};

/** Sends a contract write on Arc testnet, waits for the receipt and refreshes cached reads. */
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
        if (chainId !== arcTestnet.id) await switchChainAsync({ chainId: arcTestnet.id });
        setState({ status: "pending", message: `${label}: confirm in your wallet` });
        const hash = await writeContract(config, { ...params, chainId: arcTestnet.id } as Parameters<typeof writeContract>[1]);
        setState({ status: "mining", hash, message: `${label}: waiting for Arc` });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId: arcTestnet.id });
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
          <a className="underline" href={txUrl(state.hash)} target="_blank" rel="noreferrer">
            view
          </a>
        </>
      )}
    </p>
  );
}
