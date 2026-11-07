/**
 * Minimal key-value client over the Upstash Redis REST API, which is what Vercel KV exposes
 * (KV_REST_API_URL / KV_REST_API_TOKEN; UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN also accepted).
 * Fetch-based so route handlers stay dependency-free and tests can mock it.
 */
export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function kvFromEnv(env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch): KV | null {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashKv(url, token, f);
  // Vercel's own Redis (and any redis:// server) only sets REDIS_URL.
  const redisUrl = env.REDIS_URL ?? env.KV_URL;
  if (redisUrl) return redisKv(redisUrl);
  // No database: keep the map as a pinned message in a private Telegram channel the bot administers.
  const botToken = env.TELEGRAM_API_KEY || env.TELEGRAM_BOT_TOKEN;
  if (env.TELEGRAM_STORE_CHAT_ID && botToken) return telegramKv(botToken, env.TELEGRAM_STORE_CHAT_ID, f);
  // Local dev without Vercel KV: keep links in process memory (lost on restart).
  if (env.NODE_ENV !== "production") return memoryKv();
  return null;
}

export function memoryKv(): KV {
  const g = globalThis as { __palmfiKv?: Map<string, string> };
  const m = (g.__palmfiKv ??= new Map());
  return {
    async get(key) {
      return m.get(key) ?? null;
    },
    async set(key, value) {
      m.set(key, value);
    },
  };
}

export function upstashKv(url: string, token: string, f: typeof fetch = fetch): KV {
  const base = url.replace(/\/$/, "");
  async function cmd(args: string[]): Promise<unknown> {
    const res = await f(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`kv ${args[0]} failed: ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (body.error) throw new Error(`kv ${args[0]} error: ${body.error}`);
    return body.result;
  }
  return {
    async get(key) {
      const r = await cmd(["GET", key]);
      return typeof r === "string" ? r : null;
    },
    async set(key, value) {
      await cmd(["SET", key, value]);
    },
  };
}

export const chatKey = (vault: string) => `palmfi:chat:${vault.toLowerCase()}`;

/** TCP Redis client for REDIS_URL, one connection reused across warm invocations. */
export function redisKv(url: string): KV {
  const g = globalThis as { __palmfiRedis?: Promise<import("redis").RedisClientType> };
  const client = () =>
    (g.__palmfiRedis ??= import("redis").then(async ({ createClient }) => {
      const c = createClient({ url }) as import("redis").RedisClientType;
      c.on("error", () => {});
      await c.connect();
      return c;
    }).catch((e) => {
      g.__palmfiRedis = undefined;
      throw e;
    }));
  return {
    async get(key) {
      return (await client()).get(key);
    },
    async set(key, value) {
      await (await client()).set(key, value);
    },
  };
}

const STORE_HEADER = "palmfi link store (do not edit or unpin)";

/**
 * KV over Telegram: the whole map lives as JSON in one pinned message of `chatId` (a private channel where the bot
 * is admin). get reads it back via getChat().pinned_message; set edits that message, or posts and pins a new one.
 * Telegram caps a message at 4096 chars, which fits a few dozen vault→chat links.
 */
export function telegramKv(botToken: string, chatId: string, f: typeof fetch = fetch): KV {
  async function api<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await f(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const j = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result as T;
  }
  type Msg = { message_id: number; text?: string };
  async function load(): Promise<{ id?: number; map: Record<string, string> }> {
    const chat = await api<{ pinned_message?: Msg }>("getChat", { chat_id: chatId });
    const pin = chat.pinned_message;
    if (!pin?.text?.startsWith(STORE_HEADER)) return { map: {} };
    try {
      return { id: pin.message_id, map: JSON.parse(pin.text.slice(STORE_HEADER.length)) as Record<string, string> };
    } catch {
      return { map: {} };
    }
  }
  return {
    async get(key) {
      return (await load()).map[key] ?? null;
    },
    async set(key, value) {
      const { id, map } = await load();
      if (map[key] === value) return; // Telegram rejects an edit that changes nothing
      map[key] = value;
      const text = `${STORE_HEADER}\n${JSON.stringify(map)}`;
      if (text.length > 4096) throw new Error("Telegram link store is full");
      if (id) {
        await api("editMessageText", { chat_id: chatId, message_id: id, text });
      } else {
        const m = await api<Msg>("sendMessage", { chat_id: chatId, text, disable_notification: true });
        await api("pinChatMessage", { chat_id: chatId, message_id: m.message_id, disable_notification: true });
      }
    },
  };
}
