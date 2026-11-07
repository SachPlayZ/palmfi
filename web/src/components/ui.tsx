"use client";

import { createPortal } from "react-dom";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

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

/** Centered dialog (bottom sheet on phones). Esc or a backdrop click closes it. */
export function Modal({ open, onClose, title, label, children }: { open: boolean; onClose: () => void; title: string; label?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-[rgba(20,32,24,0.45)] backdrop-blur-[3px]" style={{ animation: "pf-fade .25s ease both" }} onClick={onClose} />
      <div
        className="relative flex max-h-[92vh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-[22px] bg-white shadow-[0_40px_80px_-30px_rgba(20,32,24,0.5)] sm:rounded-[22px]"
        style={{ animation: "pf-pop .35s var(--ease) both" }}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-6 pt-5 pb-4">
          <div className="flex flex-col gap-1">
            {label && <span className="pf-mono pf-dim">{label}</span>}
            <h2 className="pf-h3">{title}</h2>
          </div>
          <button type="button" className="pf-btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="overflow-y-auto p-2 pf-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
