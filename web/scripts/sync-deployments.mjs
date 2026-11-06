#!/usr/bin/env node
// Copies deployments/arc.json (written by contracts/script/Deploy.s.sol) into web/src/generated so the app
// can import it, with the Sentinel's staging scoring params so the UI explains delays with the same thresholds. When the network isn't deployed yet it writes `{}` and the app shows a "not deployed" state.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../../deployments/arc.json");
const destDir = join(here, "../src/generated");
const dest = join(destDir, "deployments.json");
const sentinel = join(here, "../../cre/sentinel/config.staging.json");
mkdirSync(destDir, { recursive: true });
if (existsSync(src)) {
  const out = JSON.parse(readFileSync(src, "utf8"));
  if (existsSync(sentinel)) out.scoring = JSON.parse(readFileSync(sentinel, "utf8")).scoring;
  writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
  console.log("deployments: synced deployments/arc.json");
} else if (!existsSync(dest)) {
  writeFileSync(dest, "{}\n");
  console.log("deployments: none yet (wrote {})");
} else {
  console.log("deployments: deployments/arc.json missing; keeping src/generated/deployments.json");
}
