"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { Glyph, type GlyphKind } from "./brand";
import { OnboardWizard, type VaultKind } from "./onboard-wizard";

const KINDS: {
  k: VaultKind;
  label: string;
  title: string;
  body: string;
  points: string[];
  meta: string;
  glyph: GlyphKind;
  bg: string;
  fg: string;
}[] = [
  {
    k: "institution",
    label: "Institution",
    title: "A treasury for your team",
    body: "For companies, DAOs and funds that pay vendors, payroll and partners.",
    points: ["Approvals shared across your team", "Spending limits sized to your organisation", "Pay other organisations by name"],
    meta: "3+ approvers · about 5 minutes",
    glyph: "bars",
    bg: "#1d3a2a",
    fg: "#e8f2c8",
  },
  {
    k: "individual",
    label: "Individual",
    title: "A vault for yourself",
    body: "For people who want everyday spending to stay instant and big moves to stay safe.",
    points: ["Your own devices act as approvers", "Sensible limits, already set", "Get paid by a simple name"],
    meta: "3 of your devices · about 2 minutes",
    glyph: "sun",
    bg: "#e9d95c",
    fg: "#1f2a1e",
  },
];

export function OnboardStart() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const as = params.get("as");
  const open: VaultKind | null = as === "institution" || as === "individual" ? as : null;

  const pick = (k: VaultKind | null) => {
    const q = new URLSearchParams(params.toString());
    if (k) q.set("as", k);
    else q.delete("as");
    const s = q.toString();
    router.replace(s ? `${path}?${s}` : path, { scroll: false });
  };

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && pick(null);
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-10 py-6">
      <header className="flex flex-col gap-3 text-center" style={{ animation: "pf-fade .7s var(--ease) both" }}>
        <span className="pf-mono pf-dim">Open a vault</span>
        <h1 className="pf-h2">
          How will you use <em>palmfi?</em>
        </h1>
        <p className="mx-auto max-w-[52ch] text-[16px] text-[var(--subtle)]">Choose one to get a setup tailored to you. Both are backed 1:1 by USDC.</p>
      </header>

      <div className="grid gap-5 md:grid-cols-2">
        {KINDS.map((c, i) => (
          <button
            key={c.k}
            type="button"
            onClick={() => pick(c.k)}
            className="pf-card lift group flex flex-col overflow-hidden !p-0 text-left"
            style={{ animation: `pf-fade .7s var(--ease) ${0.1 + i * 0.08}s both` }}
          >
            <div className="relative flex h-[148px] items-end justify-between p-6" style={{ background: c.bg, color: c.fg }}>
              <span className="pf-mono">{c.label}</span>
              <Glyph kind={c.glyph} seed={i + 3} className="absolute top-5 right-6 h-[104px] w-[104px] transition-transform duration-700 group-hover:rotate-6"
                style={{ stroke: "currentColor", strokeLinecap: "round" }}
              />
            </div>
            <div className="flex flex-1 flex-col gap-4 p-6">
              <div className="flex flex-col gap-1.5">
                <h2 className="text-[22px] font-medium tracking-[-0.015em]">{c.title}</h2>
                <p className="text-[14.5px] text-[var(--subtle)]">{c.body}</p>
              </div>
              <ul className="flex flex-col gap-2 text-[14.5px]">
                {c.points.map((p) => (
                  <li key={p} className="flex items-center gap-2.5">
                    <i className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--leaf)]" />
                    {p}
                  </li>
                ))}
              </ul>
              <div className="mt-auto flex items-center justify-between border-t border-[var(--line)] pt-4">
                <span className="pf-mono pf-dim">{c.meta}</span>
                <span className="pf-btn dark sm">Continue →</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <p className="text-center text-[13.5px] text-[var(--subtle)]">
        Already have a vault?{" "}
        <Link href="/vaults" className="pf-link">
          Go to your vaults
        </Link>
      </p>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label="Create a vault">
          <div className="absolute inset-0 bg-[rgba(20,32,24,0.45)] backdrop-blur-[3px]" style={{ animation: "pf-fade .3s ease both" }} onClick={() => pick(null)} />
          <div
            className="relative w-full max-w-[680px] overflow-hidden rounded-t-[22px] bg-white shadow-[0_40px_80px_-30px_rgba(20,32,24,0.5)] sm:rounded-[22px]"
            style={{ animation: "pf-pop .4s var(--ease) both" }}
          >
            <OnboardWizard key={open} kind={open} onClose={() => pick(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
