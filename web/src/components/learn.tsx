"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { deployments } from "@/lib/deployments";
import { fastTrackNeeded, formatDuration, vetoNeeded } from "@/lib/palm";
import { Glyph, PageHead, Section, VoteDots, type GlyphKind } from "./brand";
import { Badge } from "./ui";

/** A big lane-deck card: colour, glyph, label. */
export function DeckCard({
  bg,
  fg,
  gl,
  g,
  label,
  title,
  seed = 2,
  width = 260,
}: {
  bg: string;
  fg: string;
  gl: string;
  g: GlyphKind;
  label: string;
  title: string;
  seed?: number;
  width?: number;
}) {
  return (
    <div
      className="relative flex flex-none flex-col justify-between overflow-hidden rounded-[18px] p-6"
      style={{
        width,
        aspectRatio: "3 / 4",
        background: bg,
        color: fg,
        boxShadow: bg === "#fbfaf4" ? "inset 0 0 0 1px var(--line), 0 30px 60px -36px rgba(29,58,42,.5)" : "0 30px 60px -36px rgba(29,58,42,.55)",
      }}
    >
      <Glyph kind={g} seed={seed} className="relative z-[2] w-[46%]" style={{ stroke: gl, fill: "none" }} />
      <div className="relative z-[2] flex flex-col gap-2">
        <span className="pf-mono" style={{ opacity: 0.75 }}>
          {label}
        </span>
        <span className="text-[17px] font-medium leading-snug">{title}</span>
      </div>
      <i className="pf-grain" />
    </div>
  );
}

function DelayCalc() {
  const [bits, setBits] = useState(6);
  const [floorMin, setFloorMin] = useState(15);
  const k = deployments.scoring.k / 1000;
  const flagAt = deployments.scoring.sFlag / 1000;
  const flag = bits >= flagAt;
  const d = Math.min(72 * 3600, floorMin * 60 * Math.pow(2, bits / k));
  return (
    <div className="pf-card flex flex-col gap-5">
      <span className="pf-mono pf-dim">Try it: surprise score → delay</span>
      <div className="flex items-end justify-between gap-4">
        <span className="pf-big">{bits.toFixed(1)} bits</span>
        {flag ? (
          <Badge tone="red" live>
            flag · vault freezes
          </Badge>
        ) : (
          <span className="pf-serif text-[34px] leading-none">{formatDuration(Math.round(d))}</span>
        )}
      </div>
      <input
        type="range"
        className="pf-range"
        min={0}
        max={30}
        step={0.5}
        value={bits}
        onChange={(e) => setBits(+e.target.value)}
        style={{ "--k": `${(bits / 30) * 100}%` } as CSSProperties}
        aria-label="Surprise score in bits"
      />
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--subtle)]">
        Floor
        {[1, 15, 60].map((m) => (
          <button key={m} className={`pf-chip ${floorMin === m ? "on" : ""}`} onClick={() => setFloorMin(m)}>
            {m} min
          </button>
        ))}
      </div>
      <p className="text-[13px] text-[var(--subtle)]">
        The delay doubles every {k} bits from the floor, up to the max delay. On this network the Sentinel flags at {flagAt} bits (production uses 28,
        calibrated for treasury-sized payments).
      </p>
    </div>
  );
}

function VoteCalc() {
  const [n, setN] = useState(5);
  return (
    <div className="pf-card flex flex-col gap-5">
      <span className="pf-mono pf-dim">Try it: how many wallets?</span>
      <div className="flex items-center gap-3">
        <button className="pf-btn line sm" onClick={() => setN(Math.max(3, n - 1))} aria-label="Fewer wallets">
          −
        </button>
        <span className="pf-big w-16 text-center">{n}</span>
        <button className="pf-btn line sm" onClick={() => setN(Math.min(12, n + 1))} aria-label="More wallets">
          +
        </button>
        <span className="text-[14px] text-[var(--subtle)]">wallets</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="flex items-center justify-between text-[14px]">
          Veto{" "}
          <span className="pf-mono">
            {vetoNeeded(n)} of the other {n - 1} say no
          </span>
        </span>
        <VoteDots have={vetoNeeded(n)} need={vetoNeeded(n)} total={n - 1} tone="red" />
      </div>
      <div className="flex flex-col gap-2">
        <span className="flex items-center justify-between text-[14px]">
          Fast-track{" "}
          <span className="pf-mono">
            {fastTrackNeeded(n)} of {n} say yes
          </span>
        </span>
        <VoteDots have={fastTrackNeeded(n)} need={fastTrackNeeded(n)} total={n} tone="green" />
      </div>
      <p className="text-[13px] text-[var(--subtle)]">
        An attacker needs more than half of your wallets to beat a veto. Hold them on different people&apos;s devices.
      </p>
    </div>
  );
}

const CHAPTERS: { bg: string; fg: string; gl: string; g: GlyphKind; label: string; title: string; h: string; body: ReactNode; extra?: ReactNode }[] = [
  {
    bg: "#fbfaf4",
    fg: "#1f2a1e",
    gl: "#2f6b3a",
    g: "fan",
    label: "01 · Deposit",
    title: "USDC in, your own token out.",
    h: "Your money sits behind your own token.",
    body: "Deposit USDC on Arc and receive your org's Protected token 1:1. It only moves between your own wallets and the pool, so a thief can't just send it elsewhere.",
  },
  {
    bg: "#fbfaf4",
    fg: "#1f2a1e",
    gl: "#2f6b3a",
    g: "sun",
    label: "02 · Instant lane",
    title: "Small payments go straight out.",
    h: "A budget for everyday spending.",
    body: "Within a rolling 24-hour and 7-day budget, payments leave at once. That's the most a stolen key can move before anyone can react, so set it to what you'd tolerate losing on a bad day.",
  },
  {
    bg: "#e9d95c",
    fg: "#1f2a1e",
    gl: "#1f2a1e",
    g: "bars",
    label: "03 · Queued lane",
    title: "Bigger payments wait.",
    h: "The more unusual, the longer it waits.",
    body: "Above the budget, a payment is queued with a 1 USDC bond. Chainlink CRE's Sentinel scores how surprising it is against your own history (amount, destination, time of day, velocity, new wallets) and sets the delay. Past the threshold it flags: the vault freezes and the destination is blocklisted.",
    extra: <DelayCalc />,
  },
  {
    bg: "#1d3a2a",
    fg: "#e8f2c8",
    gl: "#cfe86a",
    g: "ladder",
    label: "04 · Your team",
    title: "A majority can say no.",
    h: "Your wallets vote.",
    body: "While a payment waits, more than half of the other wallets can veto it, and more than half of all wallets can fast-track it to the floor. Every voter gets an alert so someone is there in time.",
    extra: <VoteCalc />,
  },
  {
    bg: "#8dbd6b",
    fg: "#fbfdf3",
    gl: "#fbfdf3",
    g: "swirl",
    label: "05 · Freeze & recovery",
    title: "Rescue goes to one place.",
    h: "Freeze first, sort it out after.",
    body: "Any one wallet can freeze the vault. A frozen vault can unfreeze (by majority or the recovery key) or migrate everything to the recovery vault fixed at onboarding, and changing that address takes seven days. Meanwhile the business keeps running: a Lifeline pays counterparties you already paid, approved by the recovery key and a majority, fronted by the Orbital pool and repaid once the freeze ends.",
  },
  {
    bg: "#fbfaf4",
    fg: "#1f2a1e",
    gl: "#2f6b3a",
    g: "rings",
    label: "06 · Pay by name",
    title: "Org to org, token to token.",
    h: "One pool for every org.",
    body: "Orgs pay each other by name through one Orbital pool, a Uniswap v4 hook. You pay in your token, they receive theirs, and the swap-in counts against your budget like any other payment.",
  },
];

export function HowItWorks() {
  return (
    <>
      <PageHead
        index="(How it works)"
        title="A stolen key"
        em="only buys the budget."
        lede="palmfi assumes an attacker can produce valid signatures. So it limits what any one signature can do right now, and puts everything else behind a delay your team controls."
        actions={
          <>
            <Link className="pf-btn dark" href="/onboard">
              Create a vault
            </Link>
            <Link className="pf-btn line" href="/faq">
              Read the FAQ
            </Link>
          </>
        }
      />
      {CHAPTERS.map((c, i) => (
        <section
          key={c.label}
          className={`grid items-center gap-10 border-t border-[var(--line)] pt-14 md:grid-cols-[auto_1fr] ${i % 2 ? "md:[&>*:first-child]:order-2" : ""}`}
          data-pf
        >
          <div className="flex justify-center" style={{ transform: `rotate(${i % 2 ? 3 : -3}deg)` }}>
            <DeckCard {...c} seed={i + 2} />
          </div>
          <div className="flex flex-col gap-5">
            <span className="pf-mono pf-dim">{c.label}</span>
            <h2 className="pf-h2">{c.h}</h2>
            <p className="pf-lede">{c.body}</p>
            {c.extra}
          </div>
        </section>
      ))}
    </>
  );
}

/* ───────────── FAQ ───────────── */

const FAQS: { cat: string; q: string; a: ReactNode }[] = [
  {
    cat: "Basics",
    q: "What is palmfi?",
    a: "A protected USDC vault for every organisation on Arc. Small payments go out instantly within a budget; anything larger waits, scored by Chainlink CRE, and a majority of your own wallets can veto it or speed it up.",
  },
  {
    cat: "Basics",
    q: "Why would a valid signature not be enough?",
    a: "Because signatures get stolen, and signing systems get hijacked: on October 29, 2026 attackers made an exchange's own infrastructure sign billions out in under an hour. palmfi assumes that will happen and limits what one signature can do.",
  },
  {
    cat: "Basics",
    q: "Which assets are supported?",
    a: "USDC on Arc, held 1:1 behind your org's Protected token. Only the 6-decimal ERC-20 view of USDC is used.",
  },
  {
    cat: "Payments",
    q: "How long will my payment wait?",
    a: "Within the Instant budget: no wait. Above it, the delay depends on how unusual the payment is. It doubles every 2.5 bits of surprise from your floor; routine payroll scores about 3 bits (around half an hour on a 15-minute floor). Above your hard cap, it waits at least the cap delay unless your team fast-tracks it.",
  },
  {
    cat: "Payments",
    q: "What is the 1 USDC bond?",
    a: "Every queued request escrows 1 USDC of your token, refunded when it executes, is cancelled or is vetoed. It stops anyone flooding the queue.",
  },
  {
    cat: "Payments",
    q: "How do I pay another org?",
    a: "Use Pay with their name. You pay in your token through the Orbital pool and they receive theirs; the swap-in counts against your budget. You can also send them a payment link from Request a payment.",
  },
  {
    cat: "Votes",
    q: "Who can veto a payment?",
    a: "Your vault's own wallets. More than half of the wallets other than the requester saying no cancels it. More than half of all wallets saying yes makes it executable at the floor.",
  },
  {
    cat: "Votes",
    q: "What if I miss the alert?",
    a: "Link Telegram on each vault's Wallets tab and check your Inbox. If nobody votes, the Sentinel's delay simply runs out, so keep the budget and hard cap sensible.",
  },
  {
    cat: "Votes",
    q: "Can my team change the rules quickly?",
    a: "Only to tighten them. Lowering the budget, removing a wallet or freezing applies at once. Loosening (adding a wallet, raising the budget, changing limits or recovery) needs a majority and then a 48-hour or 7-day timelock, and a pending loosening makes every payment look more unusual to the Sentinel.",
  },
  {
    cat: "Incidents",
    q: "Can a frozen vault still pay payroll and suppliers?",
    a: "Yes, through a Lifeline. Any wallet can propose paying a counterparty the vault already paid before the freeze; it goes through only with both the recovery key and a majority of wallets. The Orbital pool fronts the payment and is repaid from the frozen USDC once the freeze resolves. Lifelines are capped at 20% of the vault's USDC and cost a 0.5% fee.",
  },
  {
    cat: "Incidents",
    q: "What happens when the Sentinel flags a payment?",
    a: "The vault freezes, the request is cancelled and the destination joins the network blocklist. A majority can unfreeze, remove a compromised wallet, or migrate everything to the recovery vault.",
  },
  {
    cat: "Incidents",
    q: "What if Chainlink CRE goes down?",
    a: "Nothing unsafe happens. Queued requests wait the full max delay (72 hours by default) instead of a scored delay, and your team can still fast-track or veto. The Status page shows the Sentinel's heartbeat.",
  },
  {
    cat: "Incidents",
    q: "Can the palmfi team move my funds?",
    a: "No. The admin can mark names verified, revoke a name or remove a blocklist entry. There is no path from any admin key to a vault's wallets, recovery or funds.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  const cats = [...new Set(FAQS.map((f) => f.cat))];
  return (
    <>
      <PageHead
        index="(FAQ)"
        title="Questions,"
        em="answered plainly."
        lede="If something here doesn't answer yours, open an issue on GitHub and we'll add it."
      />
      {cats.map((c) => (
        <Section key={c} label={c}>
          <div className="border-t border-[var(--line)]">
            {FAQS.map((f, i) =>
              f.cat !== c ? null : (
                <div key={f.q} className={`pf-acc ${open === i ? "open" : ""}`}>
                  <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                    {f.q}
                    <i aria-hidden />
                  </button>
                  <div>
                    <div>
                      <p>{f.a}</p>
                    </div>
                  </div>
                </div>
              ),
            )}
          </div>
        </Section>
      ))}
    </>
  );
}
