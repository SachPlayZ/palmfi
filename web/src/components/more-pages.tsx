"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { isAddress, type Address } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { hubAbi } from "@/abi";
import { deployments } from "@/lib/deployments";
import { useMyVaults, useNetworkHealth, useVaultIndex } from "@/lib/hub";
import { network } from "@/lib/network";
import { CHANGE_LABEL, CHANGE_TIMELOCK, REASON_CODES, STATUS_LABEL, formatDuration } from "@/lib/palm";
import { TxStatus, useTx } from "@/lib/tx";
import { adminMessage, verifyMessage, type VerifyRequest } from "@/lib/verify";
import { AddressChip, CopyButton, EmptyState, Glyph, OrgCard, PageHead, Section, Skeleton, WalletGate, type GlyphKind } from "./brand";
import { TelegramLink } from "./telegram-link";
import { Badge, Button, Card, Field, Input, Notice, StatusBadge } from "./ui";

const REPO = "https://github.com/SachPlayZ/palmfi";

function Tiles({ items }: { items: { g: GlyphKind; t: string; d: ReactNode }[] }) {
  return (
    <div className="pf-grid3">
      {items.map((x, i) => (
        <div key={x.t} className="pf-card flex flex-col gap-3" data-pf style={{ "--d": `${i * 0.06}s` } as React.CSSProperties}>
          <Glyph kind={x.g} seed={i + 5} className="h-10 w-10" style={{ stroke: "var(--leaf)", fill: "none" }} />
          <h3 className="pf-h3">{x.t}</h3>
          <p className="text-[14px] leading-relaxed text-[var(--subtle)]">{x.d}</p>
        </div>
      ))}
    </div>
  );
}

/* ───────────── /verify ───────────── */

export function Verify() {
  const { address } = useAccount();
  const my = useMyVaults(address);
  const { signMessageAsync } = useSignMessage();
  const [pick, setPick] = useState<string>();
  const [f, setF] = useState({ legalName: "", website: "", email: "", jurisdiction: "" });
  const [state, setState] = useState<{ s: "idle" | "busy" | "done" | "error" | "off"; msg?: string }>({ s: "idle" });
  useEffect(() => {
    if (!pick && my.mine[0]) setPick(my.mine[0].vault);
  }, [pick, my.mine]);
  const entry = my.mine.find((m) => m.vault === pick);
  const ok = !!entry && f.legalName.trim() && /.+@.+\..+/.test(f.email);

  async function submit() {
    if (!entry || !ok) return;
    setState({ s: "busy" });
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await signMessageAsync({ message: verifyMessage(entry.vault, issuedAt) });
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vault: entry.vault, name: entry.name, issuedAt, signature, ...f }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (res.status === 503) return setState({ s: "off" });
      if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState({ s: "done" });
    } catch (e) {
      setState({ s: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }
  const issue = entry
    ? `${REPO}/issues/new?title=${encodeURIComponent(`Verification request: ${entry.name}`)}&body=${encodeURIComponent(`Vault: ${entry.vault}\nName: ${entry.name}\nLegal name: ${f.legalName}\nWebsite: ${f.website}\nJurisdiction: ${f.jurisdiction}\n\n(Contact details sent separately.)`)}`
    : REPO;

  return (
    <>
      <PageHead
        index="(Verification)"
        title="Get the"
        em="verified badge."
        lede="Names are first come, first served. The badge tells payers the palmfi team checked that a name really belongs to the business behind it."
      />
      <Tiles
        items={[
          { g: "ladder", t: "What it means", d: "We confirmed the legal entity behind the vault and that one of its wallets asked for the badge." },
          { g: "rings", t: "What it doesn't", d: "The badge grants no power over funds, wallets or limits. A verified vault follows exactly the same rules." },
          {
            g: "wave",
            t: "How long",
            d: "Usually a few days on testnet. We'll email the contact you give; nothing about it is published onchain except the badge.",
          },
        ]}
      />
      <WalletGate title="Connect one of the vault's wallets" body="Only a voter of the vault can ask for its badge. You'll sign a message; no transaction.">
        {my.isLoading ? (
          <Skeleton h={320} className="rounded-[18px]" />
        ) : !my.mine.length ? (
          <Card>
            <EmptyState
              glyph="sun"
              title="No vault to verify"
              body="Create your org's vault first."
              action={
                <Link className="pf-btn dark" href="/onboard">
                  Create a vault
                </Link>
              }
            />
          </Card>
        ) : state.s === "done" ? (
          <Card>
            <EmptyState
              glyph="sun"
              title="Request received"
              body={`We'll be in touch at ${f.email}. The badge appears on ${entry?.name}'s public page once it's set.`}
              action={
                <Link className="pf-btn line" href={`/o/${entry?.name}`}>
                  View public page
                </Link>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
            <Card label="Which vault">
              <div className="pf-list">
                {my.mine.map((m) => (
                  <button key={m.vault} className="pf-row w-full text-left" onClick={() => setPick(m.vault)} aria-pressed={pick === m.vault}>
                    <OrgCard name={m.name ?? m.vault} width={30} />
                    <span className="grow text-[16px]">{m.name}</span>
                    {m.verified ? (
                      <Badge tone="blue">verified</Badge>
                    ) : (
                      <span
                        className={`h-4 w-4 rounded-full ${pick === m.vault ? "bg-[var(--ink)] shadow-[inset_0_0_0_3px_#fff,0_0_0_1px_var(--ink)]" : "shadow-[inset_0_0_0_1px_var(--line)]"}`}
                      />
                    )}
                  </button>
                ))}
              </div>
            </Card>
            <Card label="About the business">
              {entry?.verified ? (
                <Notice tone="green">{entry.name} is already verified.</Notice>
              ) : (
                <div className="flex flex-col gap-4">
                  <Field label="Legal name">
                    <Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} placeholder="Northwind Trading Ltd." />
                  </Field>
                  <div className="pf-grid2">
                    <Field label="Website">
                      <Input value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://" />
                    </Field>
                    <Field label="Jurisdiction">
                      <Input value={f.jurisdiction} onChange={(e) => setF({ ...f, jurisdiction: e.target.value })} placeholder="India" />
                    </Field>
                  </div>
                  <Field label="Contact email" hint="Only the palmfi team sees this.">
                    <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="finance@northwind.example" />
                  </Field>
                  {state.s === "off" ? (
                    <Notice tone="amber">
                      Requests aren&apos;t collected on this deployment. Open a GitHub issue instead (leave your email out; we&apos;ll reach you there):{" "}
                      <a className="pf-link" href={issue} target="_blank" rel="noreferrer">
                        open the issue
                      </a>
                      .
                    </Notice>
                  ) : (
                    <div>
                      <Button onClick={submit} busy={state.s === "busy"} disabled={!ok || state.s === "busy"}>
                        Sign and request the badge
                      </Button>
                      {state.s === "error" && <p className="mt-3 text-[13px] text-[var(--red)]">{state.msg}</p>}
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}
      </WalletGate>
    </>
  );
}

/* ───────────── /security ───────────── */

export function Security() {
  return (
    <>
      <PageHead
        index="(Security)"
        title="Designed for the day"
        em="your keys leak."
        lede="The threat palmfi designs for is an attacker who can produce valid signatures, from a stolen key or from your own hijacked signing system. Here is what that attacker can and can't do."
      />
      <Section label="Threat model" title="If this happens, here's what follows.">
        <div className="pf-list">
          {[
            [
              "One wallet's key is stolen",
              "The attacker spends at most the Instant budget. Anything larger is queued, scored and visible to your team, who can veto it or freeze the vault.",
            ],
            [
              "Your signing system is hijacked",
              "Same as a stolen key: the vault, not your signer, enforces the budget and the queue. EIP-7702 delegations to unapproved targets are flagged.",
            ],
            [
              "The attacker tries to add their own wallet",
              "Adding a wallet needs a majority and a 48-hour timelock, and a pending add makes every payment look more unusual to the Sentinel.",
            ],
            [
              "More than half your wallets are compromised",
              "Then your team has lost control of votes, so keep wallets on different people's devices. The recovery vault and key still can't be changed in under seven days.",
            ],
            [
              "Chainlink CRE stops reporting",
              "Queued requests wait the full max delay instead of a scored one. Nothing gets faster; your team can still fast-track or veto.",
            ],
            [
              "A bad report reaches the Hub",
              "Reports are authenticated, bound to one request and single-use. The worst a wrong score does is delay or freeze; it can never send money anywhere.",
            ],
          ].map(([t, d], i) => (
            <div key={t} className="pf-row items-start" style={{ animation: `pf-fade .6s var(--ease) ${i * 0.05}s both` }}>
              <span className="pf-mono pf-dim w-8 pt-1">{String(i + 1).padStart(2, "0")}</span>
              <span className="grow flex flex-col gap-1">
                <span className="text-[17px]">{t}</span>
                <span className="text-[14.5px] leading-relaxed text-[var(--subtle)]">{d}</span>
              </span>
            </div>
          ))}
        </div>
      </Section>
      <div className="pf-grid2">
        <Card label="The admin key" title="What the palmfi team can do">
          <ul className="flex flex-col gap-3 text-[15px]">
            {[
              "Mark a name verified, or remove the badge",
              "Revoke a name (the vault and its funds are untouched)",
              "Remove an address from the blocklist",
              "Propose a CRE workflow rotation, behind a timelock",
            ].map((x) => (
              <li key={x} className="flex gap-3">
                <span className="text-[var(--leaf)]">✓</span>
                {x}
              </li>
            ))}
          </ul>
        </Card>
        <Card label="The admin key" title="What it can never do">
          <ul className="flex flex-col gap-3 text-[15px]">
            {[
              "Move, freeze-release or redirect any vault's funds",
              "Add or remove a vault's wallets",
              "Change a vault's budget, limits or recovery",
              "Shorten any delay or override a veto",
            ].map((x) => (
              <li key={x} className="flex gap-3">
                <span className="text-[var(--red)]">✕</span>
                {x}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card label="Audits and reports" title="Read the work, report what we missed">
        <div className="pf-list">
          {[
            [`${REPO}/blob/main/docs/audits/arc-studio-2026-11-06.md`, "Arc Studio security review", "Nov 6, 2026"],
            [`${REPO}/blob/main/docs/audits/arc-studio-2026-11-06-resolution.md`, "How each finding was resolved", "Nov 6, 2026"],
            [`${REPO}/tree/main/contracts/test`, "Contract test suite", "Foundry"],
            [`${REPO}/issues/new?title=${encodeURIComponent("Security report")}`, "Report a vulnerability", "GitHub issue (mark it private if you can)"],
          ].map(([href, t, d]) => (
            <a key={t} href={href} target="_blank" rel="noreferrer" className="pf-row group">
              <span className="grow flex flex-col">
                <span className="text-[16px]">{t}</span>
                <span className="text-[13px] text-[var(--subtle)]">{d}</span>
              </span>
              <span className="text-[var(--subtle)] transition-transform duration-500 group-hover:translate-x-1">↗</span>
            </a>
          ))}
        </div>
      </Card>
    </>
  );
}

/* ───────────── /settings (notifications) ───────────── */

export function NotificationSettings() {
  const { address } = useAccount();
  const my = useMyVaults(address);
  return (
    <>
      <PageHead
        index="(Notifications)"
        title="Be there"
        em="when it counts."
        lede="Votes only protect a vault if someone sees the request in time. Link alerts for each vault you vote in."
      />
      <Tiles
        items={[
          { g: "bars", t: "Long delays", d: "When the Sentinel gives a payment a long delay, every voter hears about it so you can veto or fast-track." },
          { g: "rings", t: "Flags and freezes", d: "If the Sentinel flags a payment or someone freezes the vault, you'll know at once." },
          { g: "ladder", t: "Settings changes", d: "A proposed wallet add or limit change is the first move of a takeover. You get a message for each one." },
        ]}
      />
      <WalletGate title="Connect to manage alerts">
        {my.isLoading ? (
          <Skeleton h={200} className="rounded-[18px]" />
        ) : !my.mine.length ? (
          <Card>
            <EmptyState
              glyph="wave"
              title="No vaults yet"
              body="Alerts are per vault. Join or create one first."
              action={
                <Link className="pf-btn dark" href="/onboard">
                  Create a vault
                </Link>
              }
            />
          </Card>
        ) : (
          <div className="pf-list">
            {my.mine.map((m) => (
              <div key={m.vault} className="pf-row flex-wrap">
                <OrgCard name={m.name ?? m.vault} width={34} tilt />
                <span className="grow flex flex-col">
                  <span className="text-[17px]">{m.name}</span>
                  <span className="pf-mono pf-dim">{STATUS_LABEL[m.status ?? 0]}</span>
                </span>
                <TelegramLink vault={m.vault} />
              </div>
            ))}
          </div>
        )}
      </WalletGate>
    </>
  );
}

/* ───────────── /developers ───────────── */

const HUB_EVENTS: [string, string][] = [
  ["VaultRegistered(vault, name, token)", "A vault was created"],
  [
    "RequestQueued(vault, requestId, requestHash, kind, wallet, amount, destination, reasonCodes)",
    "A payment above the budget was queued; the Sentinel's log trigger",
  ],
  ["RequestUpdated(vault, requestId, state, executableAt, score, reasonCodes)", "Scored, executed, vetoed, expired, flagged or cancelled"],
  ["Voted(vault, requestId, voter, yes, yesVotes, noVotes)", "A wallet voted on a request"],
  ["Outflow(vault, wallet, destination, amount, viaPool)", "Money left a vault"],
  ["ConfigChange(vault, changeId, kind, data, yesVotes, eta)", "A settings change was proposed or voted"],
  ["Frozen(vault, by, reasonCodes) / Unfrozen(vault)", "Freeze state changed"],
  ["Flagged(vault, requestId, reasonCodes, destination)", "The Sentinel flagged a request"],
  ["Blocked(account, sourceVault, until)", "An address joined the shared blocklist"],
  ["Heartbeat(timestamp, nonce)", "The Reconciler's liveness signal"],
];

const SNIPPET = `import { createPublicClient, http, parseAbi } from "viem";

const client = createPublicClient({ transport: http("https://rpc.testnet.arc.network") });
const hub = "${deployments.hub ?? "0x…"}";

const abi = parseAbi([
  "function resolve(string) view returns (address)",
  "function statusOf(address) view returns (uint8)",
]);

const vault = await client.readContract({ address: hub, abi, functionName: "resolve", args: ["northwind"] });
const status = await client.readContract({ address: hub, abi, functionName: "statusOf", args: [vault] });`;

export function Developers() {
  return (
    <>
      <PageHead
        index="(Developers)"
        title="Build on"
        em="palmfi."
        lede="Everything is onchain on Arc testnet and every vault reports through one Hub, so you can watch the whole network from a single address."
      />
      <div className="pf-grid2">
        <Card label="Contracts" title="Arc testnet · chain 5042002">
          <dl className="pf-kv">
            {[
              ["Hub", deployments.hub],
              ["VaultFactory", deployments.factory],
              ["OrbitalHook", deployments.hook],
              ["OrbitalRouter", deployments.router],
              ["PoolManager", network.poolManager],
              ["USDC", network.usdc],
            ].map(([k, a]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd>
                  <AddressChip address={a} />
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <a className="pf-btn line sm" href={`${REPO}/tree/main/web/src/abi`} target="_blank" rel="noreferrer">
              ABIs ↗
            </a>
            <a className="pf-btn line sm" href={`${REPO}/tree/main/contracts/src`} target="_blank" rel="noreferrer">
              Contracts ↗
            </a>
            <a className="pf-btn line sm" href={`${REPO}/tree/main/cre`} target="_blank" rel="noreferrer">
              CRE workflows ↗
            </a>
          </div>
        </Card>
        <Card label="Quick start" title="Resolve a name" actions={<CopyButton text={SNIPPET} label="Copy" className="sm" />}>
          <pre className="overflow-x-auto rounded-2xl bg-[var(--forest)] p-5 font-mono text-[12.5px] leading-relaxed text-[#e8f2c8]">{SNIPPET}</pre>
        </Card>
      </div>
      <Section label="Hub events" title="One address to watch">
        <div className="pf-list">
          {HUB_EVENTS.map(([sig, d]) => (
            <div key={sig} className="pf-row flex-wrap">
              <code className="grow font-mono text-[13px]">{sig}</code>
              <span className="text-[14px] text-[var(--subtle)]">{d}</span>
            </div>
          ))}
        </div>
      </Section>
      <div className="pf-grid2">
        <Card label="Reason codes" title="Why the Sentinel scored what it did">
          <div className="pf-list">
            {REASON_CODES.map(([bit, code, d]) => (
              <div key={code} className="pf-row items-start">
                <span className="pf-mono pf-dim w-6 pt-0.5">{bit}</span>
                <span className="grow flex flex-col gap-0.5">
                  <code className="font-mono text-[12.5px]">{code}</code>
                  <span className="text-[13px] text-[var(--subtle)]">{d}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
        <div className="flex flex-col gap-6">
          <Card label="Settings changes" title="Kinds and timelocks">
            <div className="pf-list">
              {Object.entries(CHANGE_LABEL).map(([k, label]) => (
                <div key={k} className="pf-row">
                  <span className="pf-mono pf-dim w-6">{k}</span>
                  <span className="grow text-[14.5px]">{label}</span>
                  <span className="pf-mono">{CHANGE_TIMELOCK[Number(k)] ? formatDuration(CHANGE_TIMELOCK[Number(k)]) : "now"}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card label="Scoring parameters" title="This network">
            <dl className="pf-kv">
              <dt>Doubling step</dt>
              <dd>{deployments.scoring.k / 1000} bits</dd>
              <dt>Flag threshold</dt>
              <dd>{deployments.scoring.sFlag / 1000} bits</dd>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

/* ───────────── /admin ───────────── */

export function Admin() {
  const { address } = useAccount();
  const h = useNetworkHealth();
  const idx = useVaultIndex();
  const tx = useTx();
  const { signMessageAsync } = useSignMessage();
  const [reqs, setReqs] = useState<VerifyRequest[]>();
  const [err, setErr] = useState<string>();
  const [unblock, setUnblock] = useState("");
  const isAdmin = !!address && !!h.admin && address.toLowerCase() === h.admin.toLowerCase();
  const hub = deployments.hub!;

  async function load() {
    setErr(undefined);
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await signMessageAsync({ message: adminMessage(issuedAt) });
      const res = await fetch(`/api/verify?issuedAt=${issuedAt}&signature=${signature}`);
      const body = (await res.json()) as { ok: boolean; requests?: VerifyRequest[]; error?: string };
      if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setReqs(body.requests ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }
  const setVerified = (vault: Address, v: boolean) =>
    tx.send({ address: hub, abi: hubAbi, functionName: "setVerified", args: [vault, v] }, v ? "Verify name" : "Remove badge");

  return (
    <>
      <PageHead
        index="(Admin)"
        title="Hub admin,"
        em="no fund powers."
        lede="Verification, name revocation and blocklist removal. Nothing here can touch a vault's money, wallets or limits."
      />
      <WalletGate title="Connect the Hub admin wallet">
        {!h.admin ? (
          <Skeleton h={120} className="rounded-[18px]" />
        ) : !isAdmin ? (
          <Card>
            <EmptyState
              glyph="ladder"
              title="Hub admin only"
              body={
                <>
                  This page acts for the Hub admin, <AddressChip address={h.admin} />. Your wallet isn&apos;t it.
                </>
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            <Card
              label="Verification requests"
              actions={
                <Button variant="line" size="sm" onClick={load}>
                  {reqs ? "Refresh" : "Sign to load"}
                </Button>
              }
            >
              {err && <Notice tone="amber">{err}</Notice>}
              {!reqs ? (
                <p className="text-[14px] text-[var(--subtle)]">Requests include contact details, so reading them needs your signature.</p>
              ) : !reqs.length ? (
                <p className="text-[14px] text-[var(--subtle)]">No requests.</p>
              ) : (
                <div className="pf-list">
                  {reqs.map((r) => {
                    const e = idx.entries.find((x) => x.vault.toLowerCase() === r.vault.toLowerCase());
                    return (
                      <div key={r.vault} className="pf-row flex-wrap">
                        <OrgCard name={r.name || r.vault} width={30} />
                        <span className="grow flex flex-col">
                          <span className="text-[16px]">
                            {r.name} · {r.legalName}
                          </span>
                          <span className="text-[13px] text-[var(--subtle)]">
                            {r.website} · {r.jurisdiction} · {r.email} · {new Date(r.at * 1000).toLocaleDateString()}
                          </span>
                        </span>
                        {e?.verified ? (
                          <Badge tone="blue">verified</Badge>
                        ) : (
                          <Button size="sm" onClick={() => setVerified(r.vault, true)} disabled={tx.busy}>
                            Verify
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
            <Card label="Names" title={`${idx.count} vaults`}>
              <div className="pf-list">
                {idx.entries.map((e) => (
                  <div key={e.vault} className="pf-row flex-wrap">
                    <OrgCard name={e.name ?? e.vault} width={28} />
                    <span className="grow text-[15px]">{e.name}</span>
                    <StatusBadge status={STATUS_LABEL[e.status ?? 0]} />
                    <Button size="sm" variant="line" onClick={() => setVerified(e.vault, !e.verified)} disabled={tx.busy}>
                      {e.verified ? "Remove badge" : "Verify"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={tx.busy}
                      onClick={() =>
                        window.confirm(`Revoke the name “${e.name}”? The vault and its funds are untouched.`) &&
                        tx.send({ address: hub, abi: hubAbi, functionName: "revoke", args: [e.vault] }, "Revoke name")
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
            <Card label="Blocklist" title="Remove an address">
              <div className="flex gap-2">
                <Input mono value={unblock} onChange={(e) => setUnblock(e.target.value)} placeholder="0x…" />
                <Button
                  variant="line"
                  disabled={!isAddress(unblock) || tx.busy}
                  onClick={() => tx.send({ address: hub, abi: hubAbi, functionName: "unblock", args: [unblock as Address] }, "Unblock")}
                >
                  Unblock
                </Button>
              </div>
            </Card>
            <TxStatus state={tx.state} />
          </div>
        )}
      </WalletGate>
    </>
  );
}

/* ───────────── legal ───────────── */

const LEGAL: Record<"terms" | "privacy" | "risk", { title: string; em: string; lede: string; sections: [string, string][] }> = {
  terms: {
    title: "Terms",
    em: "of use.",
    lede: "Draft terms for the Arc testnet deployment. They'll be replaced before any mainnet launch.",
    sections: [
      ["Testnet software", "palmfi runs on Arc testnet with test USDC that has no value. Don't send real funds to any address you find here."],
      [
        "You hold your keys",
        "palmfi never takes custody. Vaults are smart contracts controlled by your own wallets; we can't recover lost keys or reverse transactions.",
      ],
      ["No warranty", "The software is provided as is, without warranties of any kind. Contracts have been reviewed but may still contain bugs."],
      [
        "Names",
        "Names are first come, first served. The Hub admin may revoke a name that impersonates someone else; revocation never touches the vault or its funds.",
      ],
      ["Changes", "We may update these terms. The date at the top of this page tells you when they last changed."],
    ],
  },
  privacy: {
    title: "Privacy,",
    em: "kept small.",
    lede: "What this app stores about you, and what's public by nature of a blockchain.",
    sections: [
      ["Onchain data is public", "Vaults, wallets, payments, votes and settings changes are recorded on Arc and visible to anyone. This app only reads them."],
      ["Telegram alerts", "If you link Telegram, we store your chat id against the vault you signed for, so we can message you. Unlink by blocking the bot."],
      [
        "Verification requests",
        "If you ask for the verified badge, we store the business details and contact email you give. Only the Hub admin can read them.",
      ],
      ["No tracking", "No analytics, advertising cookies or third-party trackers. Your wallet provider may have its own policy."],
    ],
  },
  risk: {
    title: "Know the",
    em: "risks.",
    lede: "palmfi narrows how fast money can leave. It doesn't remove every risk, and some of its protections depend on you.",
    sections: [
      [
        "Your own setup",
        "If more than half of your wallets are compromised, an attacker controls your votes. Keep wallets with different people on different devices.",
      ],
      ["Recovery address", "The recovery vault is fixed for seven days at a time. If it's wrong or lost, migration sends funds somewhere you can't reach."],
      ["Smart contracts", "Bugs in the vault, Hub, Orbital hook or router could cause loss. Read the audit and tests before trusting larger amounts."],
      ["Chainlink CRE", "Scoring depends on CRE. If it stops, requests wait the max delay; if it misjudges, payments can be delayed or a vault frozen."],
      ["Pool payments", "Paying through the Orbital pool costs a small spread and needs liquidity on both sides. A frozen org's token can't be paid."],
      ["Stablecoin", "Everything is denominated in USDC; its issuer's controls and solvency apply."],
    ],
  },
};

export function Legal({ kind }: { kind: keyof typeof LEGAL }) {
  const d = LEGAL[kind];
  return (
    <>
      <PageHead index={`(${kind}) · draft · updated Nov 2026`} title={d.title} em={d.em} lede={d.lede} />
      <div className="flex flex-col">
        {d.sections.map(([t, b], i) => (
          <section
            key={t}
            className="grid gap-3 border-t border-[var(--line)] py-8 md:grid-cols-[1fr_2fr]"
            data-pf
            style={{ "--d": `${i * 0.04}s` } as React.CSSProperties}
          >
            <h2 className="pf-serif text-[28px] leading-tight tracking-tight">{t}</h2>
            <p className="max-w-[62ch] text-[16px] leading-relaxed text-[var(--ink-2)]">{b}</p>
          </section>
        ))}
      </div>
    </>
  );
}
