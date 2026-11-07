import { expect, test } from "vitest";
import { telegramKv } from "./kv";

/** A fake Bot API holding one chat's pinned message. */
function fakeTelegram() {
  let pinned: { message_id: number; text: string } | undefined;
  let next = 1;
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(method);
    let result: unknown = true;
    if (method === "getChat") result = { pinned_message: pinned };
    if (method === "sendMessage") result = { message_id: next++, text: body.text };
    if (method === "pinChatMessage") pinned = { message_id: body.message_id, text: lastSent };
    if (method === "editMessageText") pinned = { message_id: body.message_id, text: body.text };
    if (method === "sendMessage") lastSent = body.text;
    return new Response(JSON.stringify({ ok: true, result }));
  }) as typeof fetch;
  let lastSent = "";
  return { f, calls };
}

test("telegramKv stores the map in one pinned message", async () => {
  const t = fakeTelegram();
  const kv = telegramKv("123:abc", "-1001", t.f);
  expect(await kv.get("a")).toBeNull();
  await kv.set("a", "1");
  await kv.set("b", "2");
  await kv.set("b", "2"); // unchanged: no edit
  expect(await kv.get("a")).toBe("1");
  expect(await kv.get("b")).toBe("2");
  expect(t.calls.filter((c) => c === "sendMessage")).toHaveLength(1);
  expect(t.calls.filter((c) => c === "editMessageText")).toHaveLength(1);
});
