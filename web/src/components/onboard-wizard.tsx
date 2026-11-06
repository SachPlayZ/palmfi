"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { isAddress, zeroAddress, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { hubAbi, vaultFactoryAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";
import { DEMO_DEFAULTS, MIN_WALLETS, formatDuration, isValidName, parseUsd } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { AddressChip, CopyButton, HillsBand, OrgCard, PageHead, Steps, useOrigin } from "./brand";
import { TelegramLink } from "./telegram-link";
import { Badge, Button, Field, Input, Notice } from "./ui";

const STEP_LABELS = ["Name", "Voters", "Recovery", "Limits", "Profile", "Review"];

const PRESETS = [
  {
    k: "team",
    label: "Small team",
    d: "Payroll and vendors for a team of a few dozen.",
    b24: "500",
    b7: "2000",
    cap: "5000",
    floor: "15",
    max: "72",
    capH: "24",
    usual: "1500",
  },
  {
    k: "treasury",
    label: "Treasury",
    d: "Larger balances, fewer and bigger payments.",
    b24: "5000",
    b7: "20000",
    cap: "50000",
    floor: "15",
    max: "72",
    capH: "24",
    usual: "15000",
  },
  {
    k: "demo",
    label: "Testnet demo",
    d: "Faucet-sized amounts so you can try every lane.",
    b24: DEMO_DEFAULTS.budget24h,
    b7: DEMO_DEFAULTS.budget7d,
    cap: DEMO_DEFAULTS.hardCap,
    floor: DEMO_DEFAULTS.floorMinutes,
    max: DEMO_DEFAULTS.maxDelayHours,
    capH: DEMO_DEFAULTS.capDelayHours,
    usual: DEMO_DEFAULTS.usualMaxPayout,
  },
] as const;

const split = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const eqA = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function AddressList({ list, setList, locked, placeholder }: { list: string[]; setList: (l: string[]) => void; locked?: string; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string>();
  function add(raw: string) {
    const items = split(raw);
    if (!items.length) return;
    const bad = items.filter((x) => !isAddress(x));
    const next = [...list];
    for (const x of items) if (isAddress(x) && !next.some((y) => eqA(x, y))) next.push(x);
    setList(next);
    setErr(bad.length ? `${bad.length} entr${bad.length === 1 ? "y isn't an" : "ies aren't"} address${bad.length === 1 ? "" : "es"}` : undefined);
    setDraft(bad.join(" "));
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {list.map((a, i) => (
          <li
            key={a}
            className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--paper-2)] py-2 pr-2 pl-4"
            style={{ animation: "pf-fade .5s var(--ease) both" }}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="pf-mono pf-dim w-5">{String(i + 1).padStart(2, "0")}</span>
              <span className="truncate font-mono text-[13px]">{a}</span>
              {locked && eqA(a, locked) && <Badge tone="forest">you</Badge>}
            </span>
            {!(locked && eqA(a, locked)) && (
              <button type="button" className="pf-btn ghost sm" onClick={() => setList(list.filter((x) => x !== a))} aria-label={`Remove ${a}`}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Input
          mono
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (split(t).length > 1) {
              e.preventDefault();
              add(t);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add(draft);
            }
          }}
          bad={!!err}
        />
        <button type="button" className="pf-btn line" onClick={() => add(draft)} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {err && <span className="text-[13px] text-[var(--red)]">{err}</span>}
    </div>
  );
}

function Choice({ on, onClick, title, body, children }: { on: boolean; onClick: () => void; title: string; body: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pf-card lift flex flex-col gap-2 text-left ${on ? "!border-[var(--ink)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--moss)_35%,transparent)]" : ""}`}
      aria-pressed={on}
    >
      <span className="flex items-center justify-between">
        <span className="text-[16px]">{title}</span>
        <span
          className={`h-4 w-4 rounded-full transition-all duration-300 ${on ? "bg-[var(--ink)] shadow-[inset_0_0_0_3px_#fff,0_0_0_1px_var(--ink)]" : "shadow-[inset_0_0_0_1px_var(--line)]"}`}
        />
      </span>
      <span className="text-[13.5px] text-[var(--subtle)]">{body}</span>
      {children}
    </button>
  );
}

/** Delay a request of `bits` would get with these limits (the Sentinel's doubling rule). */
function delayFor(bits: number, floorS: number, maxS: number) {
  const k = deployments.scoring.k / 1000;
  return Math.min(maxS, floorS * Math.pow(2, bits / k));
}

export function OnboardWizard() {
  const params = useSearchParams();
  const { address } = useAccount();
  const tx = useTx();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [name, setName] = useState((params.get("name") ?? "").toLowerCase());
  const [wallets, setWallets] = useState<string[]>([]);
  const [recoveryVault, setRecoveryVault] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [preset, setPreset] = useState<(typeof PRESETS)[number]["k"]>("demo");
  const p0 = PRESETS.find((p) => p.k === preset)!;
  const [lim, setLim] = useState({
    b24: p0.b24 as string,
    b7: p0.b7 as string,
    cap: p0.cap as string,
    floor: p0.floor as string,
    max: p0.max as string,
    capH: p0.capH as string,
  });
  const [custom, setCustom] = useState(false);
  const [biz, setBiz] = useState({ start: "9", end: "17" });
  const [usual, setUsual] = useState<string>(p0.usual);
  const [dests, setDests] = useState<string[]>([]);

  useEffect(() => {
    if (address && !wallets.some((w) => eqA(w, address))) setWallets((w) => [address, ...w]);
  }, [address, wallets]);
  useEffect(() => {
    const p = PRESETS.find((x) => x.k === preset)!;
    setLim({ b24: p.b24, b7: p.b7, cap: p.cap, floor: p.floor, max: p.max, capH: p.capH });
    setUsual(p.usual);
  }, [preset]);

  const taken = useReadContract({
    address: deployments.hub,
    abi: hubAbi,
    functionName: "resolve",
    args: [name],
    chainId: arcTestnet.id,
    query: { enabled: isValidName(name) && !!deployments.hub, refetchInterval: tx.state.status === "done" ? 3000 : false },
  });
  const owner = taken.data && taken.data !== zeroAddress ? (taken.data as Address) : undefined;
  const created = tx.state.status === "done" && owner;

  const floorS = Number(lim.floor) * 60;
  const maxS = Number(lim.max) * 3600;
  const capS = Number(lim.capH) * 3600;
  const errs: Record<number, string | undefined> = {
    0: !isValidName(name) ? "Lowercase letters, digits and hyphens, up to 32" : taken.isLoading ? "Checking…" : owner ? "That name is taken" : undefined,
    1: wallets.length < MIN_WALLETS ? `Add at least ${MIN_WALLETS} wallets (you have ${wallets.length})` : undefined,
    2: !isAddress(recoveryVault)
      ? "Set a recovery vault address"
      : recoveryKey && !isAddress(recoveryKey)
        ? "Recovery key must be an address"
        : wallets.some((w) => eqA(w, recoveryVault))
          ? "Use an address outside your hot wallets"
          : undefined,
    3: !(Number(lim.b24) > 0 && Number(lim.b7) >= Number(lim.b24) && Number(lim.cap) > 0)
      ? "Budgets must be positive and 7d ≥ 24h"
      : !(floorS <= capS && capS <= maxS && maxS <= 5 * 86400)
        ? "Need floor ≤ cap delay ≤ max delay ≤ 5 days"
        : undefined,
    4: !(Number(biz.start) >= 0 && Number(biz.end) <= 24 && Number(biz.start) < Number(biz.end))
      ? "Business hours must start before they end"
      : !(Number(usual) > 0)
        ? "Usual max payout must be positive"
        : undefined,
  };
  const ok = (s: number) => !errs[s];
  const go = (s: number) => {
    setDir(s > step ? 1 : -1);
    setStep(s);
  };
  const next = () => ok(step) && go(Math.min(5, step + 1));

  async function submit() {
    if (!deployments.factory || [0, 1, 2, 3, 4].some((s) => !ok(s))) return;
    const cfg = {
      wallets: wallets as Address[],
      recoveryKey: (recoveryKey || zeroAddress) as Address,
      recoveryVault: recoveryVault as Address,
      budget24h: parseUsd(lim.b24),
      budget7d: parseUsd(lim.b7),
      hardCap: parseUsd(lim.cap),
      floorDelay: Math.round(floorS),
      maxDelay: Math.round(maxS),
      capDelay: Math.round(capS),
      destinations: dests as Address[],
      bizStartHourUtc: Number(biz.start),
      bizEndHourUtc: Number(biz.end),
      usualMaxPayout: parseUsd(usual),
    };
    await tx.send({ address: deployments.factory, abi: vaultFactoryAbi, functionName: "createVault", args: [name, cfg] }, "Create vault");
  }

  if (created) return <Success name={name} vault={owner!} />;

  const examples = [
    { k: "Routine payroll", bits: 3 },
    { k: "Unusual amount, new address", bits: 12 },
    { k: "Large, 3am, fresh wallet", bits: deployments.scoring.sFlag / 1000 },
  ];

  const panes: ReactNode[] = [
    <div key="0" className="grid items-center gap-10 md:grid-cols-[1fr_auto]">
      <div className="flex flex-col gap-4">
        <h2 className="pf-h2">What should other orgs call you?</h2>
        <p className="pf-lede">Your name is how other orgs pay you, and how your team finds the vault. First come, first served.</p>
        <Input
          big
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
          placeholder="northwind"
          aria-label="Vault name"
          onKeyDown={(e) => e.key === "Enter" && next()}
        />
        <span className="flex h-6 items-center gap-2 text-[13px]">
          {isValidName(name) && taken.isSuccess && (owner ? <Badge tone="red">taken</Badge> : <Badge tone="green">available</Badge>)}
          {name && !isValidName(name) && <span className="text-[var(--red)]">Lowercase letters, digits and hyphens only</span>}
          {isValidName(name) && !owner && <span className="pf-dim">Your token will be {name}USDC</span>}
        </span>
      </div>
      <div className="hidden justify-center md:flex" key={name}>
        <span style={{ animation: "pf-pop .7s var(--ease) both" }}>
          <OrgCard name={name || "your-org"} width={190} tilt />
        </span>
      </div>
    </div>,
    <div key="1" className="flex flex-col gap-5">
      <h2 className="pf-h2">Who votes?</h2>
      <p className="pf-lede">
        {!address && (
          <span className="mb-2 block text-[14px] text-[var(--subtle)]">Connect your wallet to add it automatically, or paste every voter here.</span>
        )}
        Each wallet gets one vote. More than half of the others can veto a payment; more than half of everyone can fast-track it. Use wallets held by different
        people, on different machines.
      </p>
      <AddressList list={wallets} setList={setWallets} locked={address} placeholder="Paste addresses, separated by spaces or commas" />
      <div className="flex items-center gap-3 text-[13px] text-[var(--subtle)]">
        <span className="inline-flex gap-1.5">
          {Array.from({ length: Math.max(MIN_WALLETS, wallets.length) }, (_, i) => (
            <i
              key={i}
              className="h-2.5 w-2.5 rounded-full transition-colors duration-500"
              style={{ background: i < wallets.length ? "var(--leaf)" : "var(--line)" }}
            />
          ))}
        </span>
        {wallets.length >= MIN_WALLETS
          ? `Veto needs ${Math.floor((wallets.length - 1) / 2) + 1} of the other ${wallets.length - 1}; fast-track needs ${Math.floor(wallets.length / 2) + 1} of ${wallets.length}.`
          : `At least ${MIN_WALLETS} wallets.`}
      </div>
    </div>,
    <div key="2" className="flex flex-col gap-6">
      <h2 className="pf-h2">Where does rescued money go?</h2>
      <p className="pf-lede">
        If the vault is ever compromised, everything can only move to this address. It is fixed now and changing it takes seven days, so no attacker can
        redirect it.
      </p>
      <div className="pf-grid2">
        <Field label="Recovery vault (required)" hint="A cold wallet or multisig nobody uses day to day.">
          <Input
            mono
            value={recoveryVault}
            onChange={(e) => setRecoveryVault(e.target.value.trim())}
            placeholder="0x…"
            bad={!!recoveryVault && !isAddress(recoveryVault)}
          />
        </Field>
        <Field label="Recovery key (optional)" hint="A cold key that can only unfreeze or migrate. It can never spend.">
          <Input
            mono
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value.trim())}
            placeholder="0x…"
            bad={!!recoveryKey && !isAddress(recoveryKey)}
          />
        </Field>
      </div>
      <Notice tone="amber">Double-check the recovery vault. It is the one destination nobody, including your own voters, can change quickly.</Notice>
    </div>,
    <div key="3" className="flex flex-col gap-6">
      <h2 className="pf-h2">How much can leave without a wait?</h2>
      <div className="pf-grid3">
        {PRESETS.map((p) => (
          <Choice key={p.k} on={preset === p.k && !custom} onClick={() => (setPreset(p.k), setCustom(false))} title={p.label} body={p.d}>
            <span className="pf-mono pf-dim mt-2">
              ${Number(p.b24).toLocaleString()} / 24h · cap ${Number(p.cap).toLocaleString()}
            </span>
          </Choice>
        ))}
      </div>
      <button type="button" className="pf-link w-fit text-sm" onClick={() => setCustom((c) => !c)}>
        {custom ? "Hide custom limits" : "Customise every limit"}
      </button>
      {custom && (
        <div className="pf-grid3" style={{ animation: "pf-fade .5s var(--ease) both" }}>
          {(
            [
              ["b24", "Instant budget, 24h (USDC)"],
              ["b7", "Instant budget, 7d (USDC)"],
              ["cap", "Hard cap (USDC)"],
              ["floor", "Floor (minutes)"],
              ["capH", "Cap delay (hours)"],
              ["max", "Max delay (hours)"],
            ] as const
          ).map(([k, label]) => (
            <Field key={k} label={label}>
              <Input inputMode="decimal" value={lim[k]} onChange={(e) => setLim({ ...lim, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
      )}
      <div className="pf-card">
        <span className="pf-mono pf-dim">What a queued payment would wait</span>
        <ul className="mt-4 flex flex-col gap-3">
          {examples.map((x, i) => {
            const flag = x.bits >= deployments.scoring.sFlag / 1000;
            const d = delayFor(x.bits, floorS, maxS);
            return (
              <li
                key={x.k}
                className="grid grid-cols-[1fr_auto] items-center gap-4 text-[15px]"
                style={{ animation: `pf-fade .5s var(--ease) ${i * 0.06}s both` }}
              >
                <span>
                  {x.k} <span className="pf-mono pf-dim">· ~{x.bits} bits</span>
                </span>
                {flag ? <Badge tone="red">flag · freeze</Badge> : <span className="pf-serif text-[24px] leading-none">{formatDuration(Math.round(d))}</span>}
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-[13px] text-[var(--subtle)]">
          Within the ${Number(lim.b24).toLocaleString()} daily budget, payments go out at once. Above the ${Number(lim.cap).toLocaleString()} hard cap, at least{" "}
          {lim.capH}h unless your team fast-tracks.
        </p>
      </div>
    </div>,
    <div key="4" className="flex flex-col gap-6">
      <h2 className="pf-h2">Teach the Sentinel what normal looks like.</h2>
      <p className="pf-lede">The Sentinel compares every payment to your vault&apos;s history. Until there is history, these give it a baseline.</p>
      <div className="pf-grid3">
        <Field label="Business hours start (UTC)">
          <Input inputMode="numeric" value={biz.start} onChange={(e) => setBiz({ ...biz, start: e.target.value })} />
        </Field>
        <Field label="Business hours end (UTC)">
          <Input inputMode="numeric" value={biz.end} onChange={(e) => setBiz({ ...biz, end: e.target.value })} />
        </Field>
        <Field label="Usual largest payment (USDC)" hint="Payments far above this look unusual.">
          <Input inputMode="decimal" value={usual} onChange={(e) => setUsual(e.target.value)} />
        </Field>
      </div>
      <div className="flex h-10 items-end gap-[3px]" aria-hidden>
        {Array.from({ length: 24 }, (_, h) => {
          const on = h >= Number(biz.start) && h < Number(biz.end);
          return (
            <i
              key={h}
              className="flex-1 rounded-t-[3px] transition-all duration-500"
              style={{ height: on ? "100%" : "30%", background: on ? "var(--moss)" : "var(--line)", transitionDelay: `${h * 15}ms` }}
              title={`${h}:00 UTC`}
            />
          );
        })}
      </div>
      <Field label="Known destinations (optional)" hint="Regular payees, so their first payment doesn't look new.">
        <AddressList list={dests} setList={setDests} placeholder="Paste payee addresses" />
      </Field>
    </div>,
    <div key="5" className="grid gap-10 md:grid-cols-[auto_1fr]">
      <OrgCard name={name} width={170} tilt />
      <div className="flex flex-col gap-6">
        <h2 className="pf-h2">
          Ready to create <em>{name}</em>?
        </h2>
        <dl className="pf-kv">
          <dt>Token</dt>
          <dd>{name}USDC</dd>
          <dt>Voters</dt>
          <dd>{wallets.length} wallets</dd>
          <dt>Recovery vault</dt>
          <dd>
            <AddressChip address={recoveryVault} />
          </dd>
          <dt>Instant budget</dt>
          <dd>
            ${lim.b24} / 24h · ${lim.b7} / 7d
          </dd>
          <dt>Hard cap</dt>
          <dd>${lim.cap}</dd>
          <dt>Floor · cap delay · max</dt>
          <dd>
            {lim.floor} min · {lim.capH}h · {lim.max}h
          </dd>
          <dt>Business hours</dt>
          <dd>
            {biz.start}:00–{biz.end}:00 UTC
          </dd>
        </dl>
        <p className="text-[14px] text-[var(--subtle)]">One transaction creates the vault, its token, its seat in the Orbital pool and its name.</p>
        <div>
          {address ? (
            <Button size="lg" onClick={submit} busy={tx.busy} disabled={tx.busy || !deployments.factory}>
              Create {name}
            </Button>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <span className="text-[14px] text-[var(--subtle)]">Connect a wallet to send the create transaction. It also becomes the first voter.</span>
              <ConnectButton />
            </div>
          )}
          <TxStatus state={tx.state} />
        </div>
      </div>
    </div>,
  ];

  return (
    <>
      <PageHead
        index="(Create a vault)"
        title="Set up your vault"
        em="in six steps."
        lede="Five minutes, one transaction. You can tighten anything later in a click; loosening takes a vote and a timelock."
      />
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <Steps n={6} active={step} onPick={(i) => (i < step || [...Array(i).keys()].every(ok) ? go(i) : undefined)} labels={STEP_LABELS} />
          <div className="hidden justify-between sm:flex">
            {STEP_LABELS.map((l, i) => (
              <button
                key={l}
                type="button"
                className={`pf-mono transition-colors ${i === step ? "text-[var(--ink)]" : "pf-dim"}`}
                onClick={() => (i < step ? go(i) : undefined)}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <section className="pf-card min-h-[420px] overflow-hidden" style={{ padding: "clamp(24px,4vw,48px)" }}>
          <div key={step} style={{ animation: `${dir > 0 ? "pf-slide-r" : "pf-slide-l"} .6s var(--ease) both` } as CSSProperties}>
            {panes[step]}
          </div>
        </section>
        <div className="flex items-center justify-between gap-4">
          <Button variant="ghost" onClick={() => go(Math.max(0, step - 1))} disabled={step === 0}>
            ← Back
          </Button>
          <span className="text-[13px] text-[var(--subtle)]">{step < 5 && errs[step]}</span>
          {step < 5 && (
            <Button onClick={next} disabled={!ok(step)}>
              Continue →
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

function Success({ name, vault }: { name: string; vault: Address }) {
  const join = `${useOrigin()}/join/${name}`;
  const steps = [
    { t: "Deposit USDC", d: "Mint your token 1:1.", href: `/vault/${name}/send` },
    { t: "Invite your voters", d: "Send each wallet owner the join link.", copy: join },
    { t: "Link your alerts", d: "Get Telegram messages for long delays and flags.", tg: true },
  ];
  return (
    <div className="flex flex-col gap-8">
      <HillsBand className="px-6 pt-14 pb-[min(26vw,280px)] text-center">
        <span className="mx-auto mb-6 block w-fit" style={{ animation: "pf-pop 1s var(--ease) both" }}>
          <OrgCard name={name} width={120} tilt />
        </span>
        <h1 className="pf-h1">
          <em>{name}</em> is live.
        </h1>
        <p className="mx-auto mt-4 max-w-[48ch] text-[16px] text-[var(--ink-2)]">
          Your vault, your {name}USDC token, a seat in the Orbital pool and your name, all in one transaction.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Link className="pf-btn dark" href={`/vault/${name}`}>
            Open dashboard
          </Link>
          <AddressChip address={vault} />
        </div>
      </HillsBand>
      <div className="pf-grid3">
        {steps.map((s, i) => (
          <div key={s.t} className="pf-card flex flex-col gap-3" style={{ animation: `pf-fade .7s var(--ease) ${0.3 + i * 0.08}s both` }}>
            <span className="pf-mono pf-dim">Next · {String(i + 1).padStart(2, "0")}</span>
            <h3 className="pf-h3">{s.t}</h3>
            <p className="text-[14px] text-[var(--subtle)]">{s.d}</p>
            <div className="mt-auto pt-2">
              {s.href && (
                <Link className="pf-btn line sm" href={s.href}>
                  Go →
                </Link>
              )}
              {s.copy && <CopyButton text={s.copy} label="Copy join link" className="sm" />}
              {s.tg && <TelegramLink vault={vault} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
