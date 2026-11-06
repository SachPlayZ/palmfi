"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Card in the landing's language: white, thin rule, mono label header. */
export function Card({
  title,
  children,
  actions,
  tone,
  className = "",
  label,
  id,
}: {
  id?: string;
  title?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  tone?: "danger" | "warn";
  className?: string;
  label?: string;
}) {
  return (
    <section id={id} className={`pf-card scroll-mt-24 ${tone ? `tone-${tone}` : ""} ${className}`} data-pf>
      {(title || actions || label) && (
        <header className="pf-card-head">
          <div className="flex min-w-0 flex-col gap-1.5">
            {label && <span className="pf-mono pf-dim">{label}</span>}
            {title && <h2 className="pf-h3">{title}</h2>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  size,
  busy,
  className = "",
  children,
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" | "line"; size?: "sm" | "lg"; busy?: boolean }) {
  const v = { primary: "dark", secondary: "", danger: "danger", ghost: "ghost", line: "line" }[variant];
  return (
    <button {...p} className={`pf-btn ${v} ${size ?? ""} ${className}`}>
      {busy && <span className="spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`pf-field ${className}`}>
      <span className="pf-label">{label}</span>
      {children}
      {hint && <span className="pf-hint">{hint}</span>}
    </label>
  );
}

export function Input({ mono, big, bad, ...p }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean; big?: boolean; bad?: boolean }) {
  const looksMono = mono ?? (typeof p.placeholder === "string" && p.placeholder.startsWith("0x"));
  return <input {...p} className={`pf-input ${looksMono ? "mono" : ""} ${big ? "big" : ""} ${bad ? "bad" : ""} ${p.className ?? ""}`} />;
}

export function Select(p: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={`pf-input ${p.className ?? ""}`} />;
}

export type Tone = "green" | "red" | "amber" | "blue" | "gray" | "forest";

export function Badge({ tone = "gray", children, live, plain }: { tone?: Tone; children: ReactNode; live?: boolean; plain?: boolean }) {
  return <span className={`pf-badge ${tone} ${live ? "live" : ""} ${plain ? "plain" : ""}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string | undefined }) {
  const tone: Tone = status === "active" ? "green" : status === "frozen" ? "red" : status === "migrated" ? "amber" : status === "revoked" ? "red" : "gray";
  return (
    <Badge tone={tone} live={status === "frozen"}>
      {status ?? "unknown"}
    </Badge>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-[12.5px]">{children}</span>;
}

export function short(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function Notice({ tone = "gray", children }: { tone?: "gray" | "red" | "amber" | "green"; children: ReactNode }) {
  return (
    <div className={`pf-notice ${tone}`} role={tone === "red" ? "alert" : undefined}>
      <i aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
