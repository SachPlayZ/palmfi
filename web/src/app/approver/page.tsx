"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { type Hex } from "viem";
import { useReadContract, useSignTypedData } from "wagmi";
import { sepolia } from "wagmi/chains";
import { approvalBookAbi, vaultAbi } from "@/abi";
import { Badge, Button, Card, Field, Input, Mono, Notice } from "@/components/ui";
import { VaultGate } from "@/components/vault/dashboard";
import { assetLabel, findAsset, fmtAmount, useRoles } from "@/components/vault/common";
import { encodePayoutSecondFactor, payoutTypedData } from "@/lib/approval";
import { deployments } from "@/lib/deployments";
import { network } from "@/lib/network";
import { REQ_LABEL, decodeReasonCodes, formatUsd } from "@/lib/palm";
import { isOpen } from "@/lib/requests";
import { TxStatus, explainError, useTx } from "@/lib/tx";
import type { VaultRequest, VaultView } from "@/lib/vault";

function ApprovalRow({ v, r }: { v: VaultView; r: VaultRequest }) {
  const roles = useRoles(v);
  const tx = useTx();
  const { signTypedDataAsync } = useSignTypedData();
  const [hours, setHours] = useState("24");
  const [sig, setSig] = useState<{ signature: Hex; expiry: bigint }>();
  const [err, setErr] = useState<string>();
  const asset = findAsset(v, r.asset);
  const posted = useReadContract({
    address: deployments.approvalBook,
    abi: approvalBookAbi,
    functionName: "get",
    args: [v.vault!, r.requestHash],
    chainId: sepolia.id,
    query: { enabled: !!deployments.approvalBook, refetchInterval: 10_000 },
  });
  const onchain = posted.data && posted.data.signature !== "0x" ? posted.data : undefined;
  const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(hours) * 3600));
  const message = { vault: v.vault!, requestHash: r.requestHash, amount: r.amount, asset: r.asset, destination: r.destination, expiry };
  // Cross-check our EIP-712 digest construction against the contract's own payoutDigest.
  const digest = useReadContract({
    address: deployments.approvalBook,
    abi: approvalBookAbi,
    functionName: "payoutDigest",
    args: [message.vault, message.requestHash, message.amount, message.asset, message.destination, message.expiry],
    chainId: sepolia.id,
    query: { enabled: !!deployments.approvalBook },
  });

  async function sign() {
    setErr(undefined);
    try {
      const signature = await signTypedDataAsync({ ...payoutTypedData(deployments.approvalBook!, sepolia.id, message), account: roles.address });
      setSig({ signature, expiry });
      await tx.send(
        {
          address: deployments.approvalBook!,
          abi: approvalBookAbi,
          functionName: "post",
          args: [v.vault, r.id, r.requestHash, r.amount, r.asset, r.destination, expiry, signature],
        },
        "Post Payout approval",
      );
    } catch (e) {
      setErr(explainError(e));
    }
  }

  const toSubmit = sig ?? (onchain ? { signature: onchain.signature as Hex, expiry: onchain.expiry } : undefined);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Request #{r.id.toString()}</span>
        <Badge>{REQ_LABEL[r.state]}</Badge>
        {r.secondFactor && <Badge tone="green">Second factor recorded</Badge>}
        {onchain && <Badge tone="blue">approval posted</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-[var(--subtle)]">Amount</dt>
        <dd className="tabular">
          {asset ? `${fmtAmount(r.amount, asset.decimals)} ${assetLabel(asset)}` : r.amount.toString()} ({formatUsd(r.usdValue)})
        </dd>
        <dt className="text-[var(--subtle)]">Destination</dt>
        <dd>
          <Mono>{r.destination}</Mono>
        </dd>
        <dt className="text-[var(--subtle)]">Request hash</dt>
        <dd>
          <Mono>{r.requestHash}</Mono>
        </dd>
      </dl>
      {decodeReasonCodes(r.reasonCodes).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {decodeReasonCodes(r.reasonCodes).map((c) => (
            <Badge key={c.code} tone="amber">
              {c.code}
            </Badge>
          ))}
        </div>
      )}
      <p className="text-xs text-[var(--subtle)]">Only approve if this exact amount and destination match a payout your company actually owes.</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Valid for (hours)">
          <Input value={hours} onChange={(e) => setHours(e.target.value)} className="w-24" />
        </Field>
        <Button onClick={sign} disabled={!roles.isApprover || tx.busy || !isOpen(r.state)}>
          Sign &amp; post Payout approval
        </Button>
        {toSubmit && !r.secondFactor && (
          <Button
            variant="secondary"
            disabled={tx.busy}
            onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "confirm", args: [r.id, encodePayoutSecondFactor(toSubmit.expiry, toSubmit.signature)] }, "Record Second factor")}
          >
            Record as Second factor on the Vault
          </Button>
        )}
      </div>
      {digest.data && <p className="text-[10px] text-[var(--subtle)]">EIP-712 digest (from ApprovalBook): <Mono>{digest.data}</Mono></p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <TxStatus state={tx.state} />
    </li>
  );
}

function ApproverBody({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const s = v.s!;
  if (!s.institution) return <Notice tone="amber">{v.name ?? "This Vault"} is an Individual Vault; Individuals confirm with a passkey, not an Approver.</Notice>;
  const open = v.requests.filter((r) => isOpen(r.state));
  return (
    <Card title={`Payout approvals for ${v.name ?? v.vault}`}>
      <p className="mb-2 text-sm">
        Approver key: <Mono>{s.approver}</Mono> {roles.isApprover ? <Badge tone="green">connected</Badge> : <Badge tone="red">not connected</Badge>}
      </p>
      {!roles.isApprover && <Notice tone="amber">Connect the Approver key in this browser profile. Keep it apart from the treasury Hot wallets.</Notice>}
      {open.length === 0 && <p className="mt-2 text-sm text-[var(--subtle)]">No open Queued requests.</p>}
      <ul className="mt-2 flex flex-col gap-2">
        {open.map((r) => (
          <ApprovalRow key={r.id.toString()} v={v} r={r} />
        ))}
      </ul>
    </Card>
  );
}

function ApproverPage() {
  const params = useSearchParams();
  const [input, setInput] = useState(params.get("vault") ?? "");
  const [id, setId] = useState(params.get("vault") ?? "");
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Approver</h1>
        <p className="text-sm text-[var(--subtle)]">
          Sign EIP-712 Payout approvals for your Institution&apos;s Queued requests and post them to the ApprovalBook. Use a separate browser profile from the
          treasury team.
        </p>
      </div>
      <Card>
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            setId(input.trim().toLowerCase());
          }}
        >
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={`nvidia.${network.ensParent} or 0x…`} className="flex-1" aria-label="Institution Vault" />
          <Button type="submit">Load</Button>
        </form>
      </Card>
      {id && <VaultGate id={id}>{(v) => <ApproverBody v={v} />}</VaultGate>}
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <ApproverPage />
    </Suspense>
  );
}
