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
  if (!url || !token) return null;
  return upstashKv(url, token, f);
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
