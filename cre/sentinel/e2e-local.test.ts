#!/usr/bin/env bun
/**
 * Local end-to-end run of the whole protocol on an Anvil fork of Arc: contracts deployed fresh, the REAL
 * Sentinel (`onHubLog`) and Reconciler (`onCron`) handlers reading the live chain through their capability
 * interfaces, and every report they produce written onchain through the CRE simulation forwarder.
 *
 *   anvil --fork-url $ARC_RPC_URL --auto-impersonate   # then deploy (contracts/script/Deploy.s.sol)
 *   E2E_DEPLOYMENT=path/to/local.json bun test sentinel/e2e-local.test.ts   (skipped without E2E_DEPLOYMENT)
 *
 * Only for a local Anvil node: it uses Anvil's well-known dev keys and impersonation.
 */
import type { EVMLog } from "@chainlink/cre-sdk";
import { ConfidentialHttpMock, EvmMock, newTestRuntime, test as creTest } from "@chainlink/cre-sdk/test";
import { describe } from "bun:test";
import {
  bytesToHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  hexToBytes,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { onHubLog, type Config as SConfig } from "./main";
import { onCron, type Config as RConfig } from "../reconciler/main";
import { hubEventsAbi } from "../shared/abi";
import { ARC } from "../shared/testing";
import * as P from "../shared/palm";

const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8545";
const ENABLED = !!process.env.E2E_DEPLOYMENT;
const dep = ENABLED ? JSON.parse(await Bun.file(process.env.E2E_DEPLOYMENT!).text()) : {};
const arc = JSON.parse(await Bun.file(`${import.meta.dir}/../../config/arc.json`).text());
const USDC = arc.tokens.usdc as Address;
const FORWARDER = arc.cre.simForwarder as Address;
const outRaw = async (n: string) =>
  JSON.parse(await Bun.file(`${import.meta.dir}/../../contracts/out/${n}.sol/${n}.json`).text()).abi as Abi;
const out = (n: string) => ABIS[n];
const ABIS: Record<string, Abi> = Object.fromEntries(
  !ENABLED ? [] : await Promise.all(["Vault", "VaultModule", "VaultFactory", "Hub", "OrbitalHook", "OrbitalRouter", "ProtectedToken"].map(async (n) => [n, await outRaw(n)])),
);
const ABI = !ENABLED ? ({} as never) : {
  vault: [...out("Vault"), ...out("VaultModule").filter((x: { type: string }) => x.type !== "constructor")] as Abi,
  factory: out("VaultFactory"),
  hub: out("Hub"),
  hook: out("OrbitalHook"),
  router: out("OrbitalRouter"),
  token: out("ProtectedToken"),
  erc20: parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]),
};

const chain = { id: 5042002, name: "arc-fork", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
// Index 0 is Anvil's deployer (Hub admin). Everyone else is a fresh key: Anvil's public dev keys carry EIP-7702
// delegations on Arc testnet, which the Vault (correctly) refuses as unapproved delegates.
const acct = (i: number) =>
  i === 0
    ? mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 0 })
    : privateKeyToAccount(keccak256(toHex(`palmfi-e2e-local-${i}`)));
const W = Array.from({ length: 16 }, (_, i) => acct(i));
const wallet = (i: number) => createWalletClient({ account: W[i], chain, transport: http(RPC) });

// --- cast-backed synchronous RPC for the CRE capability mocks (the SDK's capability calls are synchronous) ---
const sh = (args: string[]) => {
  const r = Bun.spawnSync(["cast", ...args, "--rpc-url", RPC]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

const notifications: { kind: string; vault: string; requestId: string }[] = [];
let reportsWritten = 0;
let reportsRejected = 0;

function installLiveCapabilities() {
  const evm = EvmMock.testInstance(ARC);
  evm.callContract = (req) => {
    const to = bytesToHex(req.call!.to);
    const data = bytesToHex(req.call!.data);
    const hex = sh(["call", to, data]) as Hex;
    return { data: Buffer.from(hex.slice(2), "hex").toString("base64") };
  };
  evm.headerByNumber = () => {
    const ts = sh(["block", "latest", "--field", "timestamp"]);
    const n = sh(["block-number"]);
    return { header: { timestamp: BigInt(ts).toString(), blockNumber: { absVal: Buffer.from(pad(toHex(BigInt(n)), { size: 8 }).slice(2), "hex").toString("base64"), sign: "1" } } };
  };
  evm.writeReport = (req) => {
    const raw = bytesToHex(req.report!.rawReport);
    const payload = `0x${raw.slice(2 + 109 * 2)}` as Hex;
    // The forwarder calls Hub.onReport(metadata, report); the simulation forwarder carries no metadata.
    const r = Bun.spawnSync(["cast", "send", dep.hub, "onReport(bytes,bytes)", "0x", payload, "--from", FORWARDER, "--unlocked", "--json", "--rpc-url", RPC]);
    const ok = r.exitCode === 0 && JSON.parse(r.stdout.toString()).status === "0x1";
    if (ok) {
      const rcpt = JSON.parse(r.stdout.toString());
      const rejected = rcpt.logs.some((l: { topics: Hex[] }) => {
        try {
          return decodeEventLog({ abi: ABI.hub, data: (l as unknown as { data: Hex }).data, topics: l.topics as [Hex] }).eventName === "ReportRejected";
        } catch {
          return false;
        }
      });
      if (rejected) reportsRejected++;
      else reportsWritten++;
    }
    return {
      txStatus: ok ? "TX_STATUS_SUCCESS" : "TX_STATUS_REVERTED",
      receiverContractExecutionStatus: ok ? "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS" : "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED",
    } as never;
  };
  const httpMock = ConfidentialHttpMock.testInstance();
  httpMock.sendRequest = (req) => {
    const r = req.request!;
    const body = r.body.case === "bodyString" ? JSON.parse(r.body.value) : {};
    notifications.push({ kind: body.kind, vault: body.vault, requestId: String(body.requestId ?? "") });
    return { statusCode: 200 };
  };
}

const sentinelCfg: SConfig = JSON.parse(await Bun.file(`${import.meta.dir}/config.staging.json`).text());
sentinelCfg.hub = dep.hub;
sentinelCfg.notify = { url: "https://notify.local/api/notify", apiKeySecret: "notifyApiKey" };
const reconCfg: RConfig = JSON.parse(await Bun.file(`${import.meta.dir}/../reconciler/config.staging.json`).text());
reconCfg.hub = dep.hub;
reconCfg.notify = sentinelCfg.notify;

/** Feed every Hub log of a receipt to the Sentinel, as the CRE log trigger would. */
async function sentinel(hash: Hex): Promise<string[]> {
  const rcpt = await pub.getTransactionReceipt({ hash });
  const res: string[] = [];
  for (const l of rcpt.logs) {
    if (l.address.toLowerCase() !== dep.hub.toLowerCase()) continue;
    let name: string;
    try {
      name = decodeEventLog({ abi: hubEventsAbi, data: l.data, topics: l.topics as [Hex] }).eventName;
    } catch {
      continue;
    }
    if (!["RequestQueued", "ConfigChange", "Outflow"].includes(name)) continue;
    installLiveCapabilities();
    const runtime = newTestRuntime<SConfig>(new Map([["", new Map([["notifyApiKey", "k"]])]]));
    runtime.config = sentinelCfg;
    const log = {
      address: hexToBytes(l.address),
      topics: l.topics.map((t) => hexToBytes(t)),
      data: hexToBytes(l.data),
      txHash: hexToBytes(hash),
      blockHash: hexToBytes(l.blockHash!),
      eventSig: hexToBytes(l.topics[0]!),
      blockNumber: { absVal: hexToBytes(pad(toHex(l.blockNumber!), { size: 8 })), sign: 1n },
      txIndex: 0,
      index: l.logIndex!,
      removed: false,
    } as unknown as EVMLog;
    res.push(onHubLog(runtime, log));
  }
  return res;
}

let slot = 0n;
function reconciler(): string {
  installLiveCapabilities();
  const runtime = newTestRuntime<RConfig>(new Map([["", new Map([["notifyApiKey", "k"]])]]));
  runtime.config = reconCfg;
  return onCron(runtime, { scheduledExecutionTime: { seconds: ++slot + BigInt(Date.now()) } } as never);
}

// --- tx helpers ---
async function send(i: number, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<Hex> {
  let request: unknown;
  try {
    ({ request } = await pub.simulateContract({ account: W[i], address, abi, functionName, args } as never));
  } catch (e) {
    throw new Error(`${functionName} by W${i} reverted: ${(e as { shortMessage?: string }).shortMessage ?? String(e).slice(0, 300)}`);
  }
  const hash = await wallet(i).writeContract(request as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}
async function reverts(i: number, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<string> {
  try {
    await pub.simulateContract({ account: W[i], address, abi, functionName, args } as never);
  } catch (e) {
    const m = String((e as Error).message);
    return m.match(/reverted with the following reason:\s*\n?(.*)/)?.[1] ?? m.match(/Error: (\w+\(.*?\))/)?.[1] ?? m.split("\n")[0];
  }
  throw new Error(`${functionName} should have reverted`);
}
const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args } as never) as Promise<never>;
const warp = async (s: number) => {
  await test.increaseTime({ seconds: s });
  await test.mine({ blocks: 1 });
};
/** Advance to a request's executableAt (plus a second). */
async function warpTo(vault: Address, id: bigint) {
  const r = (await read(vault, ABI.vault, "getRequest", [id])) as { executableAt: bigint };
  const now = (await pub.getBlock()).timestamp;
  if (r.executableAt > now) await warp(Number(r.executableAt - now) + 1);
}

/** MockUSDC (OZ ERC20, balances at slot 0) — mint by writing storage. */
async function fundUsdc(to: Address, amount: bigint) {
  const slotKey = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, 0n]));
  const bal = (await read(USDC, ABI.erc20, "balanceOf", [to])) as bigint;
  await test.setStorageAt({ address: USDC, index: slotKey, value: pad(toHex(bal + amount)) });
  const ts = BigInt(await pub.getStorageAt({ address: USDC, slot: toHex(2) }) ?? "0x0");
  await test.setStorageAt({ address: USDC, index: toHex(2, { size: 32 }), value: pad(toHex(ts + amount)) });
}

// --- assertions & log ---
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failures.push(`${name} ${detail}`);
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? `  (${detail})` : ""}`);
}
const step = (s: string) => console.log(`\n▶ ${s}`);
const u = (n: number) => BigInt(Math.round(n * 1e6));

async function main() {
  const [deployer] = [0];
  // nvidia: W1..W3 wallets, W4 recovery key, W5 recovery vault. palantir: W6..W8. evil: W9..W11. attacker: W12.
  const NV = [W[1], W[2], W[3]].map((a) => a.address);
  const PL = [W[6], W[7], W[8]].map((a) => a.address);
  const EV = [W[9], W[10], W[11]].map((a) => a.address);
  const RECOVERY_KEY = 4;
  const attacker = W[12].address;
  const hour = Math.floor(Date.now() / 1000 / 3600) % 24;

  const cfg = (wallets: Address[], destinations: Address[] = []) => ({
    wallets,
    recoveryKey: W[RECOVERY_KEY].address,
    recoveryVault: W[5].address,
    budget24h: u(500),
    budget7d: u(2000),
    hardCap: u(5000),
    floorDelay: 60,
    maxDelay: 72 * 3600,
    capDelay: 24 * 3600,
    destinations,
    bizStartHourUtc: 0,
    bizEndHourUtc: 24 > hour ? 24 : hour + 1,
    usualMaxPayout: u(1000),
  });

  for (let i = 1; i < W.length; i++) await test.setBalance({ address: W[i].address, value: 10n ** 21n });

  step("Reconciler first pass: heartbeat → CRE live");
  console.log("   ", reconciler());
  check("Hub.creLive() after heartbeat", (await read(dep.hub, ABI.hub, "creLive")) === true);

  step("Onboard nvidia, palantir, evilcorp (Vault + Protected token + Hub name + Orbital seat)");
  for (const [name, ws, by] of [["nvidia", NV, 1], ["palantir", PL, 6], ["evilcorp", EV, 9]] as const) {
    await send(by, dep.factory, ABI.factory, "createVault", [name, cfg([...ws])]);
  }
  const vaultOf = async (n: string) => (await read(dep.hub, ABI.hub, "resolve", [n])) as Address;
  const nv = await vaultOf("nvidia");
  const pl = await vaultOf("palantir");
  const ev = await vaultOf("evilcorp");
  const tokenOf = async (v: Address) => (await read(v, ABI.vault, "token")) as Address;
  const [nt, pt, et] = [await tokenOf(nv), await tokenOf(pl), await tokenOf(ev)];
  check("three Vaults registered in the Hub", [nv, pl, ev].every((v) => v && v !== "0x0000000000000000000000000000000000000000"));
  await send(deployer, dep.hub, ABI.hub, "setVerified", [nv, true]);

  step("Deposit USDC and seed the Orbital pool");
  for (const [v, t, ws] of [[nv, nt, [1, 2, 3]], [pl, pt, [6, 7, 8]], [ev, et, [9, 10, 11]]] as const) {
    for (const i of ws) {
      await fundUsdc(W[i].address, u(12_000));
      await send(i, USDC, ABI.erc20, "approve", [v, u(12_000)]);
      await send(i, v, ABI.vault, "deposit", [u(12_000), W[i].address]);
    }
    await send(ws[0], t, ABI.token, "approve", [dep.orbitalHook, u(10_000)]);
    await send(ws[0], dep.orbitalHook, ABI.hook, "addLiquidity", [t, u(10_000)]);
  }
  // Wallets older than 7 days, like any real deployment (otherwise every request carries NEW_WALLET bits).
  await warp(8 * 24 * 3600);
  console.log("   ", reconciler());
  check("pool funded", ((await read(dep.orbitalHook, ABI.hook, "reserveOf", [pt])) as bigint) === u(10_000));

  step("Routine payroll history: nvidia pays palantir (queued → Sentinel scores → executes)");
  for (let k = 0; k < 4; k++) {
    const payer = 1 + (k % 3);
    const h = await send(payer, nv, ABI.vault, "requestPayment", [pl, u(100 + 10 * k)]);
    const s = await sentinel(h);
    console.log("   ", s.join(" | "));
    const id = (await read(nv, ABI.vault, "nextRequestId")) as bigint;
    const r = (await read(nv, ABI.vault, "getRequest", [id])) as { scored: boolean; executableAt: bigint; state: number };
    check(`payment #${id} scored by the Sentinel`, r.scored, s.join(""));
    await warpTo(nv, id);
    await send(1, nv, ABI.vault, "execute", [id]);
    check(`payment #${id} executed`, ((await read(nv, ABI.vault, "getRequest", [id])) as { state: number }).state === P.REQ_EXECUTED);
  }
  console.log("   ", reconciler());

  step("Pay by name through the Orbital pool: palantir → nvidia (requestSwap → Sentinel → swap → settle)");
  {
    const h = await send(6, pl, ABI.vault, "requestSwap", [u(60)]);
    console.log("   ", (await sentinel(h)).join(" | "));
    await warpTo(pl, (await read(pl, ABI.vault, "nextRequestId")) as bigint);
    console.log("   ", reconciler());
    await send(6, pt, ABI.token, "approve", [dep.orbitalRouter, u(1_000)]);
    const before = (await read(nt, ABI.token, "balanceOf", [NV[0]])) as bigint;
    const sh2 = await send(6, dep.orbitalRouter, ABI.router, "swap", [pt, nt, u(50), false, u(60), NV[0]]);
    console.log("   ", (await sentinel(sh2)).join(" | "));
    check("nvidia wallet received 50 nvidiaUSDC", ((await read(nt, ABI.token, "balanceOf", [NV[0]])) as bigint) - before === u(50));
    await send(0, dep.orbitalHook, ABI.hook, "settle");
    check("settlement cleared pool imbalance", ((await read(dep.orbitalHook, ABI.hook, "reserveOf", [nt])) as bigint) === u(10_000));
  }

  step("HACK: attacker holds nvidia wallet #3's key and tries to drain 5,000 to a fresh address");
  let hackId = 0n;
  {
    console.log("   ", reconciler());
    const h = await send(3, nv, ABI.vault, "requestUnwrap", [u(5_000), attacker]);
    const s = await sentinel(h);
    console.log("   ", s.join(" | "));
    hackId = (await read(nv, ABI.vault, "nextRequestId")) as bigint;
    const r = (await read(nv, ABI.vault, "getRequest", [hackId])) as { state: number; reasonCodes: bigint; score: number };
    check("Sentinel FLAGged the drain", r.state === P.REQ_FLAGGED, `state=${r.state} score=${r.score} [${P.reasonNames(r.reasonCodes)}]`);
    check("Hub froze nvidia", Number(await read(dep.hub, ABI.hub, "statusOf", [nv])) === P.STATUS_FROZEN);
    check("attacker destination blocklisted network-wide", (await read(dep.hub, ABI.hub, "isBlocked", [attacker])) === true);
    check("attacker received nothing", ((await read(USDC, ABI.erc20, "balanceOf", [attacker])) as bigint) === 0n);
    check("Voters alerted (FLAG notification)", notifications.some((n) => n.kind === "FLAG"));
    console.log("    attacker retries:", await reverts(3, nv, ABI.vault, "requestUnwrap", [u(100), attacker]));
    console.log("    pool payment to frozen nvidia:", await reverts(6, dep.orbitalRouter, ABI.router, "swap", [pt, nt, u(10), false, u(20), NV[0]]));
  }

  step("Reconciler pass while frozen (health: reserves, delegations)");
  console.log("   ", reconciler());
  check("nvidia still frozen, not re-flagged into a worse state", Number(await read(dep.hub, ABI.hub, "statusOf", [nv])) === P.STATUS_FROZEN);

  step("LIFELINE: attacker paths");
  console.log("    to own org evilcorp:", await reverts(3, nv, ABI.vault, "proposeLifeline", [ev, u(100)]));
  const atkId = await (async () => {
    await send(3, nv, ABI.vault, "proposeLifeline", [pl, u(100)]);
    return (await read(nv, ABI.vault, "nextLifelineId")) as bigint;
  })();
  await send(2, nv, ABI.vault, "approveLifeline", [atkId]); // second stolen wallet: a majority, but no key
  check("majority without Recovery key draws nothing", ((await read(nv, ABI.vault, "getLifeline", [atkId])) as { state: number }).state === 1);
  console.log("    outsider calls hook directly:", await reverts(12, dep.orbitalHook, ABI.hook, "lifelineDraw", [pl, u(100), 0n]));

  step("LIFELINE: honest wallets + Recovery key keep paying palantir during the freeze");
  const palBefore = (await read(pt, ABI.token, "balanceOf", [PL[0]])) as bigint;
  const nvUsdcBefore = (await read(USDC, ABI.erc20, "balanceOf", [nv])) as bigint;
  await send(1, nv, ABI.vault, "proposeLifeline", [pl, u(800)]);
  const llId = (await read(nv, ABI.vault, "nextLifelineId")) as bigint;
  await send(2, nv, ABI.vault, "approveLifeline", [llId]);
  const drawTx = await send(RECOVERY_KEY, nv, ABI.vault, "approveLifeline", [llId]);
  console.log("    Sentinel on the Lifeline outflow:", (await sentinel(drawTx)).join(" | "));
  check("palantir paid 800 during the freeze", ((await read(pt, ABI.token, "balanceOf", [PL[0]])) as bigint) - palBefore === u(800));
  check("frozen USDC did not move", ((await read(USDC, ABI.erc20, "balanceOf", [nv])) as bigint) === nvUsdcBefore);
  check("nvidia still frozen after the Lifeline", Number(await read(dep.hub, ABI.hub, "statusOf", [nv])) === P.STATUS_FROZEN);
  check("debt recorded (800 + 0.5%)", ((await read(nv, ABI.vault, "lifelineDebt")) as bigint) === u(804));
  console.log("   ", reconciler());
  check("Reconciler did not RESERVE_FLAG the escrow", Number(await read(dep.hub, ABI.hub, "statusOf", [nv])) === P.STATUS_FROZEN);

  step("RECOVERY: Recovery key unfreezes; settle repays the pool");
  await send(RECOVERY_KEY, nv, ABI.vault, "recoveryUnfreeze");
  check("nvidia active again", Number(await read(dep.hub, ABI.hub, "statusOf", [nv])) === P.STATUS_ACTIVE);
  const plUsdc = (await read(USDC, ABI.erc20, "balanceOf", [pl])) as bigint;
  await send(0, dep.orbitalHook, ABI.hook, "settle");
  check("Lifeline repaid", ((await read(dep.orbitalHook, ABI.hook, "debtCount")) as bigint) === 0n);
  check("palantir Vault got 804 USDC", ((await read(USDC, ABI.erc20, "balanceOf", [pl])) as bigint) - plUsdc === u(804));
  check("palantir pool float restored", ((await read(dep.orbitalHook, ABI.hook, "owedTo", [pt])) as bigint) === 0n);
  for (const [n, v] of [["nvidia", nv], ["palantir", pl], ["evilcorp", ev]] as const) {
    const [held, supply] = (await read(v, ABI.vault, "reserves")) as [bigint, bigint];
    const debt = (await read(v, ABI.vault, "lifelineDebt")) as bigint;
    check(`${n} fully backed`, held >= supply + debt, `held=${held} supply=${supply} debt=${debt}`);
  }

  step("Back to normal a day later (forensics take time): CRE live, nvidia pays palantir again");
  await warp(24 * 3600);
  console.log("   ", reconciler());
  {
    const h = await send(1, nv, ABI.vault, "requestPayment", [pl, u(120)]);
    console.log("   ", (await sentinel(h)).join(" | "));
    const id = (await read(nv, ABI.vault, "nextRequestId")) as bigint;
    await warpTo(nv, id);
    await send(1, nv, ABI.vault, "execute", [id]);
    check("post-recovery payment executed", ((await read(nv, ABI.vault, "getRequest", [id])) as { state: number }).state === P.REQ_EXECUTED);
  }

  console.log(`\nreports written onchain: ${reportsWritten}, rejected by Hub: ${reportsRejected}, notifications: ${notifications.length} [${notifications.map((n) => n.kind).join(",")}]`);
  console.log(`${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    throw new Error(failures.join("; "));
  }
}

describe("local e2e (Anvil fork)", () => {
  if (!ENABLED) return;
  creTest("hack → FLAG → Lifeline → recovery → repayment", async () => {
    await main();
  });
});
