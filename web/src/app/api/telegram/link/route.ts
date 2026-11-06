import { handleTelegramWebhook } from "@/lib/server/handlers";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Telegram bot webhook: `/start <token>` from the deep link stores vault → chatId in KV. */
export async function POST(req: Request) {
  return handleTelegramWebhook(req, serverDeps());
}
