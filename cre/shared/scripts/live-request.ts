#!/usr/bin/env bun
/**
 * Creates a real Queued request on Sepolia for the Sentinel to score, from the CRE simulation wallet
 * (CRE_ETH_PRIVATE_KEY in cre/.env): onboards a test Vault once, deposits ETH, then queues an ETH unwrap above
 * the Instant budget. Prints the tx hash + Hub log index to pass to
 *   cre workflow simulate sentinel --evm-tx-hash <hash> --evm-event-index <i>
 *
 *   bun shared/scripts/live-request.ts [known|new]   # destination on the Vault's allowlist (→ CLEAR) or not (→ HOLD)
 */
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeEventTopics, http, parseAbi, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { hubEventsAbi } from "../abi";

const root = join(import.meta.dir, "../..");
const dep = await Bun.file(join(root, "../deployments/sepolia.json")).json();
const weth = (await Bun.file(join(root, "../config/sepolia.json")).json()).tokens.weth as Hex;
const key = process.env.CRE_ETH_PRIVATE_KEY;
if (!key) throw new Error("CRE_ETH_PRIVATE_KEY missing (cre/.env)");
const account = privateKeyToAccount(`0x${key.replace(/^0x/, "")}`);
const rpc = http(process.env.SEPOLIA_RPC_URL);
const pub = createPublicClient({ chain: sepolia, transport: rpc });
const wallet = createWalletClient({ chain: sepolia, transport: rpc, account });

const LABEL = "cre-sim";
const KNOWN = "0x000000000000000000000000000000000000dead" as Hex; // on the allowlist at onboarding
const NEW = "0x00000000000000000000000000000000000be11e" as Hex;
const dest = process.argv[2] === "new" ? NEW : KNOWN;

const factoryAbi = parseAbi([
  "struct VaultConfig { address owner; address[] hotWallets; address defaultReceiver; address guardian; address recoveryKey; address recoveryVault; address approver; bytes32 passkeyX; bytes32 passkeyY; uint128 budget24h; uint128 budget7d; uint128 hardCap; uint32 floorDelay; uint32 fullDelay; address[] destinations; uint8 bizStartHourUtc; uint8 bizEndHourUtc; uint128 usualMaxPayout; }",
  "function createVault(string label, VaultConfig cfg) payable returns (address)",
  "function vaultOf(string label) view returns (address)",
]);
const vaultAbi = parseAbi([
  "function depositETH(address to) payable",
  "function requestUnwrap(address underlying, uint256 amount, address destination, bool asWeth) payable returns (uint256)",
  "function valueUsd(address underlying, uint256 amount) view returns (uint256 usd, bool stale)",
]);

const send = async (req: Parameters<typeof wallet.writeContract>[0], what: string) => {
  const hash = await wallet.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${what} reverted: ${hash}`);
  console.log(`${what}: ${hash} (gas ${r.gasUsed})`);
  return r;
};

const balance = await pub.getBalance({ address: account.address });
console.log(`sim wallet ${account.address}, balance ${balance} wei`);
if (balance < parseEther("0.02")) throw new Error("fund the sim wallet with ~0.05 Sepolia ETH first");

let vault = (await pub
  .readContract({ address: dep.factory, abi: factoryAbi, functionName: "vaultOf", args: [LABEL] })
  .catch(() => undefined)) as Hex | undefined;
if (!vault || /^0x0+$/.test(vault)) {
  const me = account.address;
  await send(
    {
      address: dep.factory,
      abi: factoryAbi,
      functionName: "createVault",
      value: parseEther("0.001"),
      args: [
        LABEL,
        {
          owner: me, hotWallets: [me], defaultReceiver: me, guardian: me,
          recoveryKey: "0x000000000000000000000000000000000000c0de", recoveryVault: "0x000000000000000000000000000000000000fade",
          approver: "0x0000000000000000000000000000000000000000",
          passkeyX: `0x${"00".repeat(32)}`, passkeyY: `0x${"00".repeat(32)}`,
          budget24h: 5_000000n, budget7d: 20_000000n, hardCap: 50_000000n,
          floorDelay: 15 * 60, fullDelay: 24 * 3600, destinations: [KNOWN],
          bizStartHourUtc: 0, bizEndHourUtc: 0, usualMaxPayout: 0n,
        },
      ],
    } as never,
    "createVault",
  );
  vault = (await pub.readContract({ address: dep.factory, abi: factoryAbi, functionName: "vaultOf", args: [LABEL] })) as Hex;
}
console.log(`vault ${LABEL}.palmfi.eth = ${vault}`);

// ~$8 of ETH: above the $5 Instant budget, below the $50 Hard cap.
const [usdPerEth] = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "valueUsd", args: [weth, parseEther("1")] });
const amount = (8_000000n * 10n ** 18n) / usdPerEth;
await send({ address: vault, abi: vaultAbi, functionName: "depositETH", args: [account.address], value: amount } as never, "depositETH");
const r = await send(
  { address: vault, abi: vaultAbi, functionName: "requestUnwrap", args: [weth, amount, dest, false], value: parseEther("0.001") } as never,
  `requestUnwrap $8 → ${dest === KNOWN ? "known" : "new"} destination`,
);

const topic = encodeEventTopics({ abi: hubEventsAbi, eventName: "UnwrapRequested" })[0];
const i = r.logs.findIndex((l) => l.address.toLowerCase() === dep.hub.toLowerCase() && l.topics[0] === topic);
console.log(`\nSentinel trigger: --evm-tx-hash ${r.transactionHash} --evm-event-index ${i}`);
