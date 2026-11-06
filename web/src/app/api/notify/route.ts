import { handleNotify } from "@/lib/server/handlers";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Called by the Sentinel over Confidential HTTP: POST {vault, kind, requestId, reasonCodes}, header x-api-key. */
export async function POST(req: Request) {
  return handleNotify(req, serverDeps());
}
