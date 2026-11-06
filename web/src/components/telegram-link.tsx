"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useSignMessage } from "wagmi";
import { Button } from "./ui";

// Mirrors linkMessage() in lib/server/telegram.ts (kept client-side to avoid bundling node:crypto).
const linkMessage = (vault: Address, issuedAt: number) => `palmfi: link Telegram notifications for Vault ${vault} (issued ${issuedAt})`;

/** Signs a link request as the Vault's owner / Hot wallet and opens the bot deep link (t.me/<bot>?start=<token>). */
export function TelegramLink({ vault }: { vault: Address }) {
  const { signMessageAsync } = useSignMessage();
  const [msg, setMsg] = useState<string>();
  const [url, setUrl] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function link() {
    setBusy(true);
    setMsg(undefined);
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
      setMsg("Press Start in Telegram to finish linking.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={link} disabled={busy}>
          {busy ? "Waiting for signature…" : "Link Telegram"}
        </Button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="text-xs underline">
            open the bot again
          </a>
        )}
      </div>
      <p className="text-xs text-[var(--subtle)]">{msg ?? "Get a message on every HOLD, FLAG and pending settings change."}</p>
    </div>
  );
}
