"use client";

import { useState } from "react";
import { decodeAbiParameters, encodeAbiParameters, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { useReadContract } from "wagmi";
import { vaultAbi } from "@/abi";
import { arcTestnet } from "@/lib/network";
import { CHANGE, CHANGE_LABEL, CHANGE_TIMELOCK, MIN_WALLETS, fastTrackNeeded, formatDuration, formatUsd, parseUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultChange, VaultView } from "@/lib/vault";
import { Badge, Button, Card, Field, Input, Mono, Notice, Select, short } from "../ui";
import { eq, useNow, useRoles } from "./common";

const addr = [{ type: "address" }] as const;
const budget = [{ type: "uint128" }, { type: "uint128" }] as const;
const limits = [{ type: "uint128" }, { type: "uint32" }, { type: "uint32" }, { type: "uint32" }] as const;

function describe(c: Pick<VaultChange, "kind" | "data">): string {
  try {
    switch (c.kind) {
      case CHANGE.BUDGET: {
        const [a, b] = decodeAbiParameters(budget, c.data as Hex);
        return `24h ${formatUsd(a)} · 7d ${formatUsd(b)}`;
      }
      case CHANGE.LIMITS: {
        const [cap, f, m, cd] = decodeAbiParameters(limits, c.data as Hex);
        return `Hard cap ${formatUsd(cap)} · floor ${formatDuration(f)} · max ${formatDuration(m)} · cap delay ${formatDuration(cd)}`;
      }
      case CHANGE.UNFREEZE:
      case CHANGE.MIGRATE:
        return "";
      default:
        return short(decodeAbiParameters(addr, c.data as Hex)[0]);
    }
  } catch {
    return "?";
  }
}

export function WalletsCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const tx = useTx();
  const s = v.s!;
  const del = useReadContract({ address: v.vault, abi: vaultAbi, functionName: "delegations", chainId: arcTestnet.id, query: { enabled: !!v.vault, refetchInterval: 30_000 } });
  const [add, setAdd] = useState("");
  const propose = (kind: number, a: Address, label: string) =>
    tx.send({ address: v.vault!, abi: vaultAbi, functionName: "proposeChange", args: [kind, encodeAbiParameters(addr, [a])] }, label);
  return (
    <Card title="Wallets (Voters)">
      <ul className="flex flex-col gap-2">
        {s.wallets.map((w, i) => {
          const target = del.data?.[1]?.[i];
          const ok = del.data?.[2]?.[i];
          return (
            <li key={w} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Mono>{w}</Mono>
                {i === 0 && <Badge tone="blue">receives payments</Badge>}
                {eq(w, roles.address) && <Badge>you</Badge>}
                {target && target !== zeroAddress && <Badge tone={ok ? "green" : "red"}>{ok ? "approved 7702 delegate" : "UNKNOWN 7702 delegate"}</Badge>}
              </div>
              {roles.isWallet && s.wallets.length > MIN_WALLETS && (
                <Button variant="ghost" disabled={tx.busy} onClick={() => (eq(w, roles.address) ? tx.send({ address: v.vault!, abi: vaultAbi, functionName: "leave" }, "Leave") : propose(CHANGE.REMOVE_WALLET, w, "Propose removal"))}>
                  {eq(w, roles.address) ? "Leave" : "Propose removal"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {roles.isWallet && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="0x… new wallet" className="flex-1" />
          <Button variant="secondary" disabled={!isAddress(add) || tx.busy} onClick={() => propose(CHANGE.ADD_WALLET, add as Address, "Propose wallet add")}>
            Propose add
          </Button>
        </div>
      )}
      <p className="mt-2 text-xs text-[var(--subtle)]">
        A new wallet needs a majority, then waits 48h, and can&apos;t vote on requests made before it joined. While an add is pending, every request is scored as CONFIG_CHANGE_PENDING.
      </p>
      <TxStatus state={tx.state} />
    </Card>
  );
}

function ChangeRow({ v, c }: { v: VaultView; c: VaultChange }) {
  const roles = useRoles(v);
  const now = useNow(5000);
  const tx = useTx();
  const voted = useReadContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "hasVotedChange",
    args: [c.id, roles.address!],
    chainId: arcTestnet.id,
    query: { enabled: !!roles.address && !c.done },
  });
  const passed = c.eta > 0n;
  const ready = passed && !c.done && now >= Number(c.eta);
  const send = (functionName: string, label: string) => tx.send({ address: v.vault!, abi: vaultAbi, functionName, args: [c.id] }, label);
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-[var(--border)] p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="text-xs text-[var(--subtle)]">#{c.id.toString()}</span> <strong>{CHANGE_LABEL[c.kind]}</strong> {describe(c)}
        </span>
        <Badge tone={c.done ? "gray" : passed ? "amber" : "blue"}>{c.done ? "done" : passed ? (ready ? "ready" : `in ${formatDuration(Number(c.eta) - now)}`) : `${c.yes}/${fastTrackNeeded(c.voterCount)} votes`}</Badge>
      </div>
      {!c.done && roles.isWallet && (
        <div className="flex flex-wrap gap-2">
          {!passed && voted.data === false && (
            <Button variant="secondary" onClick={() => send("voteChange", "Vote for change")} disabled={tx.busy}>
              Vote yes
            </Button>
          )}
          {!passed && (
            <Button variant="ghost" onClick={() => send("cancelChange", "Cancel change")} disabled={tx.busy}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {ready && (
        <Button onClick={() => send("executeChange", "Execute change")} disabled={tx.busy}>
          Execute
        </Button>
      )}
      <TxStatus state={tx.state} />
    </li>
  );
}

export function PendingChanges({ v, compact }: { v: VaultView; compact?: boolean }) {
  const list = compact ? v.changes.filter((c) => !c.done) : v.changes;
  if (!list.length) return <p className="text-sm text-[var(--subtle)]">No settings changes.</p>;
  return (
    <ul className="flex flex-col gap-2">
      {list.map((c) => (
        <ChangeRow key={c.id.toString()} v={v} c={c} />
      ))}
    </ul>
  );
}

/** Loosening needs a majority + timelock; tightening is one wallet, instantly. */
export function SettingsCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const tx = useTx();
  const s = v.s!;
  const [kind, setKind] = useState<number>(CHANGE.BUDGET);
  const [b24, setB24] = useState("");
  const [b7, setB7] = useState("");
  const [cap, setCap] = useState("");
  const [floorMin, setFloorMin] = useState("");
  const [maxH, setMaxH] = useState("");
  const [capH, setCapH] = useState("");
  const [target, setTarget] = useState("");
  const num = (x: string, d: number) => (x.trim() ? Number(x) : d);

  const budgetArgs = [b24 ? parseUsd(b24) : s.budget24h, b7 ? parseUsd(b7) : s.budget7d] as const;
  const limitArgs = [cap ? parseUsd(cap) : s.hardCap, Math.round(num(floorMin, s.floorDelay / 60) * 60), Math.round(num(maxH, s.maxDelay / 3600) * 3600), Math.round(num(capH, s.capDelay / 3600) * 3600)] as const;
  const tighterBudget = budgetArgs[0] <= s.budget24h && budgetArgs[1] <= s.budget7d;
  const tighterLimits = limitArgs[0] <= s.hardCap && limitArgs[1] >= s.floorDelay && limitArgs[2] >= s.maxDelay && limitArgs[3] >= s.capDelay;
  const addrKind = kind === CHANGE.ADD_DESTINATION || kind === CHANGE.ADD_DELEGATE || kind === CHANGE.RECOVERY_VAULT || kind === CHANGE.RECOVERY_KEY;

  async function go() {
    if (!v.vault) return;
    if (kind === CHANGE.BUDGET && tighterBudget) return tx.send({ address: v.vault, abi: vaultAbi, functionName: "lowerBudget", args: budgetArgs }, "Lower budget");
    if (kind === CHANGE.LIMITS && tighterLimits) return tx.send({ address: v.vault, abi: vaultAbi, functionName: "tightenLimits", args: limitArgs }, "Tighten limits");
    const data =
      kind === CHANGE.BUDGET ? encodeAbiParameters(budget, budgetArgs) : kind === CHANGE.LIMITS ? encodeAbiParameters(limits, limitArgs) : addrKind ? encodeAbiParameters(addr, [target as Address]) : "0x";
    return tx.send({ address: v.vault, abi: vaultAbi, functionName: "proposeChange", args: [kind, data] }, `Propose ${CHANGE_LABEL[kind]}`);
  }
  const instant = (kind === CHANGE.BUDGET && tighterBudget) || (kind === CHANGE.LIMITS && tighterLimits);

  return (
    <Card title="Settings">
      <PendingChanges v={v} />
      {roles.isWallet && (
        <div className="mt-4 flex flex-col gap-3 border-t border-[var(--border)] pt-4">
          <Field label="Change">
            <Select value={kind} onChange={(e) => setKind(Number(e.target.value))}>
              {[CHANGE.BUDGET, CHANGE.LIMITS, CHANGE.ADD_DESTINATION, CHANGE.ADD_DELEGATE, CHANGE.RECOVERY_VAULT, CHANGE.RECOVERY_KEY].map((k) => (
                <option key={k} value={k}>
                  {CHANGE_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          {kind === CHANGE.BUDGET && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="24h budget (USDC)">
                <Input value={b24} onChange={(e) => setB24(e.target.value)} placeholder={formatUsd(s.budget24h)} />
              </Field>
              <Field label="7d budget (USDC)">
                <Input value={b7} onChange={(e) => setB7(e.target.value)} placeholder={formatUsd(s.budget7d)} />
              </Field>
            </div>
          )}
          {kind === CHANGE.LIMITS && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Hard cap (USDC)">
                <Input value={cap} onChange={(e) => setCap(e.target.value)} placeholder={formatUsd(s.hardCap)} />
              </Field>
              <Field label="Floor (min)">
                <Input value={floorMin} onChange={(e) => setFloorMin(e.target.value)} placeholder={String(s.floorDelay / 60)} />
              </Field>
              <Field label="MaxDelay (h)">
                <Input value={maxH} onChange={(e) => setMaxH(e.target.value)} placeholder={String(s.maxDelay / 3600)} />
              </Field>
              <Field label="CapDelay (h)">
                <Input value={capH} onChange={(e) => setCapH(e.target.value)} placeholder={String(s.capDelay / 3600)} />
              </Field>
            </div>
          )}
          {addrKind && (
            <Field label="Address">
              <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0x…" />
            </Field>
          )}
          <Button onClick={go} disabled={tx.busy || (addrKind && !isAddress(target))}>
            {instant ? "Apply now (tightening)" : `Propose (majority, then ${formatDuration(CHANGE_TIMELOCK[kind])})`}
          </Button>
          <TxStatus state={tx.state} />
        </div>
      )}
    </Card>
  );
}

/** Any one wallet can freeze; unfreezing takes a majority or the Recovery key. */
export function FreezeCard({ v }: { v: VaultView }) {
  const roles = useRoles(v);
  const tx = useTx();
  if (!roles.isWallet) return null;
  return (
    <Card title="Emergency" tone="danger">
      <Notice tone="red">Saw something you didn&apos;t do? Freeze stops every outflow and pool swap at once. Unfreezing needs a majority of wallets or the Recovery key.</Notice>
      <Button className="mt-3" variant="danger" disabled={tx.busy} onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "freeze" }, "Freeze")}>
        Freeze Vault
      </Button>
      <TxStatus state={tx.state} />
    </Card>
  );
}
