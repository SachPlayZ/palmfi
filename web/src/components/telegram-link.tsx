"use client";

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { useSignMessage } from "wagmi";
import { Button, Modal, Notice } from "./ui";

// Mirrors linkMessage() in lib/server/telegram.ts (kept client-side to avoid bundling node:crypto).
const linkMessage = (vault: Address, issuedAt: number) => `palmfi: link Telegram notifications for Vault ${vault} (issued ${issuedAt})`;

type Status = { linked: boolean; chats: number };

/** Polls /api/telegram/status for the Vault (which also lets the server drain the bot's updates in local dev). */
function useTelegramStatus(vault: Address, fast: boolean) {
  const [status, setStatus] = useState<Status>();
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/telegram/status?vault=${vault}`, { cache: "no-store" });
      const b = (await res.json()) as { ok: boolean; linked?: boolean; chats?: number };
      if (b.ok) setStatus({ linked: !!b.linked, chats: b.chats ?? 0 });
    } catch {
      /* offline */
    }
  }, [vault]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, fast ? 2500 : 30_000);
    return () => clearInterval(t);
  }, [refresh, fast]);
  return { status, refresh };
}

const STEPS = ["Sign with your wallet", "Open the bot and press Start", "Connected"] as const;

/** The connect flow: sign a link request → open t.me/<bot>?start=<token> → wait until the chat shows up as linked. */
export function TelegramConnectModal({ vault, open, onClose }: { vault: Address; open: boolean; onClose: () => void }) {
  const { signMessageAsync } = useSignMessage();
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { status } = useTelegramStatus(vault, open && !!url);
  const [startChats, setStartChats] = useState<number>();

  useEffect(() => {
    if (open && status && startChats === undefined) setStartChats(status.chats);
    if (!open) {
      setStartChats(undefined);
      setUrl(undefined);
      setErr(undefined);
    }
  }, [open, status, startChats]);

  const done = !!url && status !== undefined && startChats !== undefined && status.chats > startChats;
  const step = done ? 2 : url ? 1 : 0;

  async function connect() {
    setBusy(true);
    setErr(undefined);
    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await signMessageAsync({ message: linkMessage(vault, issuedAt) });
      const res = await fetch("/api/telegram/link-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vault, issuedAt, signature }),
      });
      const body = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!body.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
      setUrl(body.url);
      window.open(body.url, "_blank", "noopener");
    } catch (e) {
      setErr(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Connect Telegram" label="Alerts">
      <div className="flex flex-col gap-5 p-4">
        <p className="text-[15px] leading-relaxed text-[var(--ink-2)]">
          Get a Telegram message on every long delay, FLAG, Freeze and settings change for this vault, so you can veto in time.
        </p>
        <ol className="flex flex-col gap-3">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-3 text-[14px]">
              <span
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-medium ${
                  i < step || done ? "bg-[var(--leaf)] text-white" : i === step ? "bg-[var(--ink)] text-white" : "bg-[var(--paper-2)] text-[var(--subtle)]"
                }`}
              >
                {i < step || done ? "✓" : i + 1}
              </span>
              <span className={i > step ? "text-[var(--subtle)]" : ""}>{s}</span>
              {i === 1 && step === 1 && <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--amber)]" aria-label="waiting" />}
            </li>
          ))}
        </ol>
        {err && <Notice tone="red">{err}</Notice>}
        {done ? (
          <>
            <Notice tone="green">
              <strong>Connected.</strong> The bot sent a confirmation to your chat. {status!.chats} chat{status!.chats === 1 ? "" : "s"} now get alerts for this vault.
            </Notice>
            <div className="flex justify-end">
              <Button onClick={onClose}>Done</Button>
            </div>
          </>
        ) : url ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-[var(--subtle)]">Waiting for you to press Start in Telegram…</span>
            <a href={url} target="_blank" rel="noreferrer" className="pf-btn dark">
              Open Telegram
            </a>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[13px] text-[var(--subtle)]">
              {status?.linked ? `${status.chats} chat${status.chats === 1 ? "" : "s"} already connected. Add another below.` : "Your wallet signs a free message; no transaction."}
            </span>
            <Button onClick={connect} disabled={busy}>
              {busy ? "Waiting for signature…" : "Sign and connect"}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** A button that opens the connect modal; shows "Telegram connected" once a chat is linked. */
export function TelegramButton({ vault, className = "pf-btn line" }: { vault: Address; className?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { status } = useTelegramStatus(vault, false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="inline-flex items-center gap-2">
          <TelegramIcon />
          {status?.linked ? "Telegram connected" : "Connect Telegram"}
        </span>
      </button>
      <TelegramConnectModal vault={vault} open={open} onClose={close} />
    </>
  );
}

/** Card body used in settings, onboarding and join: status line plus the connect button. */
export function TelegramLink({ vault }: { vault: Address }) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <TelegramButton vault={vault} className="pf-btn line" />
      </div>
      <p className="text-xs text-[var(--subtle)]">Get a message on every long delay, FLAG and settings change, so you can veto in time.</p>
    </div>
  );
}

function TelegramIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M21.9 4.3 18.7 19.5c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.2-8.3c.4-.4-.1-.6-.6-.2L6.1 13.2l-4.9-1.5c-1.1-.3-1.1-1.1.2-1.6L20.5 2.8c.9-.3 1.7.2 1.4 1.5Z" />
    </svg>
  );
}
