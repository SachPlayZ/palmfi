#!/usr/bin/env bun
/**
 * Creates a real queued request on Arc testnet for the Sentinel to score, from the CRE simulation wallet
 * (CRE_ETH_PRIVATE_KEY in cre/.env): onboards a 3-wallet test Vault once (the sim wallet + two cold voters),
 * deposits USDC, then queues an unwrap. Prints the tx hash + Hub log index to pass to
 *   cre workflow simulate sentinel --evm-tx-hash <hash> --evm-event-index <i>
 *
 *   bun shared/scripts/live-request.ts [known|new|huge]
 *     known: $3 to an onboarding destination (→ short delay)   new: $3 to a fresh address (→ longer delay)
 *     huge:  $9 at the Hard cap's edge to a fresh address (→ capDelay, or FLAG once the baseline exists)
 */
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeEventTopics, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hubEventsAbi } from "../abi";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});
const USDC = "0x3600000000000000000000000000000000000000" as Hex; // ERC-20 view of native USDC, 6 dp

const root = join(import.meta.dir, "../..");
const dep = await Bun.file(join(root, "../deployments/arc.json")).json();
const key = process.env.CRE_ETH_PRIVATE_KEY;
if (!key) throw new Error("CRE_ETH_PRIVATE_KEY missing (cre/.env)");
const account = privateKeyToAccount(`0x${key.replace(/^0x/, "")}`);
const rpc = http(process.env.ARC_RPC_URL);
const pub = createPublicClient({ chain: arc, transport: rpc });
const wallet = createWalletClient({ chain: arc, transport: rpc, account });

const NAME = "cre-sim";
const KNOWN = "0x000000000000000000000000000000000000dead" as Hex; // onboarding destination
const NEW = `0x${Date.now().toString(16).padStart(40, "0")}` as Hex;
const mode = process.argv[2] ?? "known";
const dest = mode === "known" ? KNOWN : NEW;
const amount = mode === "huge" ? 9_000000n : 3_000000n;

const factoryAbi = parseAbi([
  "struct VaultConfig { address[] wallets; address recoveryKey; address recoveryVault; uint128 budget24h; uint128 budget7d; uint128 hardCap; uint32 floorDelay; uint32 maxDelay; uint32 capDelay; address[] destinations; uint8 bizStartHourUtc; uint8 bizEndHourUtc; uint128 usualMaxPayout; }",
  "function createVault(string name, VaultConfig cfg) returns (address)",
]);
const hubAbi = parseAbi(["function resolve(string name) view returns (address)"]);
const erc20 = parseAbi(["function approve(address, uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const vaultAbi = parseAbi([
  "function deposit(uint256 amount, address to)",
  "function requestUnwrap(uint256 amount, address destination) returns (uint256)",
]);

const send = async (req: Parameters<typeof wallet.writeContract>[0], what: string) => {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`${what}: ${hash} (gas ${r.gasUsed})`);
  return r;
};

const balance = await pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [account.address] });
console.log(`sim wallet ${account.address}, ${balance} USDC (6dp)`);
if (balance < 15_000000n) throw new Error("fund the sim wallet with ~20 testnet USDC (faucet.circle.com, Arc Testnet)");

let vault = (await pub.readContract({ address: dep.hub, abi: hubAbi, functionName: "resolve", args: [NAME] })) as Hex;
if (/^0x0+$/.test(vault)) {
  await send(
    {
      address: dep.factory,
      abi: factoryAbi,
      functionName: "createVault",
      args: [
        NAME,
        {
          wallets: [account.address, "0x000000000000000000000000000000000000c0c1", "0x000000000000000000000000000000000000c0c2"],
          recoveryKey: "0x000000000000000000000000000000000000c0de",
          recoveryVault: "0x000000000000000000000000000000000000fade",
          budget24h: 1_000000n, budget7d: 4_000000n, hardCap: 8_000000n,
          floorDelay: 15 * 60, maxDelay: 72 * 3600, capDelay: 24 * 3600,
          destinations: [KNOWN], bizStartHourUtc: 9, bizEndHourUtc: 17, usualMaxPayout: 3_000000n,
        },
      ],
    } as never,
    "createVault",
  );
  vault = (await pub.readContract({ address: dep.hub, abi: hubAbi, functionName: "resolve", args: [NAME] })) as Hex;
}
console.log(`vault "${NAME}" = ${vault}`);

const need = amount + 1_000000n; // + 1 USDC bond
await send({ address: USDC, abi: erc20, functionName: "approve", args: [vault, need] } as never, "approve");
await send({ address: vault, abi: vaultAbi, functionName: "deposit", args: [need, account.address] } as never, "deposit");
const r = await send(
  { address: vault, abi: vaultAbi, functionName: "requestUnwrap", args: [amount, dest] } as never,
  `requestUnwrap ${amount} → ${mode} destination`,
);

const topic = encodeEventTopics({ abi: hubEventsAbi, eventName: "RequestQueued" })[0];
const i = r.logs.findIndex((l) => l.address.toLowerCase() === dep.hub.toLowerCase() && l.topics[0] === topic);
console.log(`\nSentinel trigger: --evm-tx-hash ${r.transactionHash} --evm-event-index ${i}`);
