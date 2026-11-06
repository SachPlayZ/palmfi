#!/usr/bin/env bun
/**
 * CRE simulation suite (issue #22): runs every enabled fixture in cre/fixtures through
 * `cre workflow simulate --limits default` and checks the workflow's printed result against `expect`.
 *
 *   bun scripts/simulate.ts                # enabled fixtures only
 *   bun scripts/simulate.ts --all          # every fixture that can run (log fixtures need evmTxHash)
 *   bun scripts/simulate.ts --broadcast    # send real Sepolia txs through the MockKeystoneForwarder
 *   bun scripts/simulate.ts 01-missed-log  # named fixtures
 *
 * Logs go to cre/fixtures/logs/<fixture>.log. Requires the `cre` CLI on PATH and SEPOLIA_RPC_URL; without
 * the CLI it prints what it would run and exits 0, so CI stays green before CRE access exists.
 */
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Fixture = {
  row: string;
  workflow: "sentinel" | "reconciler";
  trigger: "log" | "cron";
  triggerIndex: number;
  setup: string;
  expect: string;
  enabled: boolean;
  cliPossible?: boolean;
  evmTxHash?: string;
  evmEventIndex?: number;
};

const root = join(import.meta.dir, "..");
const dir = join(root, "fixtures");
const args = process.argv.slice(2);
const all = args.includes("--all");
const broadcast = args.includes("--broadcast");
const named = args.filter((a) => !a.startsWith("--"));

const hasCli = Bun.spawnSync(["sh", "-c", "command -v cre"]).exitCode === 0;
if (!hasCli) console.log("cre CLI not found on PATH: printing the commands only (install: docs.chain.link/cre).");

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
mkdirSync(join(dir, "logs"), { recursive: true });

let failed = 0;
let ran = 0;
for (const file of files) {
  const name = file.replace(/\.json$/, "");
  if (named.length && !named.includes(name)) continue;
  const f = (await Bun.file(join(dir, file)).json()) as Fixture;
  const skip =
    f.cliPossible === false
      ? "not reproducible by the CLI (unit-tested)"
      : f.trigger === "log" && !f.evmTxHash
        ? "no recorded evmTxHash yet"
        : !f.enabled && !all && !named.length
          ? "disabled (needs the setup described in the fixture)"
          : undefined;
  if (skip) {
    console.log(`- ${name}: skipped, ${skip}`);
    continue;
  }
  const cmd = [
    "cre",
    "workflow",
    "simulate",
    f.workflow,
    "--target",
    "staging-settings",
    "--non-interactive",
    "--trigger-index",
    String(f.triggerIndex),
    "--limits",
    "default",
  ];
  if (f.trigger === "log") cmd.push("--evm-tx-hash", f.evmTxHash!, "--evm-event-index", String(f.evmEventIndex ?? 0));
  if (broadcast) cmd.push("--broadcast");
  if (!hasCli) {
    console.log(`- ${name}: ${cmd.join(" ")}`);
    continue;
  }
  ran++;
  const p = Bun.spawnSync(cmd, { cwd: root, env: process.env });
  const out = `${p.stdout.toString()}\n${p.stderr.toString()}`;
  writeFileSync(join(dir, "logs", `${name}.log`), `$ ${cmd.join(" ")}\n\n${out}`);
  const ok = p.exitCode === 0 && (!f.expect || out.includes(f.expect));
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name} (${f.row})${ok ? "" : `: expected "${f.expect}", exit ${p.exitCode}`}`);
}
if (hasCli) console.log(`\n${ran - failed}/${ran} fixtures passed`);
process.exit(failed ? 1 : 0);
