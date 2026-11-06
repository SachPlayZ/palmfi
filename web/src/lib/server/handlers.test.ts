import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { formatNotifyMessage, handleLinkToken, handleNotify, handleTelegramWebhook, parseNotifyBody, type Deps } from "./handlers";
import { chatKey, upstashKv, type KV } from "./kv";
import { linkMessage, makeLinkToken, verifyLinkToken } from "./telegram";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;

function memKv(init: Record<string, string> = {}): KV & { data: Record<string, string> } {
  const data = { ...init };
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => void (data[k] = v) };
}

function tgFetch(ok = true) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(ok ? { ok: true } : { ok: false, description: "chat not found" }), { status: ok ? 200 : 400 }),
  );
}

const env = { NOTIFY_API_KEY: "k3y", TELEGRAM_BOT_TOKEN: "123:abc", APP_URL: "https://palmfi.app" };

function notifyReq(body: unknown, key = "k3y") {
  return new Request("http://x/api/notify", {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("/api/notify", () => {
  it("rejects a wrong api key", async () => {
    const res = await handleNotify(notifyReq({ vault: VAULT, kind: "FLAG" }, "nope"), { env, kv: memKv(), fetch: tgFetch() });
    expect(res.status).toBe(401);
  });

  it("validates the body", async () => {
    const deps: Deps = { env, kv: memKv(), fetch: tgFetch() };
    expect((await handleNotify(notifyReq({ vault: "0x12", kind: "FLAG" }), deps)).status).toBe(400);
    expect((await handleNotify(notifyReq({ vault: VAULT, kind: "PARTY" }), deps)).status).toBe(400);
    expect((await handleNotify(notifyReq("{not json"), deps)).status).toBe(400);
    expect(parseNotifyBody({ vault: VAULT, kind: "delay", requestId: "0x10", reasonCodes: 5 })).toMatchObject({
      kind: "DELAY",
      requestId: "16",
      reasonCodes: "5",
    });
  });

  it("returns delivered=false when no chat is linked", async () => {
    const f = tgFetch();
    const res = await handleNotify(notifyReq({ vault: VAULT, kind: "DELAY", requestId: 1 }), { env, kv: memKv(), fetch: f });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("looks up vault→chatId and sends a Telegram message with decoded reason codes", async () => {
    const f = tgFetch();
    const kv = memKv({ [chatKey(VAULT)]: "4242" });
    const res = await handleNotify(
      notifyReq({ vault: VAULT.toUpperCase().replace("0X", "0x"), kind: "FLAG", requestId: "3", reasonCodes: String(2 | 64) }),
      { env, kv, fetch: f },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: true });
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const sent = JSON.parse(String(init?.body));
    expect(sent.chat_id).toBe("4242");
    expect(sent.text).toContain("FLAGGED");
    expect(sent.text).toContain("Request #3");
    expect(sent.text).toContain("NEW_DESTINATION, BLOCKLISTED_DEST");
    expect(sent.text).toContain(`/vault/${VAULT}/incident`);
  });

  it("fans out to every linked Voter chat and shows score and delay", async () => {
    const f = tgFetch();
    const kv = memKv({ [chatKey(VAULT)]: "1,2,3" });
    const res = await handleNotify(notifyReq({ vault: VAULT, kind: "DELAY", requestId: 7, score: "18000", delay: "133200" }), { env, kv, fetch: f });
    expect(await res.json()).toMatchObject({ delivered: true, chats: 3 });
    expect(f).toHaveBeenCalledTimes(3);
    const text = JSON.parse(String(f.mock.calls[0][1]?.body)).text;
    expect(text).toContain("Surprise score 18.0 bits");
    expect(text).toContain("Executable in 1d 13h");
  });

  it("reports Telegram failures as 502", async () => {
    const kv = memKv({ [chatKey(VAULT)]: "1" });
    const res = await handleNotify(notifyReq({ vault: VAULT, kind: "DELAY" }), { env, kv, fetch: tgFetch(false) });
    expect(res.status).toBe(502);
  });

  it("503s when unconfigured", async () => {
    const res = await handleNotify(notifyReq({ vault: VAULT, kind: "DELAY" }), { env: {}, kv: null, fetch: tgFetch() });
    expect(res.status).toBe(503);
  });

  it("formats config-change messages", () => {
    expect(formatNotifyMessage({ vault: VAULT, kind: "CONFIG_CHANGE", label: "alice.palmfi.eth" })).toContain("alice.palmfi.eth");
  });
});

describe("upstash kv client", () => {
  it("speaks the REST command protocol", async () => {
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const cmd = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: cmd[0] === "GET" ? "77" : "OK" }));
    });
    const kv = upstashKv("https://kv.example/", "tok", f as unknown as typeof fetch);
    await kv.set("a", "77");
    expect(await kv.get("a")).toBe("77");
    expect(f.mock.calls[0][0]).toBe("https://kv.example");
    expect((f.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual(["SET", "a", "77"]);
  });
});

describe("telegram linking", () => {
  const secret = "s3cret";
  const tgEnv = { ...env, TELEGRAM_WEBHOOK_SECRET: "hook", TELEGRAM_LINK_SECRET: secret, TELEGRAM_BOT_USERNAME: "palmfi_bot" };

  it("round-trips link tokens and rejects tampering", () => {
    const t = makeLinkToken(VAULT, secret);
    expect(t).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(verifyLinkToken(t, secret)).toBe(VAULT);
    expect(verifyLinkToken(t, "other")).toBeNull();
    expect(verifyLinkToken(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), secret)).toBeNull();
  });

  it("issues a deep link only to a Vault controller", async () => {
    const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const issuedAt = 1_800_000_000;
    const signature = await acct.signMessage({ message: linkMessage(VAULT, issuedAt) });
    const mk = (ok: boolean): Deps => ({
      env: tgEnv,
      kv: memKv(),
      fetch: tgFetch(),
      now: () => issuedAt * 1000,
      isController: async (v, s) => ok && v === VAULT && s === acct.address,
    });
    const req = () =>
      new Request("http://x", { method: "POST", body: JSON.stringify({ vault: VAULT, issuedAt, signature }) });
    const good = await handleLinkToken(req(), mk(true));
    expect(good.status).toBe(200);
    const body = (await good.json()) as { url: string; token: string };
    expect(body.url).toBe(`https://t.me/palmfi_bot?start=${body.token}`);
    expect((await handleLinkToken(req(), mk(false))).status).toBe(403);
  });

  it("stores chatId on /start <token> from the webhook", async () => {
    const kv = memKv();
    const f = tgFetch();
    const token = makeLinkToken(VAULT, secret);
    const update = { message: { text: `/start ${token}`, chat: { id: 99 } } };
    const bad = await handleTelegramWebhook(
      new Request("http://x", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: JSON.stringify(update) }),
      { env: tgEnv, kv, fetch: f },
    );
    expect(bad.status).toBe(401);
    const res = await handleTelegramWebhook(
      new Request("http://x", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook" }, body: JSON.stringify(update) }),
      { env: tgEnv, kv, fetch: f },
    );
    expect(await res.json()).toMatchObject({ linked: true });
    expect(kv.data[chatKey(VAULT)]).toBe("99");
    expect(f).toHaveBeenCalledOnce();
    // a second Voter links their own chat; relinking the first is idempotent
    const again = (id: number) =>
      handleTelegramWebhook(
        new Request("http://x", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook" }, body: JSON.stringify({ message: { text: `/start ${token}`, chat: { id } } }) }),
        { env: tgEnv, kv, fetch: f },
      );
    await again(100);
    await again(99);
    expect(kv.data[chatKey(VAULT)]).toBe("99,100");
  });

  it("ignores /start with a forged token", async () => {
    const kv = memKv();
    const update = { message: { text: `/start ${makeLinkToken(VAULT, "attacker")}`, chat: { id: 5 } } };
    const res = await handleTelegramWebhook(
      new Request("http://x", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "hook" }, body: JSON.stringify(update) }),
      { env: tgEnv, kv, fetch: tgFetch() },
    );
    expect(await res.json()).toMatchObject({ linked: false });
    expect(kv.data).toEqual({});
  });
});
