"use client";

import { useState } from "react";
import { erc20Abi, maxUint256, type Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { orbitalHookAbi, orbitalRouterAbi, vaultAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";
import { KIND, REQ, STATUS, STATUS_LABEL, formatUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { hubAbi } from "@/abi";
import { Badge, Button, Card, Field, Input, Mono, Notice, StatusBadge, short } from "./ui";
import { eq, fmtAmount, safeParse, useDestination, useRoles } from "./vault/common";

const chainId = arcTestnet.id;

/** Payee Vault's token, receiving wallet, status and verified badge. */
function usePayee(vault: Address | undefined) {
  const q = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: vault, abi: vaultAbi, functionName: "token", chainId },
      { address: vault, abi: vaultAbi, functionName: "wallets", chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "statusOf", args: [vault!], chainId },
      { address: deployments.hub, abi: hubAbi, functionName: "verified", args: [vault!], chainId },
    ],
    query: { enabled: !!vault && !!deployments.hub, refetchInterval: 10_000 },
  });
  return {
    token: q.data?.[0]?.result as Address | undefined,
    receiver: (q.data?.[1]?.result as readonly Address[] | undefined)?.[0],
    status: q.data?.[2]?.result as number | undefined,
    verified: Boolean(q.data?.[3]?.result),
  };
}

/** Pay another org by name through the Orbital pool: exact-out, so the payee receives exactly the amount. */
export function PoolPayCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const d = useDestination(to);
  const p = usePayee(d.isVault ? d.address : undefined);
  const amt = safeParse(amount);
  const myToken = v.s?.token;
  const quote = useReadContract({
    address: deployments.hook,
    abi: orbitalHookAbi,
    functionName: "quote",
    args: [myToken!, p.token!, amt ?? 0n, false],
    chainId,
    query: { enabled: !!myToken && !!p.token && !!amt && !!deployments.hook, refetchInterval: 10_000 },
  });
  const allowance = useReadContract({
    address: myToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: [roles.address!, deployments.router!],
    chainId,
    query: { enabled: !!myToken && !!roles.address && !!deployments.router },
  });
  const amountIn = quote.data?.[0];
  const maxIn = amountIn !== undefined ? amountIn + amountIn / 100n + 1n : undefined; // 1% slippage
  const myBal = v.balances.find((b) => eq(b.wallet, roles.address))?.balance ?? 0n;
  const needsApprove = maxIn !== undefined && (allowance.data ?? 0n) < maxIn;
  const self = eq(d.address, v.vault);
  // CRE live: the swap must consume a pool-swap clearance this wallet requested and the Sentinel cleared.
  const clearances = v.requests.filter((r) => r.kind === KIND.SWAP && r.state === REQ.PENDING && eq(r.requester, roles.address));
  const cleared = maxIn !== undefined ? clearances.find((r) => r.executable && r.amount >= maxIn) : undefined;
  const waiting = clearances.find((r) => !r.executable);
  const needsClearance = v.creLive && !cleared;
  const overBudget = !v.creLive && amountIn !== undefined && v.s ? amountIn > v.s.availableBudget : false;

  async function go() {
    if (!myToken || !p.token || !p.receiver || !amt || !maxIn) return;
    if (needsClearance) {
      if (await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "requestSwap", args: [maxIn] }, "Request clearance (CRE scores it)")) v.refetch();
      return;
    }
    if (needsApprove) return tx.send({ address: myToken, abi: erc20Abi, functionName: "approve", args: [deployments.router!, maxUint256] }, `Approve ${v.symbol}`);
    if (await tx.send({ address: deployments.router!, abi: orbitalRouterAbi, functionName: "swap", args: [myToken, p.token, amt, false, maxIn, p.receiver] }, "Pay via Orbital pool"))
      setAmount("");
  }

  return (
    <Card title="Pay an org by name">
      {!roles.isWallet && <Notice tone="amber">Connect one of this Vault&apos;s wallets to pay.</Notice>}
      <div className="mt-2 flex flex-col gap-3">
        <Field
          label="Payee"
          hint={
            d.name && d.resolving ? "Resolving…" : d.unknownName ? "No Vault under that name" : d.address && !d.isVault ? "Not a palmfi Vault: use Send for plain addresses" : undefined
          }
        >
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="palantir" autoComplete="off" />
        </Field>
        {d.isVault && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] p-2 text-sm">
            <strong>{d.name || short(d.address)}</strong>
            <StatusBadge status={p.status !== undefined ? STATUS_LABEL[p.status] : undefined} />
            {p.verified ? <Badge tone="blue">verified</Badge> : <Badge tone="amber">unverified</Badge>}
            <span className="text-xs text-[var(--subtle)]">
              paid to <Mono>{short(p.receiver)}</Mono>
            </span>
          </div>
        )}
        <Field label="Amount they receive (USDC)" hint={`This wallet holds ${fmtAmount(myBal)} ${v.symbol}`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
        </Field>
        {quote.error && <p className="text-xs text-red-600 dark:text-red-400">Pool can&apos;t quote this: both orgs need liquidity in the pool, neither may be Frozen, and the pool may be short (try less, or settle).</p>}
        {amountIn !== undefined && (
          <p className="text-sm">
            You pay <span className="tabular font-medium">{fmtAmount(amountIn)} {v.symbol}</span> ({formatUsd(amountIn - (amt ?? 0n))} pool spread)
            {overBudget && <span className="block text-xs text-amber-700 dark:text-amber-400">Over the Instant budget: queue a payment from Send instead.</span>}
            {v.creLive && (
              <span className="block text-xs text-[var(--subtle)]">
                {cleared ? "Cleared by CRE: pay now." : waiting ? `Clearance #${waiting.id} is waiting on its delay or vote.` : "CRE checks every payment first: request clearance, then pay (routine amounts clear at once)."}
              </span>
            )}
          </p>
        )}
        <Button onClick={go} disabled={!roles.isWallet || !d.isVault || self || !amt || amountIn === undefined || overBudget || myBal < (maxIn ?? 0n) || p.status === STATUS.FROZEN || (needsClearance && !!waiting) || tx.busy}>
          {needsClearance ? (waiting ? "Waiting for clearance…" : "Request clearance") : needsApprove ? `Approve ${v.symbol}` : "Pay via Orbital pool"}
        </Button>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

/** Add or withdraw this org's own token in the Orbital pool; settle moves foreign inventory back to its issuers. */
export function LiquidityCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const [amount, setAmount] = useState("");
  const tx = useTx();
  const token = v.s?.token;
  const amt = safeParse(amount);
  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [roles.address!, deployments.hook!],
    chainId,
    query: { enabled: !!token && !!roles.address && !!deployments.hook },
  });
  const needsApprove = !!amt && (allowance.data ?? 0n) < amt;
  const hook = (functionName: string, args: unknown[], label: string) => tx.send({ address: deployments.hook!, abi: orbitalHookAbi, functionName, args }, label);

  return (
    <Card title="Orbital pool liquidity">
      <p className="text-sm">
        You provided <span className="tabular font-medium">{fmtAmount(v.poolLiquidity)} {v.symbol}</span>; the pool holds <span className="tabular">{fmtAmount(v.poolReserve)}</span>.
      </p>
      <p className="mt-1 text-xs text-[var(--subtle)]">Each org only adds and withdraws its own token. Withdrawals settle first: foreign tokens go back to their issuers for USDC.</p>
      {roles.isWallet && (
        <div className="mt-3 flex flex-col gap-2">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" />
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!amt || tx.busy}
              onClick={() => (needsApprove ? tx.send({ address: token!, abi: erc20Abi, functionName: "approve", args: [deployments.hook!, maxUint256] }, `Approve ${v.symbol}`) : hook("addLiquidity", [token, amt], "Add liquidity"))}
            >
              {needsApprove ? `Approve ${v.symbol}` : "Add"}
            </Button>
            <Button variant="secondary" disabled={!amt || amt > v.poolLiquidity || tx.busy} onClick={() => hook("removeLiquidity", [token, amt, roles.address], "Withdraw liquidity")}>
              Withdraw
            </Button>
            <Button variant="ghost" disabled={tx.busy} onClick={() => hook("settle", [], "Settle pool")}>
              Settle pool
            </Button>
          </div>
        </div>
      )}
      <TxStatus state={tx.state} />
    </Card>
  );
}
