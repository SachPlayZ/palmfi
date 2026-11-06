"use client";

import { useState } from "react";
import { encodeAbiParameters, type Hex } from "viem";
import { useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { approvalBookAbi, vaultAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { REQ, REQ_LABEL, decodeReasonCodes, formatUsd } from "@/lib/palm";
import { isOpen as open, requestTimeline } from "@/lib/requests";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultRequest, VaultView } from "@/lib/vault";
import { signWithPasskey } from "@/lib/webauthn";
import { Badge, Button, Card, Mono, short } from "../ui";
import { findAsset, fmtAmount, assetLabel, useNow, useRoles } from "./common";

const stateTone: Record<number, "gray" | "green" | "amber" | "red" | "blue"> = {
  1: "blue",
  2: "green",
  3: "amber",
  4: "red",
  5: "gray",
  6: "gray",
  7: "gray",
};

function RequestRow({ v, r }: { v: VaultView; r: VaultRequest }) {
  const s = v.s!;
  const roles = useRoles(v);
  const now = useNow();
  const tx = useTx();
  const [msg, setMsg] = useState<string>();
  const asset = findAsset(v, r.asset);
  const t = requestTimeline(r, s.institution, s.floorDelay, now);
  const reasons = decodeReasonCodes(r.reasonCodes);
  const approval = useReadContract({
    address: deployments.approvalBook,
    abi: approvalBookAbi,
    functionName: "get",
    args: [v.vault!, r.requestHash],
    chainId: sepolia.id,
    query: { enabled: s.institution && open(r.state) && !!deployments.approvalBook, refetchInterval: 10_000 },
  });
  const posted = approval.data && approval.data.signature !== "0x" ? approval.data : undefined;
  const canCancel = open(r.state) && (roles.isHot || roles.isGuardian || roles.isRecovery);

  async function faceId() {
    setMsg(undefined);
    try {
      const sig = await signWithPasskey(r.requestHash, { x: s.passkeyX, y: s.passkeyY });
      await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "confirm", args: [r.id, sig] }, "Confirm with passkey");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function submitApproval() {
    if (!posted) return;
    const sig = encodeAbiParameters([{ type: "uint64" }, { type: "bytes" }], [posted.expiry, posted.signature as Hex]);
    await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "confirm", args: [r.id, sig] }, "Submit Payout approval");
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">#{r.id.toString()}</span>
          <Badge tone={stateTone[r.state]}>{REQ_LABEL[r.state]}</Badge>
          {r.secondFactor && <Badge tone="green">Second factor ✓</Badge>}
          <span className="tabular text-sm">
            {asset ? `${fmtAmount(r.amount, asset.decimals)} ${assetLabel(asset)}` : r.amount.toString()} · {formatUsd(r.usdValue)}
          </span>
        </div>
        <span className="text-xs text-[var(--subtle)]">
          to <Mono>{short(r.destination)}</Mono>
        </span>
      </div>
      <p className={`text-sm ${t.ready ? "text-emerald-600 dark:text-emerald-400" : "text-[var(--subtle)]"}`}>{t.text}</p>
      {reasons.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {reasons.map((c) => (
            <span key={c.code} title={c.description}>
              <Badge tone={c.code === "BLOCKLISTED_DEST" || c.code === "CONFIG_CHANGE_PENDING" ? "red" : "amber"}>{c.code}</Badge>
            </span>
          ))}
        </div>
      )}
      {s.institution && open(r.state) && (
        <p className="text-xs text-[var(--subtle)]">
          Payout approval: {posted ? `posted, expires ${new Date(Number(posted.expiry) * 1000).toLocaleString()}` : "none posted yet (Approver view)"}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!s.institution && open(r.state) && !r.secondFactor && (
          <Button onClick={faceId} disabled={tx.busy}>
            Confirm with Face ID / Touch ID
          </Button>
        )}
        {s.institution && posted && open(r.state) && !r.secondFactor && (
          <Button onClick={submitApproval} disabled={tx.busy}>
            Submit Payout approval
          </Button>
        )}
        {s.institution && r.state === REQ.PENDING && roles.isRecovery && !r.recoveryApproved && (
          <Button variant="secondary" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "recoveryApprove", args: [r.id] }, "Recovery key approval")}>
            Approve with Recovery key
          </Button>
        )}
        {r.executable && (
          <Button onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "execute", args: [r.id] }, "Execute")} disabled={tx.busy}>
            Execute
          </Button>
        )}
        {canCancel && !t.expired && (
          <Button variant="secondary" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "cancel", args: [r.id] }, "Cancel")} disabled={tx.busy}>
            Cancel (refund bond)
          </Button>
        )}
        {t.expired && (
          <Button variant="secondary" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "expire", args: [r.id] }, "Expire")} disabled={tx.busy}>
            Close expired request
          </Button>
        )}
      </div>
      {msg && <p className="text-xs text-red-600">{msg}</p>}
      <TxStatus state={tx.state} />
    </li>
  );
}

export function RequestsCard({ v }: { v: VaultView }) {
  if (!v.s) return null;
  const openOnes = v.requests.filter((r) => open(r.state));
  const closed = v.requests.filter((r) => !open(r.state));
  return (
    <Card title={`Queued requests${openOnes.length ? ` (${openOnes.length} open)` : ""}`}>
      {v.requests.length === 0 && <p className="text-sm text-[var(--subtle)]">No Queued requests yet. Anything above your Instant budget queues here.</p>}
      <ul className="flex flex-col gap-2">
        {openOnes.map((r) => (
          <RequestRow key={r.id.toString()} v={v} r={r} />
        ))}
      </ul>
      {closed.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-[var(--subtle)]">Recent closed requests ({closed.length})</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {closed.map((r) => (
              <RequestRow key={r.id.toString()} v={v} r={r} />
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
