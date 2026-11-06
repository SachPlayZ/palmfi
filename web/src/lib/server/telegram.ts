import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";

export async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  f: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; description?: string }> {
  const res = await f(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  let description: string | undefined;
  try {
    description = ((await res.json()) as { description?: string }).description;
  } catch {
    /* non-JSON */
  }
  return { ok: res.ok, status: res.status, description };
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Deep-link token for t.me/<bot>?start=<token> (Telegram allows 64 chars of [A-Za-z0-9_-]).
 * token = base64url(vault[20] ‖ HMAC-SHA256(secret, "palmfi.tg:" ‖ vault)[0:16]) → 48 chars.
 */
export function makeLinkToken(vault: Address, secret: string): string {
  const v = Buffer.from(getAddress(vault).slice(2), "hex");
  const mac = createHmac("sha256", secret).update("palmfi.tg:").update(v).digest().subarray(0, 16);
  return b64url(Buffer.concat([v, mac]));
}

export function verifyLinkToken(token: string, secret: string): Address | null {
  if (!/^[A-Za-z0-9_-]{48}$/.test(token)) return null;
  const raw = Buffer.from(token.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (raw.length !== 36) return null;
  const vault = `0x${raw.subarray(0, 20).toString("hex")}`;
  if (!isAddress(vault)) return null;
  return safeEqual(makeLinkToken(vault, secret), token) ? getAddress(vault) : null;
}

export function linkMessage(vault: Address, issuedAt: number): string {
  return `palmfi: link Telegram notifications for Vault ${getAddress(vault)} (issued ${issuedAt})`;
}
