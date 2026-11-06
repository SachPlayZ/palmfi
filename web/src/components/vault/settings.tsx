"use client";

import { useState } from "react";
import { decodeAbiParameters, encodeAbiParameters, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultAbi } from "@/abi";
import { CHANGE, CHANGE_LABEL, formatDuration, formatUsd, parseUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultChange, VaultView } from "@/lib/vault";
import { createPasskey } from "@/lib/webauthn";
import { Badge, Button, Card, Field, Input, Mono, Notice, Select } from "../ui";
import { useNow, useRoles } from "./common";

export function HotWalletsCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const tx = useTx();
  const s = v.s;
  const del = useReadContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "delegations",
    chainId: sepolia.id,
    query: { enabled: !!v.vault, refetchInterval: 30_000 },
  });
  const [add, setAdd] = useState("");
  if (!s) return null;
  const canTighten = roles.isHot || roles.isRecovery;
  return (
    <Card title="Hot wallets">
      <ul className="flex flex-col gap-2">
        {s.hotWallets.map((h, i) => {
          const target = del.data?.[1]?.[i];
          const ok = del.data?.[2]?.[i];
          return (
            <li key={h} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Mono>{h}</Mono>
                {h === s.defaultReceiver && <Badge tone="blue">receives payments</Badge>}
                {h.toLowerCase() === roles.address?.toLowerCase() && <Badge>you</Badge>}
                {target && target !== zeroAddress && <Badge tone={ok ? "green" : "red"}>{ok ? "approved 7702 delegate" : "UNKNOWN 7702 delegate"}</Badge>}
              </div>
              {canTighten && h !== s.defaultReceiver && (
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "setDefaultReceiver", args: [h] }, "Set receiving Hot wallet")}>
                    Make default
                  </Button>
                  <Button variant="ghost" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "removeHotWallet", args: [h] }, "Remove Hot wallet")}>
                    Remove
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="0x… new Hot wallet" className="flex-1" />
        <Button
          variant="secondary"
          disabled={!roles.isRecovery || !isAddress(add) || tx.busy}
          onClick={() =>
            tx.send(
              { address: v.vault!, abi: vaultAbi, functionName: "proposeChange", args: [CHANGE.ADD_HOT_WALLET, encodeAbiParameters([{ type: "address" }], [add as Address])] },
              "Propose Hot wallet",
            )
          }
        >
          Propose (48h, Recovery key)
        </Button>
      </div>
      <p className="mt-1 text-xs text-[var(--subtle)]">Removing a Hot wallet is instant. Adding one is a loosening change: Recovery key + 48h timelock.</p>
      <TxStatus state={tx.state} />
    </Card>
  );
}

export function describeChange(c: Pick<VaultChange, "kind" | "data">): string {
  try {
    switch (c.kind) {
      case CHANGE.BUDGET: {
        const [a, b] = decodeAbiParameters([{ type: "uint128" }, { type: "uint128" }], c.data);
        return `24h ${formatUsd(a)}, 7d ${formatUsd(b)}`;
      }
      case CHANGE.LIMITS: {
        const [cap, f, full] = decodeAbiParameters([{ type: "uint128" }, { type: "uint32" }, { type: "uint32" }], c.data);
        return `Hard cap ${formatUsd(cap)}, Floor ${Math.round(f / 60)}m, full delay ${(full / 3600).toFixed(1)}h`;
      }
      case CHANGE.PASSKEY:
        return "new passkey public key";
      default: {
        const [a] = decodeAbiParameters([{ type: "address" }], c.data);
        return a;
      }
    }
  } catch {
    return c.data;
  }
}

const SENSITIVE: number[] = [CHANGE.GUARDIAN, CHANGE.RECOVERY_KEY, CHANGE.RECOVERY_VAULT, CHANGE.APPROVER, CHANGE.PASSKEY];

export function PendingChanges({ v, compact }: { v: VaultView; compact?: boolean }) {
  const roles = useRoles(v);
  const now = useNow();
  const tx = useTx();
  const pending = v.changes.filter((c) => !c.done);
  if (compact && pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {pending.length === 0 && <p className="text-sm text-[var(--subtle)]">No pending settings changes.</p>}
      {pending.map((c) => {
        const left = Number(c.eta) - now;
        return (
          <div key={c.id.toString()} className="flex flex-col gap-1 rounded-lg border border-amber-500/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{CHANGE_LABEL[c.kind] ?? `kind ${c.kind}`}</span>
              {SENSITIVE.includes(c.kind) && <Badge tone="red">Instant budget zero while pending</Badge>}
              <Badge tone={left > 0 ? "amber" : "green"}>{left > 0 ? `executable in ${formatDuration(left)}` : "timelock elapsed"}</Badge>
            </div>
            <p className="text-xs text-[var(--subtle)]">
              <Mono>{describeChange(c)}</Mono>
            </p>
            <div className="flex flex-wrap gap-2">
              {roles.isRecovery && left <= 0 && (
                <Button onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "executeChange", args: [c.id] }, "Execute change")}>Execute</Button>
              )}
              {(roles.isRecovery || roles.isGuardian) && (
                <Button variant="secondary" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "cancelChange", args: [c.id] }, "Cancel change")}>
                  Cancel
                </Button>
              )}
              {!roles.isRecovery && !roles.isGuardian && <span className="text-xs text-[var(--subtle)]">Didn&apos;t propose this? Cancel it with your Recovery key or Guardian.</span>}
            </div>
          </div>
        );
      })}
      <TxStatus state={tx.state} />
    </div>
  );
}

const PROPOSABLE = [CHANGE.BUDGET, CHANGE.LIMITS, CHANGE.ADD_DESTINATION, CHANGE.ADD_DELEGATE, CHANGE.GUARDIAN, CHANGE.RECOVERY_KEY, CHANGE.RECOVERY_VAULT, CHANGE.APPROVER, CHANGE.PASSKEY];

export function SettingsCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const s = v.s;
  const tx = useTx();
  const [b24, setB24] = useState("");
  const [b7, setB7] = useState("");
  const [kind, setKind] = useState<number>(CHANGE.BUDGET);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [c, setC] = useState("");
  const [err, setErr] = useState<string>();
  if (!s) return null;

  async function propose() {
    setErr(undefined);
    let data: Hex;
    try {
      if (kind === CHANGE.BUDGET) data = encodeAbiParameters([{ type: "uint128" }, { type: "uint128" }], [parseUsd(a), parseUsd(b)]);
      else if (kind === CHANGE.LIMITS)
        data = encodeAbiParameters([{ type: "uint128" }, { type: "uint32" }, { type: "uint32" }], [parseUsd(a), Math.round(Number(b) * 60), Math.round(Number(c) * 3600)]);
      else if (kind === CHANGE.PASSKEY) {
        const pk = await createPasskey(v.label ?? "vault");
        data = encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [pk.x, pk.y]);
      } else {
        if (!isAddress(a)) throw new Error("Enter an address");
        data = encodeAbiParameters([{ type: "address" }], [a as Address]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "proposeChange", args: [kind, data] }, "Propose change");
  }

  const long = SENSITIVE.includes(kind);
  return (
    <Card title="Settings">
      <h3 className="mb-2 text-sm font-semibold">Pending changes</h3>
      <PendingChanges v={v} />

      <h3 className="mb-1 mt-4 text-sm font-semibold">Tighten now</h3>
      <p className="mb-2 text-xs text-[var(--subtle)]">Lowering limits takes effect immediately. Any Hot wallet or the Recovery key can do it.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label="New 24h budget (USD)">
          <Input value={b24} onChange={(e) => setB24(e.target.value)} placeholder={formatUsd(s.budget24h)} />
        </Field>
        <Field label="New 7d budget (USD)">
          <Input value={b7} onChange={(e) => setB7(e.target.value)} placeholder={formatUsd(s.budget7d)} />
        </Field>
        <Button
          variant="secondary"
          disabled={!(roles.isHot || roles.isRecovery) || tx.busy}
          onClick={() =>
            tx.send(
              { address: v.vault!, abi: vaultAbi, functionName: "lowerBudget", args: [b24 ? parseUsd(b24) : s.budget24h, b7 ? parseUsd(b7) : s.budget7d] },
              "Lower budget",
            )
          }
        >
          Lower Instant budget
        </Button>
      </div>

      <h3 className="mb-1 mt-4 text-sm font-semibold">Loosen (timelocked)</h3>
      {!roles.isRecovery && <Notice tone="gray">Only the Recovery key can loosen settings. Connect it to propose.</Notice>}
      <div className="mt-2 flex flex-col gap-2">
        <Select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
          {PROPOSABLE.map((k) => (
            <option key={k} value={k}>
              {CHANGE_LABEL[k]}
            </option>
          ))}
        </Select>
        {kind === CHANGE.BUDGET && (
          <div className="grid grid-cols-2 gap-2">
            <Input value={a} onChange={(e) => setA(e.target.value)} placeholder="24h USD" />
            <Input value={b} onChange={(e) => setB(e.target.value)} placeholder="7d USD" />
          </div>
        )}
        {kind === CHANGE.LIMITS && (
          <div className="grid grid-cols-3 gap-2">
            <Input value={a} onChange={(e) => setA(e.target.value)} placeholder="Hard cap USD" />
            <Input value={b} onChange={(e) => setB(e.target.value)} placeholder="Floor min" />
            <Input value={c} onChange={(e) => setC(e.target.value)} placeholder="Full delay h" />
          </div>
        )}
        {kind !== CHANGE.BUDGET && kind !== CHANGE.LIMITS && kind !== CHANGE.PASSKEY && <Input value={a} onChange={(e) => setA(e.target.value)} placeholder="0x…" />}
        {kind === CHANGE.PASSKEY && <p className="text-xs text-[var(--subtle)]">A new passkey is created on this device when you propose.</p>}
        <p className="text-xs text-[var(--subtle)]">
          Timelock: {long ? "7 days. While pending, your Instant budget is zero and any Queued request is FLAGged." : "48 hours."}
        </p>
        <Button disabled={!roles.isRecovery || tx.busy} onClick={propose}>
          Propose change
        </Button>
        {err && <p className="text-xs text-red-600">{err}</p>}
      </div>
      <TxStatus state={tx.state} />
    </Card>
  );
}
