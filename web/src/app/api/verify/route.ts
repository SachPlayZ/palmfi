import { createPublicClient, http, isAddress, parseAbi, recoverMessageAddress, type Hex } from "viem";
import { deployments } from "@/lib/deployments";
import { arcTestnet } from "@/lib/network";
import { kvFromEnv } from "@/lib/server/kv";
import { adminMessage, verifyMessage, type VerifyRequest } from "@/lib/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "verify:requests";
const MAX_AGE = 10 * 60;
const abi = parseAbi(["function isWallet(address) view returns (bool)", "function admin() view returns (address)"]);

const client = () => createPublicClient({ chain: arcTestnet, transport: http(process.env.ARC_RPC_URL || process.env.NEXT_PUBLIC_ARC_RPC_URL) });
const fresh = (t: number) => Number.isFinite(t) && Math.abs(Date.now() / 1000 - t) < MAX_AGE;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

export async function POST(req: Request) {
  const kv = kvFromEnv();
  if (!kv) return json({ ok: false, error: "Verification requests aren't configured on this deployment" }, 503);
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const vault = b.vault as string;
  const issuedAt = Number(b.issuedAt);
  if (!isAddress(vault) || !fresh(issuedAt) || typeof b.signature !== "string") return json({ ok: false, error: "Bad request" }, 400);
  const signer = await recoverMessageAddress({ message: verifyMessage(vault, issuedAt), signature: b.signature as Hex });
  const isWallet = await client()
    .readContract({ address: vault, abi, functionName: "isWallet", args: [signer] })
    .catch(() => false);
  if (!isWallet) return json({ ok: false, error: "Only one of the vault's wallets can request verification" }, 403);
  const entry: VerifyRequest = {
    vault,
    name: clip(b.name, 32),
    legalName: clip(b.legalName, 120),
    website: clip(b.website, 200),
    email: clip(b.email, 200),
    jurisdiction: clip(b.jurisdiction, 80),
    signer,
    at: Math.floor(Date.now() / 1000),
  };
  if (!entry.legalName || !entry.email) return json({ ok: false, error: "Legal name and contact email are required" }, 400);
  const list = JSON.parse((await kv.get(KEY)) ?? "[]") as VerifyRequest[];
  const next = [entry, ...list.filter((r) => r.vault.toLowerCase() !== vault.toLowerCase())].slice(0, 500);
  await kv.set(KEY, JSON.stringify(next));
  return json({ ok: true });
}

/** Admin-only: ?issuedAt=…&signature=… signed by the Hub admin. */
export async function GET(req: Request) {
  const kv = kvFromEnv();
  if (!kv) return json({ ok: false, error: "not configured" }, 503);
  const u = new URL(req.url);
  const issuedAt = Number(u.searchParams.get("issuedAt"));
  const signature = u.searchParams.get("signature") as Hex | null;
  if (!signature || !fresh(issuedAt) || !deployments.hub) return json({ ok: false, error: "Bad request" }, 400);
  const signer = await recoverMessageAddress({ message: adminMessage(issuedAt), signature });
  const admin = await client().readContract({ address: deployments.hub, abi, functionName: "admin" });
  if (signer.toLowerCase() !== admin.toLowerCase()) return json({ ok: false, error: "Hub admin only" }, 403);
  return json({ ok: true, requests: JSON.parse((await kv.get(KEY)) ?? "[]") });
}
