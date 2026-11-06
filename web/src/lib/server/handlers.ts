/**
 * Route handler logic for /api/notify and the Telegram link flow, written against injected deps so it can be
 * unit-tested with a mocked fetch and KV.
 */
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { decodeReasonCodes, formatBits, formatDuration } from "../palm";
import { chatKey, type KV } from "./kv";
import { linkMessage, makeLinkToken, safeEqual, sendTelegram, verifyLinkToken } from "./telegram";

export type Env = Record<string, string | undefined>;

/** The bot token: TELEGRAM_API_KEY, or the older TELEGRAM_BOT_TOKEN name. */
export const botTokenOf = (env: Env) => env.TELEGRAM_API_KEY || env.TELEGRAM_BOT_TOKEN || undefined;

export type Deps = {
  env: Env;
  kv: KV | null;
  fetch: typeof fetch;
  /** Whether `signer` is one of `vault`'s wallets (Voters) or its Recovery key. */
  isController?: (vault: Address, signer: Address) => Promise<boolean>;
  now?: () => number;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const NOTIFY_KINDS = ["DELAY", "FLAG", "FREEZE", "CONFIG_CHANGE", "UNFROZEN", "MIGRATED", "TEST"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifyBody = {
  vault: Address;
  kind: NotifyKind;
  requestId?: string;
  reasonCodes?: string;
  /** Milli-bits. */
  score?: string;
  /** Seconds. */
  delay?: string;
  label?: string;
};

function parseUint(v: unknown): string | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v).toString();
  return null;
}

export function parseNotifyBody(raw: unknown): NotifyBody | string {
  if (!raw || typeof raw !== "object") return "body must be a JSON object";
  const b = raw as Record<string, unknown>;
  if (typeof b.vault !== "string" || !isAddress(b.vault)) return "vault must be an address";
  if (typeof b.kind !== "string" || !(NOTIFY_KINDS as readonly string[]).includes(b.kind.toUpperCase())) {
    return `kind must be one of ${NOTIFY_KINDS.join(", ")}`;
  }
  const requestId = parseUint(b.requestId);
  if (requestId === null) return "requestId must be a non-negative integer";
  const reasonCodes = parseUint(b.reasonCodes);
  if (reasonCodes === null) return "reasonCodes must be a non-negative integer bitmap";
  const score = parseUint(b.score);
  const delay = parseUint(b.delay);
  if (score === null || delay === null) return "score and delay must be non-negative integers";
  return {
    vault: getAddress(b.vault),
    kind: b.kind.toUpperCase() as NotifyKind,
    requestId,
    reasonCodes,
    score,
    delay,
    label: typeof b.label === "string" ? b.label.slice(0, 64) : undefined,
  };
}

export function formatNotifyMessage(b: NotifyBody, appUrl?: string): string {
  const who = b.label ? `${b.label}` : b.vault;
  const head: Record<NotifyKind, string> = {
    DELAY: "Unusual Queued request: vote now if you don't recognise it",
    FLAG: "Queued request FLAGGED: your Vault is Frozen",
    FREEZE: "Your Vault is Frozen",
    CONFIG_CHANGE: "A settings change is pending on your Vault",
    UNFROZEN: "Your Vault was unfrozen",
    MIGRATED: "Your Vault was migrated to its Recovery vault",
    TEST: "Telegram notifications are linked",
  };
  const lines = [`palmfi | ${who}`, head[b.kind]];
  if (b.requestId !== undefined) lines.push(`Request #${b.requestId}`);
  if (b.score !== undefined && b.score !== "0") lines.push(`Surprise score ${formatBits(Number(b.score))}`);
  if (b.kind === "DELAY" && b.delay !== undefined) lines.push(`Executable in ${formatDuration(Number(b.delay))} unless a majority vetoes`);
  if (b.reasonCodes !== undefined && b.reasonCodes !== "0") {
    const codes = decodeReasonCodes(BigInt(b.reasonCodes));
    if (codes.length) lines.push(`Reasons: ${codes.map((c) => c.code).join(", ")}`);
  }
  if (b.kind === "FLAG" || b.kind === "FREEZE") lines.push("If this wasn't you, open the incident view now.");
  if (b.kind === "CONFIG_CHANGE") lines.push("If no wallet of yours proposed it, cancel it from the dashboard.");
  if (appUrl) {
    const base = appUrl.replace(/\/$/, "");
    lines.push(b.kind === "FLAG" || b.kind === "FREEZE" ? `${base}/vault/${b.vault}/incident` : `${base}/vault/${b.vault}`);
  }
  return lines.join("\n");
}

/** POST /api/notify {vault, kind, requestId, reasonCodes} with header x-api-key. */
export async function handleNotify(req: Request, deps: Deps): Promise<Response> {
  const expected = deps.env.NOTIFY_API_KEY;
  if (!expected) return json(503, { ok: false, error: "NOTIFY_API_KEY not configured" });
  const got = req.headers.get("x-api-key") ?? "";
  if (!safeEqual(got, expected)) return json(401, { ok: false, error: "bad api key" });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const body = parseNotifyBody(raw);
  if (typeof body === "string") return json(400, { ok: false, error: body });

  const botToken = botTokenOf(deps.env);
  if (!botToken) return json(503, { ok: false, error: "TELEGRAM_API_KEY not configured" });
  if (!deps.kv) return json(503, { ok: false, error: "KV not configured" });

  const chats = parseChats(await deps.kv.get(chatKey(body.vault)));
  // 200 so the Sentinel doesn't retry: an unlinked Vault is a normal case.
  if (!chats.length) return json(200, { ok: true, delivered: false, reason: "no Telegram chat linked for this Vault" });

  // Fan out to every Voter's chat, so a hacked requester can't mute the others.
  const text = formatNotifyMessage(body, deps.env.APP_URL);
  const sent = await Promise.all(chats.map((c) => sendTelegram(botToken, c, text, deps.fetch)));
  const ok = sent.filter((r) => r.ok).length;
  if (!ok) return json(502, { ok: false, delivered: false, error: sent[0].description ?? `telegram ${sent[0].status}` });
  return json(200, { ok: true, delivered: true, chats: ok });
}

/** KV holds every linked chat of a Vault as a comma-separated list. */
export const parseChats = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

function linkSecret(env: Env): string | undefined {
  return env.TELEGRAM_LINK_SECRET ?? botTokenOf(env);
}

/**
 * POST /api/telegram/link-token {vault, issuedAt, signature}: one of the Vault's wallets (or its Recovery key)
 * signs linkMessage(vault, issuedAt); we return the bot deep link that carries an HMAC'd token for that Vault.
 */
export async function handleLinkToken(req: Request, deps: Deps): Promise<Response> {
  const secret = linkSecret(deps.env);
  const bot = deps.env.TELEGRAM_BOT_USERNAME ?? deps.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;
  if (!secret || !bot) return json(503, { ok: false, error: "Telegram bot not configured" });
  let b: { vault?: unknown; issuedAt?: unknown; signature?: unknown };
  try {
    b = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  if (typeof b.vault !== "string" || !isAddress(b.vault)) return json(400, { ok: false, error: "vault must be an address" });
  if (typeof b.issuedAt !== "number" || typeof b.signature !== "string") {
    return json(400, { ok: false, error: "issuedAt and signature required" });
  }
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  if (Math.abs(now - b.issuedAt) > 600) return json(400, { ok: false, error: "signature expired" });
  const vault = getAddress(b.vault);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: linkMessage(vault, b.issuedAt), signature: b.signature as Hex });
  } catch {
    return json(400, { ok: false, error: "bad signature" });
  }
  if (!deps.isController || !(await deps.isController(vault, signer))) {
    return json(403, { ok: false, error: "signer does not control this Vault" });
  }
  const token = makeLinkToken(vault, secret);
  return json(200, { ok: true, token, url: `https://t.me/${bot}?start=${token}` });
}

export type TelegramUpdate = { message?: { text?: string; chat?: { id?: number | string } } };

/**
 * POST /api/telegram/link: the bot's webhook. On `/start <token>` it stores vault → chatId in KV.
 * Telegram is configured with secret_token = TELEGRAM_WEBHOOK_SECRET, sent back in x-telegram-bot-api-secret-token.
 */
export async function handleTelegramWebhook(req: Request, deps: Deps): Promise<Response> {
  const hookSecret = deps.env.TELEGRAM_WEBHOOK_SECRET;
  if (!hookSecret) return json(503, { ok: false, error: "TELEGRAM_WEBHOOK_SECRET not configured" });
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", hookSecret)) {
    return json(401, { ok: false, error: "bad webhook secret" });
  }
  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    return json(400, { ok: false, error: "invalid JSON" });
  }
  const r = await processTelegramUpdate(update, deps);
  if (r === "not configured") return json(503, { ok: false, error: r });
  return json(200, { ok: true, ...r });
}

/** Handles one bot update (from the webhook or from getUpdates polling): `/start <token>` links the chat. */
export async function processTelegramUpdate(update: TelegramUpdate, deps: Deps): Promise<{ linked: boolean; vault?: Address } | "not configured"> {
  const secret = linkSecret(deps.env);
  const botToken = botTokenOf(deps.env);
  if (!secret || !botToken || !deps.kv) return "not configured";
  const text = update.message?.text?.trim() ?? "";
  const chatId = update.message?.chat?.id;
  // Always 200 for updates we ignore, so Telegram doesn't redeliver them.
  if (chatId === undefined) return { linked: false };
  const m = /^\/start(?:@\w+)?\s+(\S+)$/.exec(text);
  if (!m) {
    await sendTelegram(botToken, String(chatId), "Open palmfi and use \"Connect Telegram\" on your Vault to connect this chat.", deps.fetch);
    return { linked: false };
  }
  const vault = verifyLinkToken(m[1], secret);
  if (!vault) {
    await sendTelegram(botToken, String(chatId), "That link is invalid. Generate a new one from your Vault in palmfi.", deps.fetch);
    return { linked: false };
  }
  const chats = parseChats(await deps.kv.get(chatKey(vault)));
  if (!chats.includes(String(chatId))) await deps.kv.set(chatKey(vault), [...chats, String(chatId)].join(","));
  await sendTelegram(
    botToken,
    String(chatId),
    `Linked. This chat will get palmfi alerts (unusual requests, FLAG, Freeze, settings changes) for Vault ${vault}.`,
    deps.fetch,
  );
  return { linked: true, vault };
}

/**
 * GET /api/telegram/status?vault=0x…: how many Telegram chats are linked to the Vault. Without a webhook
 * (local dev: TELEGRAM_WEBHOOK_SECRET unset) it first drains the bot's getUpdates queue, so `/start` still links.
 */
export async function handleTelegramStatus(req: Request, deps: Deps, poll?: () => Promise<TelegramUpdate[]>): Promise<Response> {
  const vault = new URL(req.url).searchParams.get("vault") ?? "";
  if (!isAddress(vault)) return json(400, { ok: false, error: "vault must be an address" });
  const botToken = botTokenOf(deps.env);
  if (!botToken || !deps.kv) return json(503, { ok: false, error: "Telegram bot not configured" });
  if (!deps.env.TELEGRAM_WEBHOOK_SECRET && poll) {
    for (const u of await poll().catch(() => [])) await processTelegramUpdate(u, deps);
  }
  const chats = parseChats(await deps.kv.get(chatKey(getAddress(vault))));
  return json(200, { ok: true, linked: chats.length > 0, chats: chats.length });
}
