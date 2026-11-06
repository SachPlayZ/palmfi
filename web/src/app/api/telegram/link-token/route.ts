import { handleLinkToken } from "@/lib/server/handlers";
import { serverDeps } from "@/lib/server/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signed by a Vault controller; returns the t.me deep link for that Vault. */
export async function POST(req: Request) {
  return handleLinkToken(req, serverDeps());
}
