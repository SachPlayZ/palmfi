"use client";

import Link from "next/link";
import { useState } from "react";
import { parseAbiItem, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { sepolia } from "wagmi/chains";
import { networkRegistryAbi, vaultAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { useEventLogs } from "@/lib/logs";
import { STATUS, decodeReasonCodes, formatDuration } from "@/lib/palm";
import { isOpen } from "@/lib/requests";
import { TxStatus, useTx } from "@/lib/tx";
import type { VaultView } from "@/lib/vault";
import { signWithPasskey } from "@/lib/webauthn";
import { Badge, Button, Card, Mono, Notice, short } from "../ui";
import { VaultGate } from "./dashboard";
import { VaultHeader } from "./header";
import { useNow, useRoles } from "./common";

const frozenEv = parseAbiItem("event Frozen(address indexed vault, uint256 reasonCodes)");
const flaggedEv = parseAbiItem("event Flagged(address indexed vault, uint256 indexed requestId, uint256 reasonCodes, address destination)");
const unfrozenEv = parseAbiItem("event Unfrozen(address indexed vault)");
const blocklistedEv = parseAbiItem("event Blocklisted(address indexed account, address indexed sourceVault, uint64 until)");

function ReasonList({ bitmap }: { bitmap: bigint }) {
  const codes = decodeReasonCodes(bitmap);
  if (!codes.length) return <span className="text-xs text-[var(--subtle)]">no reason codes</span>;
  return (
    <ul className="flex flex-col gap-1">
      {codes.map((c) => (
        <li key={c.code} className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="red">{c.code}</Badge>
          <span className="text-[var(--subtle)]">{c.description}</span>
        </li>
      ))}
    </ul>
  );
}

function IncidentBody({ v }: { v: VaultView }) {
  const s = v.s!;
  const roles = useRoles(v);
  const now = useNow(5000);
  const tx = useTx();
  const [err, setErr] = useState<string>();
  const frozen = useEventLogs("frozen", { address: deployments.hub, event: frozenEv, args: { vault: v.vault } });
  const flagged = useEventLogs("flagged", { address: deployments.hub, event: flaggedEv, args: { vault: v.vault } });
  const unfrozen = useEventLogs("unfrozen", { address: deployments.hub, event: unfrozenEv, args: { vault: v.vault } });
  const blocked = useEventLogs("blocklisted", { address: deployments.registry, event: blocklistedEv, args: { sourceVault: v.vault } });
  const networkBlocked = useEventLogs("blocklisted-all", { address: deployments.registry, event: blocklistedEv });
  const blockedAccounts = (blocked.data ?? []).map((l) => l.args.account as Address);
  const stillBlocked = useReadContracts({
    allowFailure: true,
    contracts: blockedAccounts.map((a) => ({ address: deployments.registry, abi: networkRegistryAbi, functionName: "isBlocked", args: [a], chainId: sepolia.id }) as const),
    query: { enabled: blockedAccounts.length > 0 },
  });

  const latestFreeze = frozen.data?.[0];
  const isFrozen = v.status === STATUS.FROZEN;
  const openReqs = v.requests.filter((r) => isOpen(r.state));

  async function unfreeze() {
    setErr(undefined);
    try {
      let sig: `0x${string}` = "0x";
      if (!s.institution) sig = await signWithPasskey(s.unfreezeChallenge, { x: s.passkeyX, y: s.passkeyY });
      await tx.send({ address: v.vault!, abi: vaultAbi, functionName: "unfreeze", args: [sig] }, "Unfreeze");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <VaultHeader v={v} />
      <Card title={isFrozen ? "Freeze" : "Incident history"} tone={isFrozen ? "danger" : undefined}>
        {isFrozen ? (
          <p className="mb-3 text-sm">
            Every outflow is stopped: instant unwraps, Uniswap unwraps, Queued request execution, outgoing Network transfers and Safe-harbor swaps.
            Deposits and incoming Network transfers still arrive.
          </p>
        ) : (
          <p className="mb-3 text-sm text-[var(--subtle)]">This Vault is not Frozen right now.</p>
        )}
        {frozen.isLoading && <p className="text-sm text-[var(--subtle)]">Reading Hub events…</p>}
        {latestFreeze && (
          <div className="mb-3 flex flex-col gap-2">
            <p className="text-sm font-medium">
              Last Freeze at block {latestFreeze.blockNumber?.toString()}{" "}
              <a className="text-xs underline" href={`https://sepolia.etherscan.io/tx/${latestFreeze.transactionHash}`} target="_blank" rel="noreferrer">
                tx
              </a>
            </p>
            <ReasonList bitmap={latestFreeze.args.reasonCodes ?? 0n} />
          </div>
        )}
        {(flagged.data?.length ?? 0) > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">FLAGs</h3>
            {flagged.data!.map((l) => (
              <div key={`${l.transactionHash}-${l.logIndex}`} className="rounded-lg border border-red-500/40 p-2">
                <p className="text-sm">
                  {l.args.requestId ? `Queued request #${l.args.requestId.toString()}` : "Reconciler FLAG (delegation / reserves)"}
                  {l.args.destination && l.args.destination !== "0x0000000000000000000000000000000000000000" && (
                    <>
                      {" "}
                      to <Mono>{l.args.destination}</Mono>
                    </>
                  )}
                </p>
                <ReasonList bitmap={l.args.reasonCodes ?? 0n} />
              </div>
            ))}
          </div>
        )}
        {(unfrozen.data?.length ?? 0) > 0 && <p className="mt-2 text-xs text-[var(--subtle)]">Unfrozen {unfrozen.data!.length} time(s) before.</p>}
      </Card>

      <Card title="Blocklist additions">
        {blockedAccounts.length === 0 ? (
          <p className="text-sm text-[var(--subtle)]">No addresses were added to the network Blocklist from this Vault&apos;s incidents.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {blocked.data!.map((l, i) => (
              <li key={`${l.transactionHash}-${l.logIndex}`} className="flex flex-wrap items-center gap-2 text-sm">
                <Mono>{l.args.account}</Mono>
                {stillBlocked.data?.[i]?.result ? <Badge tone="red">blocked</Badge> : <Badge>expired / removed</Badge>}
                <span className="text-xs text-[var(--subtle)]">until {new Date(Number(l.args.until) * 1000).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        {(networkBlocked.data?.length ?? 0) > 0 && (
          <p className="mt-2 text-xs text-[var(--subtle)]">
            Network-wide: {networkBlocked.data!.length} Blocklist addition(s); every Vault refuses them as destinations.
          </p>
        )}
      </Card>

      <Card title="Recovery options">
        <div className="flex flex-col gap-4">
          <section>
            <h3 className="text-sm font-semibold">Recovery key {roles.isRecovery && <Badge tone="green">connected</Badge>}</h3>
            <p className="mb-2 text-xs text-[var(--subtle)]">
              <Mono>{s.recoveryKey}</Mono>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={unfreeze} disabled={!roles.isRecovery || !isFrozen || tx.busy}>
                {s.institution ? "Unfreeze" : "Unfreeze (Recovery key + Face ID)"}
              </Button>
              <Button variant="danger" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "migrate" }, "Migrate")} disabled={!roles.isRecovery || tx.busy || v.status === STATUS.MIGRATED}>
                Migrate everything to Recovery vault
              </Button>
              {s.paused && (
                <Button variant="secondary" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "unpause" }, "Unpause")} disabled={!roles.isRecovery || tx.busy}>
                  Unpause
                </Button>
              )}
            </div>
            <p className="mt-1 text-xs text-[var(--subtle)]">
              Recovery vault (fixed at onboarding): <Mono>{s.recoveryVault}</Mono>. Use Unfreeze for a false positive; Migrate if a key is compromised, then reissue
              the name onto a fresh Vault with new Hot wallets.
            </p>
          </section>
          <section>
            <h3 className="text-sm font-semibold">Guardian {roles.isGuardian && <Badge tone="green">connected</Badge>}</h3>
            <p className="mb-2 text-xs text-[var(--subtle)]">
              <Mono>{s.guardian === "0x0000000000000000000000000000000000000000" ? "none set" : s.guardian}</Mono> · can only cancel, pause, or evacuate to the
              Recovery vault.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "pause" }, "Pause")} disabled={!(roles.isGuardian || roles.isRecovery || roles.isHot) || s.paused || tx.busy}>
                Pause Vault
              </Button>
              <Button variant="danger" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "evacuate" }, "Guardian evacuate")} disabled={!roles.isGuardian || tx.busy || v.status === STATUS.MIGRATED}>
                Evacuate to Recovery vault
              </Button>
            </div>
          </section>
          {openReqs.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold">Open Queued requests</h3>
              <ul className="mt-1 flex flex-col gap-1">
                {openReqs.map((r) => (
                  <li key={r.id.toString()} className="flex flex-wrap items-center gap-2 text-sm">
                    #{r.id.toString()} to <Mono>{short(r.destination)}</Mono>
                    <span className="text-xs text-[var(--subtle)]">expires in {formatDuration(Number(r.createdAt) + 7 * 86400 - now)}</span>
                    <Button variant="ghost" onClick={() => tx.send({ address: v.vault!, abi: vaultAbi, functionName: "cancel", args: [r.id] }, "Cancel request")} disabled={!(roles.isGuardian || roles.isRecovery || roles.isHot) || tx.busy}>
                      Cancel
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {s.institution && (
            <Notice tone="gray">
              If this Institution can&apos;t act, other Members can Vote to extend the Freeze or migrate it to its own Recovery vault. Votes can never choose a destination.
            </Notice>
          )}
          {err && <p className="text-xs text-red-600">{err}</p>}
          <TxStatus state={tx.state} />
        </div>
      </Card>
      <Link href={`/vault/${v.vault}`} className="text-sm underline">
        Back to dashboard
      </Link>
    </>
  );
}

export function IncidentView({ id }: { id: string }) {
  return <VaultGate id={id}>{(v) => <IncidentBody v={v} />}</VaultGate>;
}
