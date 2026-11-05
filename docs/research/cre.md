# Chainlink CRE (TypeScript SDK) research for palmfi

Researched 2026-11-06 for brief.md §8. Target chain: Ethereum Sepolia (`ethereum-testnet-sepolia`).
Sources: docs.chain.link/cre (fetched via the site's official `ts/llms-full.txt` dump, each page's own URL cited), `smartcontractkit/cre-cli`, `cre-sdk-typescript`, `cre-templates`, `chainlink-evm` (KeystoneForwarder), npm registry, and Sepolia RPC calls. Anything not confirmed in a primary source is marked **UNVERIFIED**.
Docs dump used: https://docs.chain.link/cre/ts/llms-full.txt (index: https://docs.chain.link/cre/llms.txt).

---

## TL;DR: what palmfi should do

1. Simulation-first. Install CLI v1.39.0, `cre login`, scaffold with `cre init`, and treat `cre workflow simulate --broadcast` against Sepolia as the deliverable. Live deploy needs approval ([deploy access](https://docs.chain.link/cre/guides/operations/deploy-access)); request it now (`cre account access`, purpose "Hackathon") but do not depend on it.
2. Hub (and any consumer) inherits `ReceiverTemplate`. In simulation construct it with the **MockKeystoneForwarder `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`**; live uses **KeystoneForwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`** ([forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts)). Both verified onchain (see §3.4). Make the forwarder address settable (the template already is).
3. **brief §8.4 conflict:** the mock forwarder supplies no workflow metadata, so `setExpectedWorkflowId/Author/Name` must NOT be set during simulation or reports revert ([consumer contracts §4](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)). Workflow-ID pinning is only provable on a live deploy. Test the check in Foundry with a fake forwarder passing real 64-byte metadata; label it as such.
4. **brief §8.2 quotas are stale.** Current docs: 50 concurrent executions per workflow (not 5), 15 HTTP calls (not 5) ([service quotas](https://docs.chain.link/cre/service-quotas)). New binding limits the brief misses: log trigger 10 events/6s burst 10, max 5 watched addresses, HTTP trigger 1 fire per 30s (burst 1), and a **3-workflow cap per org** on the private registry. Five separate workflows will not all deploy; merge to 3 or request an increase.
5. Use the raw `evmClient.logTrigger({... confidence: "CONFIDENCE_LEVEL_LATEST"})` for the Sentinel. The CLI's generated `logTrigger<Event>()` helper does not pass `confidence`, so it silently uses the default `SAFE` ([template source](https://github.com/smartcontractkit/cre-cli/blob/main/cmd/generate-bindings/evm/sourcecre.ts.tpl)).
6. The log payload has **no block timestamp** (only block number/hash). For "block timestamps from the trigger" call `evmClient.headerByNumber` (costs one of 15 reads) or use `runtime.now()` (DON time). Never `Date.now()`.
7. Check **both** `txStatus` and `receiverContractExecutionStatus` after `writeReport`; a tx can succeed while `onReport` reverts. Reverted reports are not marked used by the forwarder, so keep nonce/expiry/chain-selector in the payload.
8. Failure-matrix fixtures: `simulate` replays a **real Sepolia tx hash + event index** for log triggers (so `removed=true` cannot be produced) and arbitrary JSON for the HTTP trigger. Use `@chainlink/cre-sdk/test` mocks (`EvmMock`, `newTestRuntime`) for synthetic cases, and a small set of real-tx `cre workflow simulate --limits default` runs for the demo.
9. Confidential HTTP is GA in production and works in simulation; secrets must go through `vaultDonSecrets` + `{{.key}}` templates, not `getSecret()`.
10. Pin versions: CLI 1.39.0, `@chainlink/cre-sdk` ^1.23.0, Bun >= 1.2.21, viem (SDK dep ^2.54.2), zod 3.25.76.

---

## 1. Project and workflow setup

**CLI install.** `curl -sSL https://app.chain.link/cre/install.sh | bash` installs to `$HOME/.cre`; verify with `cre version` ([macOS/Linux install](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux)). Manual binaries are on [cre-cli releases](https://github.com/smartcontractkit/cre-cli/releases). Latest release is **v1.39.0** (2026-10-21) per `gh api repos/smartcontractkit/cre-cli/releases/latest` and the [release notes](https://docs.chain.link/cre/release-notes). `cre update` self-updates.

**Account/auth.** Most commands need a Chainlink Platform account and `cre login` (browser OAuth) ([CLI login](https://docs.chain.link/cre/guides/cli/cli-login)); `CRE_API_KEY` works for CI ([authentication](https://docs.chain.link/cre/reference/cli/authentication)). `cre init` requires login ([project setup](https://docs.chain.link/cre/reference/cli/project-setup-ts)). `generate-bindings`, `workflow build/hash` work logged out ([v1.36.0 notes](https://docs.chain.link/cre/release-notes)).

**Runtime prerequisites.** Bun >= 1.2.21 ([Part 1](https://docs.chain.link/cre/getting-started/part-1-project-setup-ts)). TS compiles via Javy to WASM running in QuickJS, not Node; `node:crypto`/`node:fs` are unavailable ([TS WASM runtime](https://docs.chain.link/cre/concepts/typescript-wasm-runtime)). Test libraries in simulation.

**Scaffold.**
```bash
cre init                      # interactive
cre init --non-interactive -p palmfi -w sentinel -t hello-world-ts \
  --deployment-registry private --rpc-url ethereum-testnet-sepolia=https://...
cd sentinel && bun install
```
(flags from [project-setup ref](https://docs.chain.link/cre/reference/cli/project-setup-ts); `--rpc-url` is `chain-name=url`.)

**Layout** ([Part 1](https://docs.chain.link/cre/getting-started/part-1-project-setup-ts), [project config](https://docs.chain.link/cre/reference/project-configuration-ts)):
```
palmfi-cre/
  project.yaml          # per-target rpcs (shared)
  secrets.yaml          # logical secret names -> env var names
  .env                  # CRE_ETH_PRIVATE_KEY, secret values (gitignored)
  contracts/abi/*.ts    # viem ABIs; or contracts/evm/src/abi/*.abi + generated bindings
  sentinel/             # one dir per workflow
    main.ts config.staging.json config.production.json package.json tsconfig.json workflow.yaml
```
- `project.yaml`: `staging-settings: rpcs: [{chain-name: ethereum-testnet-sepolia, url: ...}]`. RPC URLs support `${ENV_VAR}`. **Missing RPC makes simulation fail.** Same target name must exist in both `project.yaml` and `workflow.yaml` ([project config](https://docs.chain.link/cre/reference/project-configuration-ts)).
- `workflow.yaml`: `user-workflow.workflow-name`, optional `deployment-registry` (`private` | `onchain:ethereum-mainnet`), `workflow-artifacts.{workflow-path: ./main.ts, config-path, secrets-path: ../secrets.yaml}`. TS `workflow-path` points to the file, not the dir.
- Config size limit 50 KB ([quotas](https://docs.chain.link/cre/service-quotas)).
- `cre generate-bindings evm` reads `contracts/evm/src/abi/*.abi|json`, emits typed classes + mocks into `contracts/evm/ts/generated/` ([bindings](https://docs.chain.link/cre/guides/workflow/using-evm-client/generating-bindings-ts)).

**Packages/versions.**
- `@chainlink/cre-sdk`: npm `latest` = 1.23.0, `alpha` = 1.24.0-alpha.1 (`npm view`; [GitHub releases](https://github.com/smartcontractkit/cre-sdk-typescript/releases)). Deps: viem ^2.54.2, zod 3.25.76, `@chainlink/cre-sdk-javy-plugin` 1.7.0.
- The CLI's own template pins `"@chainlink/cre-sdk": "^1.22.0"`, devDep `typescript 5.9.3` ([hello-world-ts package.json](https://github.com/smartcontractkit/cre-cli/blob/main/internal/templaterepo/builtin/hello-world-ts/workflow/package.json)). Ethereum Sepolia needs TS SDK >= 1.0.1 ([supported networks](https://docs.chain.link/cre/supported-networks-ts)).
- Test helpers: `@chainlink/cre-sdk/test` (`EvmMock`, `newTestRuntime`, `test`) used with `bun:test` ([circuit-breaker test](https://github.com/smartcontractkit/cre-templates/blob/main/starter-templates/circuit-breaker/circuit-breaker-ts/my-workflow/workflow.test.ts)).

**Minimal skeleton** (adapted from [Part 1](https://docs.chain.link/cre/getting-started/part-1-project-setup-ts)):
```ts
import { CronCapability, handler, Runner, type Runtime } from "@chainlink/cre-sdk"
const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)]
export async function main() { const r = await Runner.newRunner<Config>(); await r.run(initWorkflow) }
```
Templates use `Runner.newRunner({ configSchema })` with zod and a separate `workflow.ts` ([circuit-breaker main.ts](https://github.com/smartcontractkit/cre-templates/blob/main/starter-templates/circuit-breaker/circuit-breaker-ts/my-workflow/main.ts)); both forms exist.

Multiple handlers per workflow (up to 10 triggers) are returned as an array from `initWorkflow`; `--trigger-index` selects by array order ([simulating](https://docs.chain.link/cre/guides/operations/simulating-workflows)).

---

## 2. Triggers

### 2.1 EVM log trigger ([reference](https://docs.chain.link/cre/reference/sdk/triggers/evm-log-trigger-ts), [guide](https://docs.chain.link/cre/guides/workflow/using-triggers/evm-log-trigger-ts))
```ts
import { EVMClient, getNetwork, hexToBase64, handler } from "@chainlink/cre-sdk"
import { keccak256, toBytes, padHex } from "viem"
const net = getNetwork({ chainFamily: "evm", chainSelectorName: "ethereum-testnet-sepolia" })!
const evm = new EVMClient(net.chainSelector.selector)   // 16015286601757825753n
evm.logTrigger({
  addresses: [hexToBase64(HUB)],                                    // max 5
  topics: [
    { values: [hexToBase64(keccak256(toBytes("UnwrapRequested(...)")))] }, // topic0, <=10 values per slot
    { values: [hexToBase64(padHex(vault, { size: 32 }))] },         // indexed arg, MUST pad to 32B
    { values: [] },                                                 // wildcard
  ],
  confidence: "CONFIDENCE_LEVEL_LATEST",  // SAFE is the DEFAULT; also _FINALIZED
})
```
- Addresses and topics must be **base64** (`hexToBase64`); the simulator tolerates raw hex but deployed workflows do not. Unpadded topics 1-3 silently never match.
- Confidence: `CONFIDENCE_LEVEL_LATEST | _SAFE (default) | _FINALIZED`; no custom block depths for triggers ([finality](https://docs.chain.link/cre/concepts/finality-ts)). Matches brief §8.1.
- Payload `EVMLog`: `address, topics[], data, txHash, blockHash, blockNumber?, txIndex, index, eventSig, removed`. `removed` = "True if the log was removed during a reorg". **No timestamp field.**
- Quotas: event rate 10 per 6 s, burst 10; max 5 addresses; 10 topic values per slot; 5 KB per event; 10 triggers per workflow ([quotas](https://docs.chain.link/cre/service-quotas)). **A flood on the Hub will hit the 10/6s rate before concurrency.** Excess is queued/retried 10 min then dropped (same page, Per-owner note).
- **Gotcha, docs vs code:** docs say bindings' `logTrigger<Event>()` "handle topic encoding" ([bindings](https://docs.chain.link/cre/guides/workflow/using-evm-client/generating-bindings-ts)), but the generator template builds `this.client.logTrigger({addresses, topics})` with no `confidence` ([sourcecre.ts.tpl](https://github.com/smartcontractkit/cre-cli/blob/main/cmd/generate-bindings/evm/sourcecre.ts.tpl)), so it defaults to SAFE. Build the trigger manually (or wrap the adapt/decode) for LATEST. Generated helpers also support OR-merged filters.
- Handling `removed`: you must check `log.removed` yourself and treat it as a retraction. Whether the deployed log trigger actually delivers `removed=true` logs: **UNVERIFIED** (docs only list the field). The simulator builds the log from a receipt via `convertGethLog` and copies geth's `Removed` (always false for a mined receipt) ([trigger.go](https://github.com/smartcontractkit/cre-cli/blob/main/cmd/workflow/simulate/chain/evm/trigger.go)), so it cannot be fixture-tested via the CLI. Unit-test it with `newTestRuntime`.
- Decode with viem `decodeEventLog({abi, data: bytesToHex(log.data), topics: log.topics.map(bytesToHex)})`.

### 2.2 Cron trigger ([reference](https://docs.chain.link/cre/reference/sdk/triggers/cron-trigger-ts))
`new CronCapability().trigger({ schedule })`; 5 or 6 fields (optional leading seconds field), e.g. `"*/30 * * * * *"` = 30 s, minimum interval **30 s** (quota `FastestScheduleInterval` = 30 s; also warns about overlapping executions). Payload `scheduledExecutionTime: {seconds: bigint, nanos}`; the docs tell you to embed this scheduled slot time (not wall clock) in reports for replay protection ([consumer contracts, replay](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)). Brief's "every 1-2 min" is fine.

### 2.3 HTTP trigger ([reference](https://docs.chain.link/cre/reference/sdk/triggers/http-trigger-ts), [deployed](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/triggering-deployed-workflows))
```ts
new HTTPCapability().trigger({ authorizedKeys: [{ type: "KEY_TYPE_ECDSA_EVM", publicKey: "0xEvmAddress" }] })
// handler(runtime, payload: HTTPPayload) -> decodeJson(payload.input), payload.key
```
- Field is called `publicKey` but takes an **EVM address**. `{}` (no keys) is valid only in simulation; deployed workflows reject it.
- Deployed call: JSON-RPC 2.0 `workflows.execute` POST to the gateway (`https://01.gateway.zone-a.cre.chain.link` for CRE Public) with `Authorization: Bearer <JWT>`; JWT header `{"alg":"ETH","typ":"JWT"}`, payload `{digest: 0x+sha256(key-sorted request body), iss, iat, exp (max 5 min), jti}`, signed with an EIP-191 personal-sign of `b64url(header).b64url(payload)`. Reference impl: [`cre-http-trigger`](https://github.com/smartcontractkit/cre-sdk-typescript/tree/main/packages/cre-http-trigger/src). A local proxy "Local Testing Tool" handles JWTs.
- **One HTTP trigger handler per workflow.** Rate: 1 per 30 s, burst 1 ([quotas](https://docs.chain.link/cre/service-quotas)). The approvals inbox therefore cannot be a high-rate path; it should batch or the Reconciler should poll the approval API.
- Simulation: interactive JSON prompt or `--http-payload '{"..."}'` / `@file.json` ([simulating](https://docs.chain.link/cre/guides/operations/simulating-workflows)); `--listen` serves `POST http://localhost:2000/trigger` with `{"input": {...}}` and enforces the 30 s limit unless `--limits none` ([testing HTTP](https://docs.chain.link/cre/guides/workflow/using-triggers/http-trigger/testing-in-simulation)). Simulation does not verify JWT/authorized keys: **UNVERIFIED** beyond the "Simulation vs production behavior" section.

---

## 3. EVM client: reads and writes

### 3.1 Reads ([onchain read](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-read-ts), [finality](https://docs.chain.link/cre/concepts/finality-ts))
```ts
const res = evm.callContract(runtime, {
  call: encodeCallMsg({ from: zeroAddress, to: HUB, data: encodeFunctionData({abi, functionName:"pendingBatch", args:[...]}) }),
  blockNumber: LAST_FINALIZED_BLOCK_NUMBER,   // or LATEST_BLOCK_NUMBER (default), or blockNumber(123n)
}).result()
decodeFunctionResult({ abi, functionName, data: bytesToHex(res.data) })
```
- Reads support only LATEST and FINALIZED (+ explicit block number); **SAFE is not available for reads**. On Ethereum/Sepolia FINALIZED = native `finalized` tag; Polygon uses 500-block depth. Matches brief §8.1.
- Default if no blockNumber is LATEST. Finalized-read flakiness is documented for Arbitrum Sepolia, Linea Sepolia, etc., not Ethereum Sepolia.
- Limits: 15 calls/execution, 5 KB request payload, log queries limited to 100 blocks ([quotas](https://docs.chain.link/cre/service-quotas)).
- There is no multicall helper in the SDK: "batching" = your own Solidity view returning arrays (brief's batched views). Each `callContract` counts toward the 15. **UNVERIFIED** whether `.result()` calls issued before the first `.result()` run concurrently; the quota page allows 30 concurrent capability calls.
- Block timestamp: `evm.headerByNumber(runtime, {blockNumber}).result().header.timestamp` (bigint) ([EVM client ref](https://docs.chain.link/cre/reference/sdk/evm-client-ts)).

### 3.2 Write flow ([overview](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/overview-ts), [writing data](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/writing-data-onchain))
1. `encodeAbiParameters(...)` (use `bigint`, never `number`).
2. `runtime.report({ encodedPayload: hexToBase64(data), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" }).result()`
3. `evm.writeReport(runtime, { receiver, report, gasConfig: { gasLimit: "500000" } }).result()`
4. Check `txStatus` (SUCCESS | REVERTED | FATAL) **and** `receiverContractExecutionStatus` (`EVM_PB.ReceiverContractExecutionStatus.REVERTED`, from `@chainlink/cre-sdk/pb`); the two are independent.

DON consensus -> a designated node submits to `KeystoneForwarder` -> forwarder verifies signatures -> calls `receiver.onReport(metadata, report)`. Limits: report <= 50 KB, tx gas <= 10,000,000, <= 10 target chains ([quotas](https://docs.chain.link/cre/service-quotas)).

Typed shortcut: bindings generate `contract.writeReportFrom<Fn>(runtime, args)` ([bindings](https://docs.chain.link/cre/guides/workflow/using-evm-client/generating-bindings-ts)) and a base `writeReport(runtime, callData, gasConfig)`; the circuit-breaker template uses the latter ([workflow.ts](https://github.com/smartcontractkit/cre-templates/blob/main/starter-templates/circuit-breaker/circuit-breaker-ts/my-workflow/workflow.ts)).

### 3.3 Forwarder behaviour (contract source)
From [`KeystoneForwarder.sol`](https://github.com/smartcontractkit/chainlink-evm/blob/b6427ea1f4847d640abdf24dbd6c6f01d7799d59/contracts/cre/src/v1/KeystoneForwarder.sol):
- `report(receiver, rawReport, reportContext, signatures)` checks `f+1` unique trusted signatures, then `route(...)`.
- `transmissionId = keccak256(receiver ++ workflowExecutionId ++ reportId)`; if `success || invalidReceiver` it reverts `AlreadyAttempted`. **A report whose `onReport` reverts is not marked success**, so it can be re-delivered (matches docs warning in [consumer contracts, same-chain replay](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)).
- The receiver must pass ERC165 `supportsInterface(IReceiver)` or the transmission is flagged `invalidReceiver`.
- `onReport` is called with a bounded gas amount and its return data ignored; a revert is swallowed into `success=false` and emits `ReportProcessed(receiver, workflowExecutionId, reportId, success)`.

### 3.4 Consumer pattern and metadata
`IReceiver` (ERC165 + `onReport(bytes calldata metadata, bytes calldata report)`) and `ReceiverTemplate` full source: [consumer contracts](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts). Vendored copies: [cre-templates ReceiverTemplate.sol](https://github.com/smartcontractkit/cre-templates/blob/main/starter-templates/circuit-breaker/circuit-breaker-ts/contracts/evm/src/ReceiverTemplate.sol).
```solidity
contract Hub is ReceiverTemplate {
  constructor(address forwarder) ReceiverTemplate(forwarder) {}   // Ownable(msg.sender)
  function _processReport(bytes calldata report) internal override { /* decode, check nonce/expiry/hash */ }
}
```
Template checks: `msg.sender == forwarder`; if configured, `workflowId == expectedWorkflowId`, `workflowOwner == expectedAuthor`, and `workflowName == expectedWorkflowName` (name check **requires** author check, reverts `WorkflowNameRequiresAuthorValidation` otherwise). Setting the forwarder to `address(0)` disables the caller check (emits `SecurityWarning`). Setters are `onlyOwner` (no timelock, so for brief §8.4 "rotating the workflow ID needs timelock + member vote" you must override/own that logic: the template's `setExpectedWorkflowId` is a plain owner call).

**Metadata layout.** Logical packing = `abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address workflowOwner)` = 62 bytes. Production forwarder passes a **64-byte** slice (`rawReport[45:109]`): the 62 bytes plus `bytes2 reportId` at indices 62-63. Do not `require(metadata.length == 62)`; accept 64 ([consumer contracts, metadata](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts); `METADATA_LENGTH=109`, `FORWARDER_METADATA_LENGTH=45` in the forwarder source above). Decode: `workflowId := mload(add(metadata,32))`, name at +64, owner `shr(96, mload(add(metadata,74)))` (`_decodeMetadata` in the template).
**Workflow name encoding:** `bytes10` = hex-encode of the first 10 hex chars of `sha256(name)` (example in docs: `"my_workflow"` -> `0x62373666336165316465`). Name is only 40 bits, so always pair with owner. `setExpectedWorkflowName("name")` does this on-chain.

**Replay guidance from the docs** (adopt in the Hub payload, brief §8.4 already has nonce+expiry): include the target **chain selector** (cross-chain replay) and a **monotonic scheduled/trigger timestamp** (same-chain replay after failure). Source: [consumer contracts §7](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts).

**Forwarder addresses on Ethereum Sepolia** ([forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts)):

| Use | Contract | Address | Check |
|---|---|---|---|
| Simulation (`--broadcast`) | MockKeystoneForwarder | `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` | Same address hard-coded in [cre-cli supported_chains.go](https://github.com/smartcontractkit/cre-cli/blob/main/cmd/workflow/simulate/chain/evm/supported_chains.go); my `eth_call typeAndVersion()` on Sepolia returned `MockKeystoneForwarder 1.0.0` |
| Live deployed workflow | KeystoneForwarder | `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` | `typeAndVersion()` returned `KeystoneForwarder 1.0.0` |

The docs say the directory lists "chains commonly enabled", and `cre workflow supported-chains` gives your tenant's authoritative list ([supported networks](https://docs.chain.link/cre/supported-networks-ts)). Run it after login before deploying.
Mock forwarder caveat: it "does not provide workflow metadata (`workflow_name`, `workflow_owner`)" and the docs call it a "temporary limitation" ([consumer contracts §4](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/building-consumer-contracts)). Whether it also omits `workflowId` and what the metadata bytes look like under the mock: **UNVERIFIED** (I did not read the mock's source). Practical rule: no metadata checks in simulation.

---

## 4. HTTP, Confidential HTTP, consensus, secrets

**HTTP client** ([GET](https://docs.chain.link/cre/guides/workflow/using-http-client/get-request-ts), [POST](https://docs.chain.link/cre/guides/workflow/using-http-client/post-request-ts)). Every DON node executes the request independently, then results are aggregated. High-level pattern:
```ts
const out = new HTTPClient().sendRequest(runtime, fetchFn, ConsensusAggregationByFields<Out>({ price: median<number>(), status: identical() }))(runtime.config).result()
```
- No redirects (3xx fails). Use `runtime.now()` for any timestamp in requests.
- For POST/PUT/PATCH/DELETE add `cacheSettings: { readFromCache: true, maxAgeMs: 60000 }` so one node's response is reused. This is documented as **best effort**, so duplicates are possible ([HTTP client ref](https://docs.chain.link/cre/reference/sdk/http-client-ts)). Confirms brief §8.5 / §15.26: approval API must be idempotent (key = request hash).
- Quotas: 15 requests/execution, 120 KB request, 250 KB response, 10 s connect timeout, cache max age 10 min.

**Consensus** ([consensus ref](https://docs.chain.link/cre/reference/sdk/consensus-ts)): `consensusMedianAggregation` (number|bigint|Date), `consensusIdenticalAggregation` (Byzantine quorum identical), `consensusCommonPrefix/SuffixAggregation`, and `ConsensusAggregationByFields` with `median() | identical() | commonPrefix() | commonSuffix() | ignore()`. Use `runtime.runInNodeMode(fn, aggregation)().result()` for custom node-level logic. Limits: 25 KB per observation, 50 consensus calls/execution. For brief §8.3 verdicts: make verdict computation run in DON mode over consensus-verified inputs (EVM reads are already consensus-verified), and aggregate only raw HTTP facts (e.g., `approved: identical()`).

**Confidential HTTP** ([capability](https://docs.chain.link/cre/capabilities/confidential-http-ts), [usage](https://docs.chain.link/cre/guides/workflow/using-confidential-http-client/making-requests-ts)): GA for production since 2026-02-25 ([release notes](https://docs.chain.link/cre/release-notes)); simulator support since Feb 2026. Exactly one outbound call from an enclave after quorum on request params (no duplicate-call problem).
```ts
new ConfidentialHTTPClient().sendRequest(runtime, {
  request: { url, method: "POST", multiHeaders: { Authorization: { values: ["Bearer {{.approvalKey}}"] } },
             body: ..., encryptOutput: true, timeout: { seconds: 10n, nanos: 0 } },
  vaultDonSecrets: [{ key: "approvalKey", owner: runtime.config.owner }, { key: "san_marino_aes_gcm_encryption_key" }],
}).result()
```
- Takes `Runtime` directly (no `runInNodeMode`). Secrets must be referenced only via `{{.key}}` and `vaultDonSecrets` (alphabetical key order if several); pasting a `getSecret()` value defeats the enclave. Timeout default 5 s, max 10 s. Response encryption = AES-256-GCM, body `nonce || ciphertext || tag`, key stored as Vault secret `san_marino_aes_gcm_encryption_key`; decrypt in your own backend, not in the workflow. No in-enclave data transformation.
- Quotas: 15 requests, 125 KB request, 500 KB response, 90 s ([quotas](https://docs.chain.link/cre/service-quotas)).
- Because the response is encrypted/opaque, the Sentinel cannot read an encrypted response to decide a verdict. For brief §13.2 step 5 either leave `encryptOutput` off (response visible to the workflow, not confidential on the DON) or have the approval API return only a coarse signed boolean. Design choice to make.

**Secrets / Vault DON** ([secrets](https://docs.chain.link/cre/guides/workflow/secrets), [simulation](https://docs.chain.link/cre/guides/workflow/secrets/using-secrets-simulation-ts), [deployed](https://docs.chain.link/cre/guides/workflow/secrets/using-secrets-deployed)):
- Declare in `secrets.yaml` (`secretsNames: { KEY: [ENV_VAR] }`), set `secrets-path` in `workflow.yaml`. Simulation reads env/`.env`. Deployed: `cre secrets create|update|delete|list` to the Vault DON; private-registry workflows use `--secrets-auth=browser`.
- Code: `runtime.getSecret({ id: "KEY" }).result().value`; batch `runtime.getSecrets()`. Only inside handlers, not during trigger registration. Quotas: 5 fetch calls/execution, 10 secrets per request, 2 KB per secret, 100 secrets per owner, 27 KB total per workflow ([quotas](https://docs.chain.link/cre/service-quotas)).
- Company profiles "in the Vault DON" (brief §8.2): 2 KB per secret and 27 KB per workflow cap bound profile size; keep profiles tiny or fetch profile JSON from the approval API.

---

## 5. Service quotas and `cre workflow simulate`

**Quotas** (all from [service quotas](https://docs.chain.link/cre/service-quotas), updated 2026-10-29, "subject to change") compared with brief:

| Quota | Docs now | brief §8.2/§15.23 | Note |
|---|---|---|---|
| Triggers per workflow | 10 | 10 | ok |
| Concurrent executions per workflow | **50** | 5 | brief stale; CLI 1.20 moved 10 to 50 ([notes](https://docs.chain.link/cre/release-notes)) |
| Concurrent per owner | 200 | - | |
| Execution timeout | 5 min | 5 min | ok |
| EVM reads / execution | 15 | 15 | ok |
| HTTP calls / execution | **15** (Confidential: 15) | 5 | brief stale |
| Queued then dropped | retried up to 10 min, then dropped | same | ok |
| Log trigger rate | **10 per 6 s, burst 10**; 5 addresses | - | new constraint |
| HTTP trigger rate | **1 per 30 s, burst 1** | - | new constraint |
| Cron min | 30 s | 30 s | ok |
| Private registry workflows per org | **3** | 5 workflows | blocks 5 deployments |
| Capability calls concurrent | 30; single call timeout 3 min | - | |
| Report size / gas | 50 KB / 10M | - | |
| Wasm / memory | 100 MB bin, 20 MB compressed, 100 MB RAM, 100 KB response | - | |
| Logs | 1 KB/line, 1000 events/execution | - | |

Registry quota note: "Registry quotas are being actively tuned ahead of general availability" and `cre registry list` shows your org's access ([quotas](https://docs.chain.link/cre/service-quotas), [deploying](https://docs.chain.link/cre/guides/operations/deploying-workflows)). Whether the hackathon grants raise the cap: **UNVERIFIED**; ask via app.chain.link Help (issue type Other) citing the quota key ([limits guide](https://docs.chain.link/cre/guides/operations/understanding-limits)).

**Simulate** ([simulating](https://docs.chain.link/cre/guides/operations/simulating-workflows), [limits](https://docs.chain.link/cre/guides/operations/understanding-limits)):
```bash
cre workflow simulate sentinel --target staging-settings                 # interactive trigger pick
cre workflow simulate sentinel --non-interactive --trigger-index 0 --target staging-settings --broadcast
cre workflow simulate sentinel --non-interactive --trigger-index 2 \
  --evm-tx-hash 0x... --evm-event-index 0 --target staging-settings       # log trigger replay
cre workflow simulate approvals --non-interactive --trigger-index 1 --http-payload @./fixtures/approved.json
cre workflow simulate sentinel --limits default | none | ./my-limits.json   # default is already "default"
cre workflow limits export > limits.json                                   # inspect/edit quotas
cre workflow build ./sentinel && cre workflow simulate ./sentinel --wasm ./binary.wasm
```
- `--limits default` is the default behaviour; `none` disables; a JSON file customizes (simulation only). Brief §8.6/§16.4 "`--limits default`" is correct, just redundant.
- Compiles to WASM and runs on your machine as a **single node**: "no actual consensus or quorum, it is simulated"; cron fires immediately on selection ([limitations](https://docs.chain.link/cre/guides/operations/simulating-workflows)). Consensus-divergence bugs (non-determinism) therefore do NOT show up in simulation.
- Without `--broadcast`, writes are a dry run and the tx hash prints as `0x000...0`. With `--broadcast`, a real tx is sent from `CRE_ETH_PRIVATE_KEY` (must hold Sepolia ETH; faucet https://faucets.chain.link). It goes to the **MockKeystoneForwarder**, so your consumer must trust that address.
- Fixtures:
  - HTTP trigger: any JSON via `--http-payload` (string or `@file`).
  - EVM log trigger: a real `--evm-tx-hash` + `--evm-event-index`; the simulator fetches the receipt from your RPC ([trigger.go](https://github.com/smartcontractkit/cre-cli/blob/main/cmd/workflow/simulate/chain/evm/trigger.go)). Synthetic events are impossible; a fixture = a pre-recorded Sepolia tx. Plan: deploy the Hub, fire each scenario once, record tx hashes in `fixtures.json`, replay with a script. Log trigger `--listen` also exists.
  - Cron: no input.
  - `--non-interactive` needs `--trigger-index`; combined with `--listen` for HTTP also needs `--http-payload`.
- Each case in brief §8.6 "CRE CLI simulation fixture with an expected verdict": the CLI prints the workflow return value ("Workflow Simulation Result"), so have the handler return the verdict string and assert on it in a shell script. For cases that require synthetic state (reorg `removed=true`, API timeout, stale oracle) use `bun test` with `@chainlink/cre-sdk/test` mocks ([bindings mocks](https://docs.chain.link/cre/guides/workflow/using-evm-client/generating-bindings-ts)); say so in the demo rather than claiming every row is a CLI fixture.
- The write step in simulation needs the Hub deployed with the mock forwarder and **without** workflow-ID/author/name checks.

---

## 6. Supported networks and live deployment

- **Ethereum Sepolia is supported** for simulation and deployment: CLI v1.0.0+, TS SDK v1.0.1+, chain name `ethereum-testnet-sepolia`, selector `16015286601757825753` ([supported networks](https://docs.chain.link/cre/supported-networks-ts), [EVM client chain selectors](https://docs.chain.link/cre/reference/sdk/evm-client-ts)). Ethereum Hoodi is also supported (CLI 1.35.0+). Production forwarder exists for Sepolia (§3.4), so live Sepolia writes are listed.
- Tenant-scoped: availability and forwarders depend on your org; check `cre workflow supported-chains` ([supported networks](https://docs.chain.link/cre/supported-networks-ts)).
- Finality for Ethereum Sepolia: native `finalized` tag ([finality](https://docs.chain.link/cre/concepts/finality-ts)).
- **Live deploy requires approval:** "Workflow deployment requires approval. Run `cre account access`" and the request asks for purpose (Hackathon/Evaluation/Production) and a use-case description; Chainlink emails after review ([deploy access](https://docs.chain.link/cre/guides/operations/deploy-access)). Timing for hackathon approvals: **UNVERIFIED**. Deploy access only gates `cre workflow deploy`; simulate/build are unaffected. Brief §15.27 and §16.1 ("CLI simulation qualifies") are consistent with this.
- Two registries ([deploying](https://docs.chain.link/cre/guides/operations/deploying-workflows)): `private` (CRE login auth, no wallet/gas/mainnet RPC; 3 workflows/org) or `onchain:ethereum-mainnet` (linked wallet + mainnet ETH for gas; 1 linked key/org, 3 workflows/key). For a Sepolia hackathon deploy, `private` avoids needing mainnet ETH. Linking a key is permanent per org ([v1.38.0 notes](https://docs.chain.link/cre/release-notes)).
- Private registry still runs on a public DON ("Private is not confidential") ([deploying](https://docs.chain.link/cre/guides/operations/deploying-workflows)). Confidential Workflows (full-handler enclave) are private-beta/invite-only but runnable in the simulator ([access](https://docs.chain.link/cre/guides/operations/confidential-workflows-access)); not needed for palmfi.

---

## 7. Gotchas for brief §8

**Determinism / time** ([non-determinism](https://docs.chain.link/cre/concepts/non-determinism-ts), [time](https://docs.chain.link/cre/guides/workflow/time-in-workflows-ts))
- Every node runs your code; divergent code paths yield different request IDs and no quorum. Don't use `Date.now()`/`new Date()`: use `runtime.now()` (DON time, median of node clocks, "not a high-precision clock"). Sort object keys before iterating; no `Promise.race/any`; call `.result()` in fixed order. `Math.random()` is overridden to be consensus-safe inside the CRE runtime.
- brief §8.1.6 "Use block timestamps from the trigger, not node clocks": the trigger payload has no timestamp. Options: `headerByNumber(log.blockNumber)` (1 read; at LATEST the header may be reorged), or `runtime.now()` for off-hours scoring (OFF_HOURS reason code). For the 2am check, `runtime.now()` is the pragmatic choice; document that it is DON time.
- Do not issue the same non-idempotent HTTP call from node mode without cacheSettings, or use Confidential HTTP.
- Use viem `parseUnits` and `bigint` everywhere (precision loss otherwise) ([writing data](https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/writing-data-onchain)).

**Write reply = included, not finalized** ([finality](https://docs.chain.link/cre/concepts/finality-ts)): `WriteReportReply` returns when the tx is in a block. On reorg CRE's TXM resubmits with gas bumping; **the tx hash may change and you are not notified.** Mission-critical flows must read state back after N confirmations. Matches brief §8.4 "Reconciler re-sends if state doesn't reflect it". Combine with the forwarder's `AlreadyAttempted` guard: re-sending the *same* report after success reverts; a re-send from a *new* execution needs a fresh nonce.

**Receiver revert is silent at the tx level** (§3.2/3.3): handle `receiverContractExecutionStatus`. Also the forwarder gives `onReport` a bounded gas budget, so keep Hub `onReport` cheap (decode, verify, dispatch) or raise `gasConfig.gasLimit`.

**CLEAR re-read at FINALIZED (brief §8.1.3):** supported (`LAST_FINALIZED_BLOCK_NUMBER`). Finalized lags ~2 epochs (~13 min) on Ethereum, which would exceed the "floor = 15 min" less comfortably; the actual Sepolia lag is **UNVERIFIED** here. Budget it into the floor.

**Log trigger ordering/duplication:** docs make no at-least-once/exactly-once or ordering statement: **UNVERIFIED**. Hence the Reconciler is mandatory (brief already does this). Make verdict writing idempotent by `requestId`.

**Execution isolation:** one trigger rate limit (10/6s) is per workflow, so splitting Sentinel from Incident responder is genuinely helpful, but the 3-workflow org cap pulls the other way. Suggested packing (my recommendation, not from docs): (1) Sentinel+Approvals(HTTP) , (2) Reconciler+Market watcher (two cron handlers), (3) Incident responder. Simulation has no such cap, so keep 5 dirs in the repo and mention the deployment constraint.

**HTTP trigger inside Sentinel:** one HTTP trigger per workflow; the rate is 1/30s so do not make it a hot path.

**Reports can be sent over HTTP too** (`submitting-reports-http`) ([guide](https://docs.chain.link/cre/guides/workflow/using-http-client/submitting-reports-http-ts)): potentially useful to deliver the signed report to the notification service; not researched in depth.

**Docs vs code / docs vs brief disagreements found**
1. brief concurrency/HTTP quotas vs current quota page (above).
2. Docs prose for generated `logTrigger<Event>()` ("handle topic encoding") vs generator template: no `confidence` support, default SAFE.
3. HTTP trigger field `publicKey` actually holds an EVM address ([ref](https://docs.chain.link/cre/reference/sdk/triggers/http-trigger-ts)).
4. `ReceiverTemplate._decodeMetadata` comment mentions only the packed 62 bytes while production delivers 64 (docs clarify in the metadata section; template ignores trailing 2 bytes, so it works).
5. Docs' older mention that the mock forwarder is "temporary limitation" (no metadata); contract of the mock itself was not read: UNVERIFIED how it behaves with a `workflowId` check on.
6. brief links "supported-networks-go"; the TS page is [supported-networks-ts](https://docs.chain.link/cre/supported-networks-ts). Content for Sepolia is identical.
7. Brief §15.23 "queued and retried for up to 10 minutes then dropped" matches the quotas page exactly.

---

## Open risks (summary)
- 3-workflow private-registry cap vs 5-workflow design; live deploy approval timing unknown.
- Workflow-ID pinning (brief §8.4, §8.1.5) cannot be demonstrated in simulation; mock forwarder lacks metadata.
- `removed=true` and several failure-matrix rows cannot be CLI fixtures (log trigger replays real receipts).
- HTTP trigger 1/30s and log trigger 10/6s rate limits can be hit by the very flood scenario the brief defends against; "dropped after 10 min" is the failure mode, Reconciler is the mitigation.
- Confidential HTTP encrypted output vs workflow-side verdict logic.
- Simulation is single-node: determinism/consensus bugs are invisible until a live deploy.
