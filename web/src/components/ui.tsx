"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Card({ title, children, actions, tone }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; tone?: "danger" | "warn" }) {
  const border = tone === "danger" ? "border-red-500/60" : tone === "warn" ? "border-amber-500/60" : "border-[var(--border)]";
  return (
    <section className={`rounded-xl border ${border} bg-[var(--card)] p-4 sm:p-5`}>
      {(title || actions) && (
        <header className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-90",
    secondary: "border border-[var(--border)] hover:bg-[var(--muted)]",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "hover:bg-[var(--muted)]",
  }[variant];
  return (
    <button
      {...p}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--subtle)]">{hint}</span>}
    </label>
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={`min-h-9 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 font-mono text-sm outline-none focus:border-[var(--accent)] ${p.className ?? ""}`}
    />
  );
}

export function Select(p: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={`min-h-9 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-sm ${p.className ?? ""}`}
    />
  );
}

const badgeTones: Record<string, string> = {
  green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  red: "bg-red-500/15 text-red-600 dark:text-red-400",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  blue: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  gray: "bg-[var(--muted)] text-[var(--subtle)]",
};

export function Badge({ tone = "gray", children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeTones[tone]}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string | undefined }) {
  const tone = status === "active" ? "green" : status === "frozen" ? "red" : status === "migrated" ? "amber" : status === "revoked" ? "red" : "gray";
  return <Badge tone={tone}>{status ?? "unknown"}</Badge>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-xs">{children}</span>;
}

export function short(a?: string) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export function Notice({ tone = "gray", children }: { tone?: "gray" | "red" | "amber" | "green"; children: ReactNode }) {
  const c = {
    gray: "border-[var(--border)] bg-[var(--muted)]",
    red: "border-red-500/40 bg-red-500/10",
    amber: "border-amber-500/40 bg-amber-500/10",
    green: "border-emerald-500/40 bg-emerald-500/10",
  }[tone];
  return <div className={`rounded-lg border p-3 text-sm ${c}`}>{children}</div>;
}
