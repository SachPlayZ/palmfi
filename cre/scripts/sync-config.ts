#!/usr/bin/env bun
/**
 * Copies deployed addresses into the workflow configs:
 *   deployments/sepolia.json  → hub
 *   POOL_ID env (optional)    → reconciler WETH/USDC v4 pool id (once the pool is seeded)
 *   NOTIFY_URL env (optional) → notify.url
 *
 *   bun scripts/sync-config.ts
 */
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dep = Bun.file(join(root, "../deployments/sepolia.json"));
if (!(await dep.exists())) {
  console.error("deployments/sepolia.json not found: run the Foundry deploy first.");
  process.exit(1);
}
const { hub } = (await dep.json()) as { hub: string };

for (const wf of ["sentinel", "reconciler"]) {
  for (const target of ["staging", "production"]) {
    const path = join(root, wf, `config.${target}.json`);
    const cfg = await Bun.file(path).json();
    cfg.hub = hub;
    if (process.env.NOTIFY_URL) cfg.notify.url = process.env.NOTIFY_URL;
    if (wf === "reconciler" && process.env.POOL_ID) {
      for (const a of cfg.assets) if (a.pool) a.pool.poolId = process.env.POOL_ID;
    }
    await Bun.write(path, `${JSON.stringify(cfg, null, 2)}\n`);
    console.log(`${wf}/config.${target}.json: hub=${hub}`);
  }
}
