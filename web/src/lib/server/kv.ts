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
