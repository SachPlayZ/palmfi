"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { isAddress, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { hubAbi, vaultFactoryAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";
import { DEMO_DEFAULTS, MIN_WALLETS, isValidName, parseUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import { TelegramLink } from "./telegram-link";
import { Badge, Button, Card, Field, Input, Mono, Notice } from "./ui";

function addrList(s: string): Address[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean) as Address[];
}

export function OnboardForm() {
  const { address } = useAccount();
  const [name, setName] = useState("");
  const [walletsIn, setWalletsIn] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveryVault, setRecoveryVault] = useState("");
  const [destinations, setDestinations] = useState("");
  const [b24, setB24] = useState(DEMO_DEFAULTS.budget24h);
  const [b7, setB7] = useState(DEMO_DEFAULTS.budget7d);
  const [cap, setCap] = useState(DEMO_DEFAULTS.hardCap);
  const [floorMin, setFloorMin] = useState(DEMO_DEFAULTS.floorMinutes);
  const [maxH, setMaxH] = useState(DEMO_DEFAULTS.maxDelayHours);
  const [capH, setCapH] = useState(DEMO_DEFAULTS.capDelayHours);
  const [bizStart, setBizStart] = useState("9");
  const [bizEnd, setBizEnd] = useState("17");
  const [usualMax, setUsualMax] = useState(DEMO_DEFAULTS.usualMaxPayout);
  const tx = useTx();

  const wallets = useMemo(() => {
    const l = addrList(walletsIn);
    return address && !l.some((a) => a.toLowerCase() === address.toLowerCase()) ? [address, ...l] : l;
  }, [walletsIn, address]);

  const taken = useReadContract({
    address: deployments.hub,
    abi: hubAbi,
    functionName: "resolve",
    args: [name],
    chainId: arcTestnet.id,
    query: { enabled: isValidName(name) && !!deployments.hub, refetchInterval: tx.state.status === "done" ? 4000 : false },
  });
  const created = taken.data && taken.data !== zeroAddress ? (taken.data as Address) : undefined;

  const errors: string[] = [];
  if (!isValidName(name)) errors.push("Choose a name: lowercase letters, digits and hyphens");
  if (!address) errors.push("Connect your wallet");
  if (wallets.length < MIN_WALLETS || !wallets.every((a) => isAddress(a)) || new Set(wallets.map((w) => w.toLowerCase())).size !== wallets.length)
    errors.push(`At least ${MIN_WALLETS} distinct wallets`);
  if (recoveryKey && !isAddress(recoveryKey)) errors.push("Recovery key must be an address");
  if (!isAddress(recoveryVault)) errors.push("Recovery vault address");
  if (addrList(destinations).some((a) => !isAddress(a))) errors.push("Destinations must be addresses");
  if (Number(floorMin) * 60 > Number(capH) * 3600) errors.push("Floor must not exceed CapDelay");
  const warnings: string[] = [];
  if (recoveryKey && wallets.some((w) => w.toLowerCase() === recoveryKey.toLowerCase())) warnings.push("The Recovery key should be a separate cold key, not one of the wallets.");

  async function submit() {
    if (errors.length || !deployments.factory) return;
    const cfg = {
      wallets,
      recoveryKey: (recoveryKey || zeroAddress) as Address,
      recoveryVault: recoveryVault as Address,
      budget24h: parseUsd(b24),
      budget7d: parseUsd(b7),
      hardCap: parseUsd(cap),
      floorDelay: Math.round(Number(floorMin) * 60),
      maxDelay: Math.round(Number(maxH) * 3600),
      capDelay: Math.round(Number(capH) * 3600),
      destinations: addrList(destinations),
      bizStartHourUtc: Number(bizStart),
      bizEndHourUtc: Number(bizEnd),
      usualMaxPayout: parseUsd(usualMax),
    };
    await tx.send({ address: deployments.factory, abi: vaultFactoryAbi, functionName: "createVault", args: [name, cfg] }, "Create Vault");
  }

  const done = tx.state.status === "done" && created;

  return (
    <div className="flex flex-col gap-5">
      <Card title="Name">
        <Field label="Vault name" hint="Other orgs pay you by this name through the Hub directory">
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="nvidia" className="flex-1" />
            {isValidName(name) && taken.isSuccess && !done && (created ? <Badge tone="red">taken</Badge> : <Badge tone="green">available</Badge>)}
          </div>
        </Field>
      </Card>

      <Card title="Wallets and recovery">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`Wallets (≥ ${MIN_WALLETS})`} hint="Your connected wallet plus the others, comma or space separated. Each is a Voter; the first receives payments.">
            <Input value={walletsIn} onChange={(e) => setWalletsIn(e.target.value)} placeholder="0x…, 0x…" />
          </Field>
          <Field label="Recovery vault" hint="Fixed now: the only place a migration can send funds">
            <Input value={recoveryVault} onChange={(e) => setRecoveryVault(e.target.value)} placeholder="0x…" />
          </Field>
          <Field label="Recovery key (optional)" hint="A cold key that can only unfreeze or migrate">
            <Input value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="0x…" />
          </Field>
          <Field label="Known destinations" hint="Regular payees: scored as familiar from day one">
            <Input value={destinations} onChange={(e) => setDestinations(e.target.value)} placeholder="0x…, 0x…" />
          </Field>
        </div>
        {wallets.length > 0 && (
          <ul className="mt-3 flex flex-col gap-0.5 text-xs text-[var(--subtle)]">
            {wallets.map((w) => (
              <li key={w}>
                <Mono>{w}</Mono>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Limits and profile">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Instant budget, 24h (USDC)">
            <Input inputMode="decimal" value={b24} onChange={(e) => setB24(e.target.value)} />
          </Field>
          <Field label="Instant budget, 7d (USDC)">
            <Input inputMode="decimal" value={b7} onChange={(e) => setB7(e.target.value)} />
          </Field>
          <Field label="Hard cap (USDC)" hint="Above this: at least CapDelay unless a majority fast-tracks">
            <Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Field label="Floor (minutes)" hint="Shortest wait for any request">
            <Input inputMode="decimal" value={floorMin} onChange={(e) => setFloorMin(e.target.value)} />
          </Field>
          <Field label="MaxDelay (hours)" hint="Wait when the Sentinel is silent">
            <Input inputMode="decimal" value={maxH} onChange={(e) => setMaxH(e.target.value)} />
          </Field>
          <Field label="CapDelay (hours)">
            <Input inputMode="decimal" value={capH} onChange={(e) => setCapH(e.target.value)} />
          </Field>
          <Field label="Business hours start (UTC)">
            <Input inputMode="numeric" value={bizStart} onChange={(e) => setBizStart(e.target.value)} />
          </Field>
          <Field label="Business hours end (UTC)">
            <Input inputMode="numeric" value={bizEnd} onChange={(e) => setBizEnd(e.target.value)} />
          </Field>
          <Field label="Usual max payout (USDC)" hint="Cold-start baseline for the amount term">
            <Input inputMode="decimal" value={usualMax} onChange={(e) => setUsualMax(e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card>
        {warnings.map((w) => (
          <Notice key={w} tone="amber">
            {w}
          </Notice>
        ))}
        {errors.length > 0 && !done && <p className="mb-2 text-sm text-[var(--subtle)]">Still needed: {errors.join(" · ")}</p>}
        {done ? (
          <div className="flex flex-col gap-3">
            <Notice tone="green">
              {name} is live: Vault <Mono>{created}</Mono>, with its own token in the Orbital pool.
            </Notice>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={`/vault/${name}`}>
                <Button>Open dashboard</Button>
              </Link>
              <TelegramLink vault={created!} />
            </div>
          </div>
        ) : (
          <Button onClick={submit} disabled={errors.length > 0 || tx.busy || !deployments.factory || !!created}>
            Create Vault
          </Button>
        )}
        <TxStatus state={tx.state} />
      </Card>
    </div>
  );
}
