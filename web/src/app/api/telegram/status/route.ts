import { handleTelegramStatus } from "@/lib/server/handlers";
import { pollTelegram, serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether any Telegram chat is linked to ?vault=; polls the bot when no webhook is configured. */
export async function GET(req: Request) {
  return handleTelegramStatus(req, serverDeps(), pollTelegram);
}
