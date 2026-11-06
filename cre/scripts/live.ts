#!/usr/bin/env bun
/**
 * CRE live monitor: a terminal view of every Chainlink CRE execution the web app causes, for the demo.
 *
 *   cd cre && bun run live                 # watch + simulate (dry run: reports are not sent)
 *   cd cre && bun run live --broadcast     # also write each report onchain through the simulation forwarder
 *   cd cre && bun run live --watch-only    # no simulations, just the web → Hub → CRE trace
 *   cd cre && bun run live --cron 60       # also fire the Reconciler's cron trigger every 60s
 *
 * Three sources, one timeline:
 *   1. Web bridge (http://127.0.0.1:8788): the app posts each button press and its tx (web/src/lib/tx.tsx).
 *   2. Hub logs on Arc: the same filter the Sentinel's EVMClient.logTrigger subscribes to
 *      (RequestQueued | ConfigChange | Outflow), plus the Hub.onReport side effects (ReportAccepted, Flagged…).
 *   3. The official CRE CLI: every trigger log is replayed with `cre workflow simulate sentinel
 *      --evm-tx-hash … --evm-event-index …`, the exact command the DON-equivalent simulator runs, and its
 *      output (the workflow's own runtime.log lines) is rendered as capability calls.
 *
 * Keys: r = run the Reconciler (CronCapability trigger)  b = toggle --broadcast  c = clear  q = quit
 * Needs: ARC_RPC_URL (else the public Arc RPC), `cre` on PATH (or CRE_BIN) and cre/.env for simulations.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createPublicClient, decodeEventLog, http, parseAbi, type Address, type Hex, type Log } from "viem";

// ---------- config ----------
const CRE_DIR = join(import.meta.dirname, "..");
const REPO = join(CRE_DIR, "..");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const deployment = readJson(join(REPO, "deployments/arc.json"));
const arcCfg = readJson(join(REPO, "config/arc.json"));
const reconcilerCfg = readJson(join(CRE_DIR, "reconciler/config.staging.json"));

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const HUB = deployment.hub as Address;
const RPC = process.env.ARC_RPC_URL || arcCfg.rpc;
const EXPLORER = arcCfg.explorer as string;
const PORT = Number(process.env.CRE_LIVE_PORT ?? 8788);
const WATCH_ONLY = flag("--watch-only");
const CRON_EVERY = Number(opt("--cron") ?? 0);
const POLL_MS = Number(opt("--poll") ?? 2000);
let broadcast = flag("--broadcast");

const CRE_BIN = process.env.CRE_BIN || "cre";
const creFound = spawnSync("sh", ["-c", `command -v ${CRE_BIN}`]).status === 0;
const creVersion = creFound ? spawnSync(CRE_BIN, ["version"], { encoding: "utf8" }).stdout?.trim().split("\n")[0] : "";

// ---------- terminal styling ----------
const tty = process.stdout.isTTY;
const sgr = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  dim: sgr("2"),
  bold: sgr("1"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
  onRed: sgr("1;97;41"),
  onYellow: sgr("1;30;43"),
  onGreen: sgr("1;30;42"),
  onBlue: sgr("1;97;44"),
  onMagenta: sgr("1;97;45"),
  onCyan: sgr("1;30;46"),
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const time = () => c.gray(new Date().toTimeString().slice(0, 8));
// While a simulation streams, everything else waits so its block stays contiguous.
let holding = false;
const held: string[] = [];
const out = (s = "") => (holding ? held.push(s) : console.log(s));
const at = (s: string) => out(`${time()} ${s}`);
const now = (s = "") => console.log(s);
const gutter = (s: string, color = c.gray) => now(`         ${color("│")} ${s}`);
const tag = (label: string, paint: (s: string) => string) => paint(` ${label.padEnd(8)} `);

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
const usd = (v: bigint) => `$${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const dur = (s: number) =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
const txLink = (h: string) => c.gray(`${EXPLORER}/tx/${h}`);

// ---------- palmfi vocabulary (mirrors cre/shared/palm.ts and Hub.sol) ----------
const REASONS = [
  "UNUSUAL_AMOUNT", "NEW_DESTINATION", "OFF_HOURS", "VELOCITY", "CONFIG_CHANGE_PENDING", "NEW_WALLET",
  "BLOCKLISTED_DEST", "DELEGATION_CHANGED", "RESERVE_MISMATCH", "OVER_HARD_CAP", "CRE_SILENT",
];
const reasonNames = (codes: bigint) => REASONS.filter((_, i) => (codes >> BigInt(i)) & 1n);
const REPORT_TYPES = ["SET_DELAY", "FLAG", "HEARTBEAT", "DELEGATION_FLAG", "RESERVE_FLAG"];
const REJECTS = ["", "DECODE", "WORKFLOW", "DUPLICATE", "EXPIRED", "UNKNOWN_VAULT", "UNKNOWN_REQUEST", "HASH_MISMATCH", "TERMINAL", "FAST_TRACKED", "BAD_TYPE"];
const REQ_STATES = ["NONE", "PENDING", "EXECUTED", "VETOED", "EXPIRED", "FLAGGED", "CANCELLED"];
const VAULT_STATUS = ["NONE", "ACTIVE", "FROZEN", "MIGRATED", "REVOKED"];

const hubEvents = parseAbi([
  "event VaultRegistered(address indexed vault, string name, address token)",
  "event NameVerified(address indexed vault, string name, bool verified)",
  "event RequestQueued(address indexed vault, uint256 indexed requestId, bytes32 requestHash, uint8 kind, address wallet, uint256 amount, address destination, uint256 reasonCodes)",
  "event RequestUpdated(address indexed vault, uint256 indexed requestId, uint8 state, uint64 executableAt, uint32 score, uint256 reasonCodes)",
  "event Voted(address indexed vault, uint256 indexed requestId, address voter, bool yes, uint16 yesVotes, uint16 noVotes)",
  "event ConfigChange(address indexed vault, uint256 indexed changeId, uint8 kind, bytes data, uint16 yesVotes, uint64 eta)",
  "event Outflow(address indexed vault, address wallet, address destination, uint256 amount, bool viaPool)",
  "event Flagged(address indexed vault, uint256 indexed requestId, uint256 reasonCodes, address destination)",
  "event Frozen(address indexed vault, address by, uint256 reasonCodes)",
  "event Unfrozen(address indexed vault)",
  "event Migrated(address indexed vault, address recoveryVault)",
  "event StatusChanged(address indexed vault, uint8 status)",
  "event Blocked(address indexed account, address indexed sourceVault, uint64 until)",
  "event Heartbeat(uint256 timestamp, uint256 nonce)",
  "event ReportAccepted(bytes32 indexed reportId, uint8 reportType, address indexed vault, uint256 requestId)",
  "event ReportRejected(bytes32 indexed reportId, uint8 reason)",
]);
const hubReads = parseAbi(["function nameOf(address) view returns (string)"]);

/** The Sentinel's logTrigger topic filter (cre/sentinel/main.ts SCORED_EVENTS). */
const SENTINEL_TRIGGERS = new Set(["RequestQueued", "ConfigChange", "Outflow"]);
/** Only Hub.onReport emits these: the tx is a CRE report landing through the forwarder. */
const CRE_WRITE_MARKERS = new Set(["ReportAccepted", "ReportRejected", "Heartbeat"]);

const client = createPublicClient({ transport: http(RPC, { retryCount: 3 }) });

const names = new Map<string, string>();
async function vaultName(v: Address) {
  const k = v.toLowerCase();
  if (!names.has(k)) {
    try {
      names.set(k, (await client.readContract({ address: HUB, abi: hubReads, functionName: "nameOf", args: [v] })) || short(v));
    } catch {
      names.set(k, short(v));
    }
  }
  return c.bold(names.get(k)!);
}

// ---------- UI bridge ----------
type UiEvent = { phase: "pending" | "mining" | "done" | "error"; label: string; functionName?: string; hash?: Hex; message?: string; account?: string };
const uiByTx = new Map<string, string>();
const seenTx = new Set<string>();

function onUi(e: UiEvent) {
  const what = `${c.bold(e.label)}${e.functionName ? c.gray(` · ${e.functionName}()`) : ""}`;
  switch (e.phase) {
    case "pending":
      out();
      at(`${tag("UI", c.onCyan)} ${what}  ${c.cyan("button pressed → wallet signature")}${e.account ? c.gray(`  from ${short(e.account)}`) : ""}`);
      break;
    case "mining":
      if (e.hash) uiByTx.set(e.hash.toLowerCase(), e.label);
      at(`${c.cyan("   ↳")} signed  ${c.gray(short(e.hash))}  ${c.dim("waiting for Arc…")}`);
      break;
    case "done":
      at(`${c.cyan("   ↳")} ${c.green("confirmed")}  ${c.gray(short(e.hash))}`);
      if (e.hash) {
        const h = e.hash.toLowerCase();
        setTimeout(() => {
          if (!seenTx.has(h)) at(`${c.cyan("   ↳")} ${c.dim("no Hub event in this tx → nothing for CRE to see (token/ERC-20 only)")}`);
        }, POLL_MS * 4);
      }
      break;
    case "error":
      at(`${c.cyan("   ↳")} ${c.red(`failed: ${e.message ?? "error"}`)}`);
      break;
  }
}

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-private-network", "true");
  if (req.method === "OPTIONS") return res.end();
  if (req.method === "GET") return res.end(JSON.stringify({ ok: true, hub: HUB, broadcast }));
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    try {
      onUi(JSON.parse(body));
    } catch {
      /* ignore malformed */
    }
    res.end("ok");
  });
})
  .on("error", (e) => at(c.red(`web bridge not started: ${e.message}`)))
  .listen(PORT, "127.0.0.1");

// ---------- CRE CLI runner ----------
type Job =
  | { kind: "sentinel"; txHash: Hex; eventIndex: number; event: string; vault?: Address }
  | { kind: "reconciler"; reason: string };
const jobs: Job[] = [];
let running = false;

function enqueue(j: Job) {
  jobs.push(j);
  if (!running) void drain();
}

async function drain() {
  running = true;
  while (jobs.length) await runJob(jobs.shift()!);
  running = false;
}

function cliArgs(j: Job) {
  const a = ["workflow", "simulate", j.kind, "--target", "staging-settings", "--non-interactive", "--trigger-index", "0", "--limits", "default"];
  if (j.kind === "sentinel") a.push("--evm-tx-hash", j.txHash, "--evm-event-index", String(j.eventIndex));
  if (broadcast) a.push("--broadcast");
  return a;
}

async function runJob(j: Job) {
  holding = true;
  try {
    await runJobInner(j);
  } finally {
    holding = false;
    for (const l of held.splice(0)) console.log(l);
  }
}

async function runJobInner(j: Job) {
  now();
  if (j.kind === "sentinel") {
    now(`${time()} ${tag("CRE", c.onYellow)} ${c.yellow(c.bold("Sentinel"))} ${c.gray("·")} ${c.yellow("EVMClient.logTrigger")} fired on ${c.bold(j.event)}  ${c.gray(`(confidence LATEST · log #${j.eventIndex})`)}`);
    gutter(c.gray(`handler onHubLog(runtime, log)  ${j.vault ? `vault ${await vaultName(j.vault)}` : ""}`), c.yellow);
  } else {
    now(`${time()} ${tag("CRE", c.onBlue)} ${c.blue(c.bold("Reconciler"))} ${c.gray("·")} ${c.blue("CronCapability.trigger")}  ${c.gray(`schedule "${reconcilerCfg.schedule}" · ${j.reason}`)}`);
    gutter(c.gray("handler onCron(runtime, payload): health → unscored requests → heartbeat"), c.blue);
  }
  const bar = j.kind === "sentinel" ? c.yellow : c.blue;
  const cmd = `cre ${cliArgs(j).join(" ")}`;
  gutter(c.dim(`$ ${cmd}`), bar);
  if (WATCH_ONLY) return gutter(c.dim("--watch-only: simulation skipped"), bar);
  if (!creFound) return gutter(c.red(`cre CLI not found (set CRE_BIN or install it); run the command above by hand`), bar);

  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const p = spawn(CRE_BIN, cliArgs(j), { cwd: CRE_DIR, env: process.env });
    const r = new CliRenderer(bar);
    let buf = "";
    const feed = (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) r.line(l);
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("close", (code) => {
      if (buf) r.line(buf);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) now(`         ${bar("└")} ${c.green("✓ simulation complete")} ${c.gray(`${secs}s${broadcast ? " · broadcast" : " · dry run (b to broadcast)"}`)}`);
      else now(`         ${bar("└")} ${c.red(`✗ cre exited ${code}`)} ${c.gray(`${secs}s`)}`);
      resolve();
    });
    p.on("error", (e) => {
      now(`         ${bar("└")} ${c.red(e.message)}`);
      resolve();
    });
  });
}

const NOISE = [/^[╭│╰]/, /^Initializing/, /^Loading settings/, /^Checking RPC/, /^Compiling workflow/, /^HTTP: req=/, /Binary hash/, /Config hash/, /Skipping WorkflowEngineV2/, /Execution finished signal/, /Simulator Initialized/, /Simulation limits enabled/, /^\$ /, /Fetching transaction receipt/];

/** Turns `cre workflow simulate` output into capability-level steps. */
class CliRenderer {
  private expectResult = false;
  private bar: (s: string) => string;
  constructor(bar: (s: string) => string) {
    this.bar = bar;
  }
  private g(s: string) {
    gutter(s, this.bar);
  }

  line(raw: string) {
    const l = stripAnsi(raw).trim();
    if (!l || NOISE.some((r) => r.test(l))) return;
    if (this.expectResult) {
      this.expectResult = false;
      let v = l;
      try {
        v = JSON.parse(l);
      } catch {
        /* keep raw */
      }
      return this.g(`${c.green("◆ workflow result")}  ${c.bold(typeof v === "string" ? v : JSON.stringify(v))}`);
    }
    if (/Workflow compiled/.test(l)) return this.g(c.dim("✓ main.ts → wasm compiled · Runner.newRunner().run(initWorkflow)"));
    let m = l.match(/Running trigger trigger=(\S+)/);
    if (m) return this.g(`${c.bold("⚡ trigger")} ${c.gray(m[1])}`);
    if (/Workflow Simulation Result/.test(l)) {
      this.expectResult = true;
      return;
    }
    m = l.match(/\[USER LOG\]\s*(.*)$/);
    if (m) return this.userLog(m[1]);
    if (/error|fail|✗/i.test(l)) return this.g(c.red(l));
    this.g(c.dim(l.replace(/^\S+Z\s+/, "")));
  }

  /** The workflow's own runtime.log lines (cre/shared/scoring.ts, health.ts, notify.ts, reconciler). */
  private userLog(s: string) {
    let m = s.match(/^(FLAG|DELAY) (\S+) score=(\d+)mb delay=(\d+)s scope=(\S+) terms=(\{.*?\}) codes=\[(.*?)\] tx=(\S+) receiverReverted=(\S+)(.*)$/);
    if (m) {
      const [, action, ref, mb, delay, scope, terms, codes, tx, reverted, rest] = m;
      const [vault, id] = ref.split(":");
      const bits = (Number(mb) / 1000).toFixed(1);
      this.g(`${c.blue("EVMClient.callContract")} ${c.gray("Multicall3.aggregate3 → Vault.scoringContext · history · profile")}`);
      const t = JSON.parse(terms) as Record<string, number>;
      this.g(c.gray(`deviation model (${scope}): ${Object.entries(t).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(" · ")} bits`));
      const verdict = action === "FLAG" ? c.onRed(" FLAG ") : Number(delay) <= 600 ? c.onGreen(" DELAY ") : c.onYellow(" DELAY ");
      this.g(`${verdict} ${c.bold(`${short(vault)}#${id}`)}  score ${c.bold(`${bits} bits`)}  ${action === "FLAG" ? c.red("→ freeze vault + blocklist destination") : `→ wait ${c.bold(dur(Number(delay)))}`}`);
      if (codes) this.g(`  ${codes.split(",").map((x) => c.magenta(x)).join(c.gray(" · "))}`);
      this.write(tx, reverted, rest, action === "FLAG" ? "FLAG" : "SET_DELAY");
      return;
    }
    m = s.match(/^(RESERVE_FLAG|DELEGATION_FLAG) (\S+) tx=(\S+) receiverReverted=(\S+)/);
    if (m) {
      this.g(`${c.onRed(` ${m[1]} `)} vault ${c.bold(short(m[2]))}  ${c.red("health check failed")}`);
      return this.write(m[3], m[4], "", m[1]);
    }
    m = s.match(/^notify (\S+) (\S+)(.*)$/);
    if (m) return this.g(`${c.magenta("ConfidentialHTTPClient.sendRequest")} notify ${m[1]} ${short(m[2])} ${c.red(m[3].replace(/^:\s*/, ""))}`);
    m = s.match(/^callContract (\S+) failed: (.*)$/);
    if (m) return this.g(`${c.blue("EVMClient.callContract")} ${short(m[1])} ${c.red(`failed → HOLD (API_UNAVAILABLE)`)}`);
    if (s.startsWith("{")) {
      try {
        const r = JSON.parse(s) as { vaults?: number; health?: string[]; requests?: string[]; heartbeat?: string; evmCalls?: number };
        this.g(`${c.blue("EVMClient.callContract")} ${c.gray(`Hub.getVaults · Hub.openRequests · health reads  (${r.evmCalls ?? "?"} EVM calls)`)}`);
        this.g(`vaults scanned ${c.bold(r.vaults ?? 0)} · health findings ${c.bold(r.health?.length ?? 0)}`);
        for (const h of r.health ?? []) this.g(`  ${c.red("●")} ${h}`);
        for (const q of r.requests ?? []) this.g(`  ${/FLAG/.test(q) ? c.red("●") : /SKIP/.test(q) ? c.gray("○") : c.yellow("●")} ${q}`);
        const ok = r.heartbeat === "WRITTEN";
        this.g(`${c.green("runtime.report")} → ${c.green("EVMClient.writeReport")} HEARTBEAT ${ok ? c.green("WRITTEN") : c.red(r.heartbeat ?? "?")}`);
        return;
      } catch {
        /* fall through */
      }
    }
    this.g(s);
  }

  private write(tx: string, reverted: string, rest: string, type: string) {
    const ok = tx === "SUCCESS" && reverted === "false";
    this.g(
      `${c.green("runtime.report")}${c.gray("(evm · ecdsa · keccak256)")} → ${c.green("EVMClient.writeReport")} ${c.gray(`→ forwarder → Hub.onReport(${type})`)}  ` +
        (ok ? c.green(`tx ${tx}`) : c.red(`tx ${tx}${reverted === "true" ? " receiverReverted" : ""}${rest}`)),
    );
  }
}

// ---------- Hub watcher ----------
type HubLog = Log & { eventName: string; args: Record<string, unknown> };

async function describe(l: HubLog): Promise<string> {
  const a = l.args as Record<string, any>;
  const v = a.vault ? await vaultName(a.vault) : "";
  switch (l.eventName) {
    case "RequestQueued":
      return `${v}#${a.requestId} ${c.bold(usd(a.amount))} → ${short(a.destination)}  ${c.gray(`by ${short(a.wallet)} · over budget, queued at MaxDelay`)}`;
    case "ConfigChange":
      return `${v} change #${a.changeId} kind ${a.kind}  ${c.gray(`${a.yesVotes} yes${a.eta ? ` · eta ${new Date(Number(a.eta) * 1000).toTimeString().slice(0, 5)}` : " · proposed"}`)}`;
    case "Outflow":
      return `${v} ${c.bold(usd(a.amount))} → ${short(a.destination)}  ${c.gray(a.viaPool ? "via Orbital pool" : "direct")}`;
    case "Voted":
      return `${v}#${a.requestId} ${a.yes ? c.green("YES") : c.red("NO")} by ${short(a.voter)}  ${c.gray(`${a.yesVotes} yes / ${a.noVotes} no`)}`;
    case "RequestUpdated":
      return `${v}#${a.requestId} ${c.bold(REQ_STATES[a.state] ?? a.state)}  ${c.gray(`score ${(Number(a.score) / 1000).toFixed(1)} bits${a.executableAt ? ` · executable ${new Date(Number(a.executableAt) * 1000).toTimeString().slice(0, 8)}` : ""}`)}`;
    case "ReportAccepted":
      return `${c.green(REPORT_TYPES[a.reportType] ?? a.reportType)} ${v}${a.requestId ? `#${a.requestId}` : ""}  ${c.gray(`report ${short(a.reportId)}`)}`;
    case "ReportRejected":
      return `${c.red(REJECTS[a.reason] ?? a.reason)}  ${c.gray(`report ${short(a.reportId)} · Hub ignored it (ADR-0005)`)}`;
    case "Flagged":
      return `${v}#${a.requestId} ${c.red(reasonNames(a.reasonCodes).join(", "))} → ${short(a.destination)}`;
    case "Frozen":
      return `${v} ${c.red("outflows closed")} ${c.gray(reasonNames(a.reasonCodes).join(", "))}`;
    case "Blocked":
      return `${short(a.account)} ${c.red("blocklisted network-wide")} ${c.gray(`until ${new Date(Number(a.until) * 1000).toLocaleString()}`)}`;
    case "Heartbeat":
      return c.gray(`CRE alive · nonce ${short(`0x${(a.nonce as bigint).toString(16)}`)}`);
    case "StatusChanged":
      return `${v} → ${c.bold(VAULT_STATUS[a.status] ?? a.status)}`;
    case "VaultRegistered":
      names.set((a.vault as string).toLowerCase(), a.name);
      return `${c.bold(a.name)} ${short(a.vault)} token ${short(a.token)}`;
    default:
      return c.gray(Object.entries(a).map(([k, x]) => `${k}=${typeof x === "string" && x.startsWith("0x") ? short(x) : String(x)}`).join(" "));
  }
}

async function onTx(hash: Hex, logs: HubLog[]) {
  seenTx.add(hash.toLowerCase());
  const fromCre = logs.some((l) => CRE_WRITE_MARKERS.has(l.eventName));
  const triggers = logs.filter((l) => SENTINEL_TRIGGERS.has(l.eventName));
  const ui = uiByTx.get(hash.toLowerCase());

  out();
  if (fromCre) at(`${tag("REPORT", c.onMagenta)} ${c.magenta("KeystoneForwarder → Hub.onReport")}  ${c.gray(short(hash))}`);
  else at(`${tag("ARC", c.onBlue)} ${c.blue("Hub tx")} ${c.gray(short(hash))}${ui ? `  ${c.cyan(`← from UI "${ui}"`)}` : ""}`);
  for (const l of logs) {
    const isTrigger = SENTINEL_TRIGGERS.has(l.eventName);
    const glyph = fromCre ? c.magenta("◀") : isTrigger ? c.yellow("⚡") : c.gray("·");
    out(`         ${glyph} ${(isTrigger ? c.yellow : fromCre ? c.magenta : c.blue)(c.bold(l.eventName.padEnd(15)))} ${await describe(l)}`);
  }
  if (!fromCre && !triggers.length) out(`         ${c.gray("  not in the Sentinel's logTrigger filter → no CRE execution")}`);
  out(`         ${txLink(hash)}`);

  if (!triggers.length) return;
  // --evm-event-index is the log's position in the receipt, not its block-wide logIndex.
  const receipt = await client.getTransactionReceipt({ hash });
  for (const l of triggers) {
    const idx = receipt.logs.findIndex((r) => r.logIndex === l.logIndex);
    if (l.eventName === "Outflow" && !(l.args as { viaPool?: boolean }).viaPool)
      out(`         ${c.gray("  Outflow(direct): Sentinel runs but skips the health check")}`);
    enqueue({ kind: "sentinel", txHash: hash, eventIndex: idx, event: l.eventName, vault: (l.args as { vault?: Address }).vault });
  }
}

let rateLimited = false;
async function watch() {
  const fromOpt = opt("--from-block");
  let last = fromOpt && /^\d+$/.test(fromOpt) ? BigInt(fromOpt) - 1n : await client.getBlockNumber();
  for (;;) {
    try {
      const head = await client.getBlockNumber();
      if (head > last) {
        const to = head - last > 1000n ? last + 1000n : head;
        const raw = await client.getLogs({ address: HUB, fromBlock: last + 1n, toBlock: to });
        const byTx = new Map<Hex, HubLog[]>();
        for (const r of raw) {
          try {
            const d = decodeEventLog({ abi: hubEvents, data: r.data, topics: r.topics });
            const arr = byTx.get(r.transactionHash!) ?? [];
            arr.push({ ...r, eventName: d.eventName, args: d.args as Record<string, unknown> });
            byTx.set(r.transactionHash!, arr);
          } catch {
            /* an event this view doesn't know (WorkflowPinned…) */
          }
        }
        for (const [h, ls] of byTx) await onTx(h, ls);
        last = to;
      }
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (/limit|429/i.test(msg)) {
        if (!rateLimited) at(c.gray("RPC rate-limited, backing off (set ARC_RPC_URL to a private endpoint)"));
        rateLimited = true;
        await new Promise((r) => setTimeout(r, POLL_MS * 2));
      } else at(c.red(`RPC: ${msg}`));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// ---------- start ----------
function banner() {
  out();
  out(`  ${c.bold("palmfi")} ${c.gray("×")} ${c.blue(c.bold("Chainlink CRE"))}  ${c.gray("live workflow monitor")}`);
  out(c.gray("  ─────────────────────────────────────────────────────────────────────"));
  out(`  ${c.yellow("sentinel  ")} EVMClient.logTrigger ${c.gray(`Hub ${short(HUB)} · RequestQueued | ConfigChange | Outflow`)}`);
  out(`  ${c.blue("reconciler")} CronCapability.trigger ${c.gray(`"${reconcilerCfg.schedule}"${CRON_EVERY ? ` · auto every ${CRON_EVERY}s` : " · press r"}`)}`);
  out(`  ${c.magenta("consumer  ")} Hub.onReport ${c.gray(`via forwarder ${short(arcCfg.cre.simForwarder)} (simulation)`)}`);
  out(`  ${c.cyan("web bridge")} http://127.0.0.1:${PORT} ${c.gray("· every button press in the app shows here")}`);
  out(
    `  ${c.gray("cre cli   ")} ${creFound ? c.green(`✓ ${creVersion || CRE_BIN}`) : c.red("✗ not found")}${WATCH_ONLY ? c.gray(" · watch-only") : ""}  ${c.gray("broadcast")} ${broadcast ? c.green("on") : c.yellow("off")}`,
  );
  out(c.gray("  ─────────────────────────────────────────────────────────────────────"));
  out(c.gray("  keys: r reconciler · b broadcast on/off · c clear · q quit"));
}

banner();
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (d) => {
    const k = d.toString();
    if (k === "q" || k === "\u0003") process.exit(0);
    if (k === "r") enqueue({ kind: "reconciler", reason: "manual" });
    if (k === "b") {
      broadcast = !broadcast;
      at(`broadcast ${broadcast ? c.green("on: reports are written onchain") : c.yellow("off: dry run")}`);
    }
    if (k === "c") {
      console.clear();
      banner();
    }
  });
}
if (CRON_EVERY > 0) setInterval(() => enqueue({ kind: "reconciler", reason: `every ${CRON_EVERY}s` }), CRON_EVERY * 1000);
void watch();
