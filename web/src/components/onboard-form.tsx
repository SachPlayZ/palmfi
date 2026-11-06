"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { isAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { sepolia } from "wagmi/chains";
import { vaultFactoryAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { network } from "@/lib/network";
import { DEMO_DEFAULTS, ONBOARDING_FEE_WEI, isValidLabel, parseUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import { createPasskey, webAuthnSupported } from "@/lib/webauthn";
import { TelegramLink } from "./telegram-link";
import { Badge, Button, Card, Field, Input, Mono, Notice } from "./ui";

function addrList(s: string): Address[] {
  return s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean) as Address[];
}

export function OnboardForm({ mode }: { mode: "individual" | "institution" }) {
  const inst = mode === "institution";
  const { address } = useAccount();
  const [label, setLabel] = useState("");
  const [ownerIn, setOwnerIn] = useState("");
  const [hot, setHot] = useState("");
  const [guardian, setGuardian] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [recoveryVault, setRecoveryVault] = useState("");
  const [approver, setApprover] = useState("");
  const [destinations, setDestinations] = useState("");
  const [b24, setB24] = useState(inst ? "25" : DEMO_DEFAULTS.budget24h);
  const [b7, setB7] = useState(inst ? "100" : DEMO_DEFAULTS.budget7d);
  const [cap, setCap] = useState(inst ? "200" : DEMO_DEFAULTS.hardCap);
  const [floorMin, setFloorMin] = useState(DEMO_DEFAULTS.floorMinutes);
  const [fullH, setFullH] = useState(DEMO_DEFAULTS.fullDelayHours);
  const [bizStart, setBizStart] = useState("8");
  const [bizEnd, setBizEnd] = useState("18");
  const [usualMax, setUsualMax] = useState("50");
  const [passkey, setPasskey] = useState<{ x: Hex; y: Hex }>();
  const [pkMsg, setPkMsg] = useState<string>();
  const tx = useTx();

  const owner = (inst ? ownerIn : address) as Address | undefined;
  const hotWallets = useMemo(() => {
    const l = addrList(hot);
    return l.length ? l : address && !inst ? [address] : [];
  }, [hot, address, inst]);

  const taken = useReadContract({
    address: deployments.factory,
    abi: vaultFactoryAbi,
    functionName: "vaultOf",
    args: [label],
    chainId: sepolia.id,
    query: { enabled: isValidLabel(label) && !!deployments.factory, refetchInterval: tx.state.status === "done" ? 4000 : false },
  });
  const created = taken.data && taken.data !== zeroAddress ? (taken.data as Address) : undefined;

  const errors: string[] = [];
  if (!isValidLabel(label)) errors.push("Choose a name: lowercase letters, digits and hyphens");
  if (!owner || !isAddress(owner)) errors.push(inst ? "Owner (Member key) address" : "Connect your wallet");
  if (!hotWallets.length || !hotWallets.every((a) => isAddress(a))) errors.push("At least one valid Hot wallet");
  if (guardian && !isAddress(guardian)) errors.push("Guardian must be an address");
  if (!isAddress(recoveryKey)) errors.push("Recovery key address");
  if (!isAddress(recoveryVault)) errors.push("Recovery vault address");
  if (inst && !isAddress(approver)) errors.push("Approver address");
  if (!inst && !passkey) errors.push("Create your passkey");
  if (addrList(destinations).some((a) => !isAddress(a))) errors.push("Destinations must be addresses");
  const warnings: string[] = [];
  if (recoveryKey && owner && recoveryKey.toLowerCase() === owner.toLowerCase()) warnings.push("Your Recovery key should be a separate cold key, not your everyday wallet.");
  if (recoveryKey && hotWallets.some((h) => h.toLowerCase() === recoveryKey.toLowerCase())) warnings.push("The Recovery key is also a Hot wallet: a thief with that key could loosen settings.");
  if (inst && approver && hotWallets.some((h) => h.toLowerCase() === approver.toLowerCase())) warnings.push("The Approver should be kept apart from the Hot wallets.");

  async function makePasskey() {
    setPkMsg(undefined);
    try {
      const pk = await createPasskey(label || "vault");
      setPasskey({ x: pk.x, y: pk.y });
      setPkMsg("Passkey created on this device.");
    } catch (e) {
      setPkMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit() {
    if (errors.length || !deployments.factory || !owner) return;
    const cfg = {
      owner,
      hotWallets,
      defaultReceiver: hotWallets[0],
      guardian: (guardian || zeroAddress) as Address,
      recoveryKey: recoveryKey as Address,
      recoveryVault: recoveryVault as Address,
      approver: (inst ? approver : zeroAddress) as Address,
      passkeyX: inst ? zeroHash : passkey!.x,
      passkeyY: inst ? zeroHash : passkey!.y,
      budget24h: parseUsd(b24),
      budget7d: parseUsd(b7),
      hardCap: parseUsd(cap),
      floorDelay: Math.round(Number(floorMin) * 60),
      fullDelay: Math.round(Number(fullH) * 3600),
      destinations: addrList(destinations),
      bizStartHourUtc: inst ? Number(bizStart) : 0,
      bizEndHourUtc: inst ? Number(bizEnd) : 0,
      usualMaxPayout: inst ? parseUsd(usualMax) : 0n,
    };
    await tx.send(
      {
        address: deployments.factory,
        abi: vaultFactoryAbi,
        functionName: inst ? "onboardInstitution" : "createVault",
        args: [label, cfg],
        value: ONBOARDING_FEE_WEI,
      },
      inst ? "Onboard Institution" : "Create Vault",
    );
  }

  const done = tx.state.status === "done" && created;

  return (
    <div className="flex flex-col gap-5">
      <Card title="Name">
        <Field label="Vault name" hint={`People pay you at ${label || "name"}.${network.ensParent}`}>
          <div className="flex items-center gap-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} placeholder={inst ? "nvidia" : "alice"} className="flex-1" />
            <span className="text-sm text-[var(--subtle)]">.{network.ensParent}</span>
            {isValidLabel(label) && taken.isSuccess && !done && (created ? <Badge tone="red">taken</Badge> : <Badge tone="green">available</Badge>)}
          </div>
        </Field>
      </Card>

      <Card title="Keys and roles">
        <div className="grid gap-3 sm:grid-cols-2">
          {inst ? (
            <Field label="Owner (Member key)" hint="Profile controller and the Institution's voting key">
              <Input value={ownerIn} onChange={(e) => setOwnerIn(e.target.value)} placeholder="0x…" />
            </Field>
          ) : (
            <Field label="Owner" hint="Your connected wallet creates and controls the profile">
              <Input value={address ?? ""} readOnly placeholder="connect your wallet" />
            </Field>
          )}
          <Field label="Hot wallets" hint={inst ? "Treasury spending keys, comma or space separated; first one receives incoming payments" : "Defaults to your connected wallet; first one receives incoming payments"}>
            <Input value={hot} onChange={(e) => setHot(e.target.value)} placeholder={address ?? "0x…, 0x…"} />
          </Field>
          <Field label="Guardian" hint="Can only cancel, pause, or evacuate to your Recovery vault (e.g. a friend or a multisig)">
            <Input value={guardian} onChange={(e) => setGuardian(e.target.value)} placeholder="0x… (optional)" />
          </Field>
          <Field label="Recovery key" hint="A cold key (hardware wallet): the only key that can unfreeze, migrate or loosen settings">
            <Input value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="0x…" />
          </Field>
          <Field label="Recovery vault" hint="Fixed now: the only place funds can ever be rescued to">
            <Input value={recoveryVault} onChange={(e) => setRecoveryVault(e.target.value)} placeholder="0x…" />
          </Field>
          {inst && (
            <Field label="Approver" hint="Payout approval key, held on separate infrastructure from the Hot wallets">
              <Input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="0x…" />
            </Field>
          )}
        </div>
      </Card>

      <Card title="Limits">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Instant budget, 24h (USD)">
            <Input inputMode="decimal" value={b24} onChange={(e) => setB24(e.target.value)} />
          </Field>
          <Field label="Instant budget, 7d (USD)">
            <Input inputMode="decimal" value={b7} onChange={(e) => setB7(e.target.value)} />
          </Field>
          <Field label="Hard cap (USD)" hint="Above this a CLEAR also needs your Second factor">
            <Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Field label="Floor (minutes)" hint="Shortest wait for any Queued request">
            <Input inputMode="decimal" value={floorMin} onChange={(e) => setFloorMin(e.target.value)} />
          </Field>
          <Field label="Full delay (hours)" hint="Wait above the Hard cap without a Second factor">
            <Input inputMode="decimal" value={fullH} onChange={(e) => setFullH(e.target.value)} />
          </Field>
          <Field label="Known destinations" hint="Optional allowlist; others are scored NEW_DESTINATION">
            <Input value={destinations} onChange={(e) => setDestinations(e.target.value)} placeholder="0x…, 0x…" />
          </Field>
        </div>
        {inst && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Business hours start (UTC)">
              <Input inputMode="numeric" value={bizStart} onChange={(e) => setBizStart(e.target.value)} />
            </Field>
            <Field label="Business hours end (UTC)">
              <Input inputMode="numeric" value={bizEnd} onChange={(e) => setBizEnd(e.target.value)} />
            </Field>
            <Field label="Usual max payout (USD)">
              <Input inputMode="decimal" value={usualMax} onChange={(e) => setUsualMax(e.target.value)} />
            </Field>
          </div>
        )}
      </Card>

      {!inst && (
        <Card title="Second factor: passkey">
          <p className="mb-3 text-sm text-[var(--subtle)]">
            Large requests need Face ID / Touch ID on this device. Laptop malware can steal a wallet key; it can&apos;t produce this.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant={passkey ? "secondary" : "primary"} onClick={makePasskey} disabled={!webAuthnSupported()}>
              {passkey ? "Replace passkey" : "Create passkey"}
            </Button>
            {passkey && <Badge tone="green">P-256 key ready</Badge>}
          </div>
          {passkey && (
            <p className="mt-2 text-xs text-[var(--subtle)]">
              x <Mono>{passkey.x}</Mono>
              <br />y <Mono>{passkey.y}</Mono>
            </p>
          )}
          {pkMsg && <p className="mt-2 text-xs">{pkMsg}</p>}
        </Card>
      )}

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
              {label}.{network.ensParent} is live: Vault <Mono>{created}</Mono>
            </Notice>
            <div className="flex flex-wrap items-center gap-3">
              <Link href={`/vault/${created}`}>
                <Button>Open dashboard</Button>
              </Link>
              {!inst && <TelegramLink vault={created!} />}
            </div>
          </div>
        ) : (
          <Button onClick={submit} disabled={errors.length > 0 || tx.busy || !deployments.factory || !!created}>
            {inst ? "Onboard Institution (0.001 ETH fee)" : "Create my Vault (0.001 ETH fee)"}
          </Button>
        )}
        <TxStatus state={tx.state} />
      </Card>
    </div>
  );
}
