# ENSv2 research for palmfi (Sepolia, 2026-11-06)

Sources: official ENS docs (docs.ens.domains/ensv2, via [llms-full.txt](https://docs.ens.domains/llms-full.txt)), [ensdomains/contracts-v2](https://github.com/ensdomains/contracts-v2) at the commit the docs pin for Sepolia ([`07e55a0`](https://github.com/ensdomains/contracts-v2/tree/07e55a056f5b6a9c90119f501bdd05714e67dddd)), and live Sepolia RPC calls / an anvil fork I ran on 2026-11-06.
Tags: **[DOC]** read in docs, **[CODE]** read in contract source, **[CHAIN]** read from live Sepolia, **[FORK]** executed on an anvil fork of Sepolia (my own test; scripts not committed), **UNVERIFIED** = not confirmed.

## TL;DR: what palmfi should do

1. **ENSv2 is live on Sepolia** (and deployed-but-not-launched on mainnet). Use Sepolia. brief.md "runs on mainnet and Sepolia" is only half true: mainnet resolution/registration still goes through ENSv1 until launch ([Deployments](https://docs.ens.domains/learn/deployments)).
2. **We do NOT own palmfi.eth on Sepolia.** ENSv2 `ETHRegistry.getState(palmfi)` = AVAILABLE, and v1 shows no owner [CHAIN]. Register it first: commit/reveal on `ETHRegistrar` paying 8 MockUSDC/yr (MockUSDC has a public `mint`) [CHAIN][FORK]. Do this today (section 6).
3. Architecture: deploy a **UserRegistry proxy** (via VerifiableFactory), attach it with `ETHRegistry.setSubregistry(palmfi, userRegistry)`, grant **PalmFactory** `ROLE_REGISTRAR | ROLE_UNREGISTER` on the registry's ROOT_RESOURCE. Factory registers `nvidia`/`alice` with **roleBitmap = 0** => token is non-transferable [FORK]; factory `unregister`s to revoke [FORK].
4. Records live in **one shared PermissionedResolver** proxy. Per-key EAC works: grant `ROLE_SET_TEXT` scoped to key `status` to Hub only; grant `verified`/`type`/`tokens` keys + `ROLE_SET_ADDRESS` to Factory only. Hub setting `verified` or `addr` reverts [FORK].
5. **Per-name scoping does NOT exist.** Per-key grants apply to every name on that resolver [DOC][FORK]. So do NOT give owners a `url`/`avatar` key role on the shared resolver (alice could overwrite bob's url; I reproduced it). Route owner edits through a Factory function `setProfile(label,key,value)` that checks `msg.sender == owner` and only allows `url`/`avatar`.
6. **Revocation gotcha:** if palmfi.eth's own resolver points at the shared resolver, a revoked `nvidia.palmfi.eth` still resolves (wildcard fallback to the parent's resolver, old records intact) [FORK]. Keep palmfi.eth's resolver unset/empty, and on revoke also write `status=revoked` + clear addr.
7. **Token owner must accept ERC1155** if it is a contract (or an EIP-7702-delegated EOA): mint reverts `ERC1155InvalidReceiver` otherwise [FORK]. Make the token owner the PalmFactory (inherit `ERC1155Holder`) and keep `controller[label]` in the factory, or use the user's plain EOA.
8. Frontend/app reads: plain `viem` `getEnsAddress` / `getEnsText` on the `sepolia` chain; no ENS addresses needed (UR proxy `0xeEeE...EeEe` is baked into viem) [DOC][CHAIN]. Tested with viem 2.57.16 against v2-native names [CHAIN]. Contracts (PaymentRouter) cannot call the Universal Resolver cheaply for `status`; read the shared resolver's text directly (section 5.3).
9. Avoid hard-coding ENS addresses (prize rule): ENS **redeployed Sepolia once already (2026-06-29 -> 2026-10-01)**. Discover at runtime: `UR proxy.ROOT_REGISTRY()` -> `RootRegistry.getSubregistry("eth")` -> registries.
10. Unknowns to test before demo: the Hub `status` write from a contract (EAC checks `msg.sender`, so fine in principle; I tested with an EOA stand-in), and `unsafeTransfer` path (read, not run).

---

## 1. Architecture

- **Hierarchical registries.** Each name can have its own registry (subregistry pointer) and a resolver; name owners deploy their own subregistry on demand; registries/resolvers are proxies from the Verifiable Factory ([Overview](https://docs.ens.domains/ensv2/overview), [Registry Hierarchy](https://docs.ens.domains/ensv2/registry-hierarchy)) [DOC].
- **PermissionedRegistry** = tokenized registry; every name is an ERC1155Singleton token with exactly one owner; all permissions via EAC; replaces v1 Registry + BaseRegistrar + NameWrapper ([Permissioned Registry](https://docs.ens.domains/ensv2/permissioned-registry)) [DOC]. Entry fields: `eacVersionId`, `tokenVersionId`, `subregistry`, `expiry`, `resolver`. Lifecycle AVAILABLE / RESERVED / REGISTERED.
- **UserRegistry** = derived UUPS proxy for user/subname registries; `initialize(Grant[] grants)` grants root roles; upgrade gated by `ROLE_UPGRADE` ([Registry Template](https://docs.ens.domains/ensv2/registry-template), [source](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/src/registry/UserRegistry.sol)) [DOC][CODE].
- **Attach a subregistry:** the parent name's owner calls `setSubregistry(anyId, registry)` on the registry holding the parent (needs `ROLE_SET_SUBREGISTRY`, which `.eth` owners get at registration). Until then, subnames mint tokens but never resolve ([For Contract Developers](https://docs.ens.domains/ensv2/tutorial-contract-developers)) [DOC]. Reproduced on fork [FORK].
- **Can our factory *be* the subregistry?** Yes. Minimum to take part in resolution is `IRegistry` (`getSubregistry`, `getResolver`, `getParent`); the Universal Resolver only needs these ([Registry Template](https://docs.ens.domains/ensv2/registry-template#registry-interface-hierarchy)) [DOC]. Two options:
  - **A (recommended): UserRegistry + factory as registrar.** Factory is granted `ROLE_REGISTRAR` (+`ROLE_UNREGISTER`) on the registry ROOT_RESOURCE. This is the documented "registrar" pattern, keeps ERC1155 tokens, EAC and indexer compatibility ([tutorial](https://docs.ens.domains/ensv2/tutorial-contract-developers), [Issuing Subnames](https://docs.ens.domains/ensv2/subnames)) [DOC][FORK].
  - **B: custom `IRegistry` contract** (the factory itself). Less code to reason about but no tokens/EAC on names; weaker for the "EAC central" prize story. Not tested.
  - **C (no registry at all):** set a shared PermissionedResolver on palmfi.eth and write records for full names (wildcard) ([Issuing Subnames](https://docs.ens.domains/ensv2/subnames#subnames-as-resolver-records)) [DOC]. No tokens, nothing to revoke except records. Rejected: cannot express "non-transferable revocable" as ENS objects.
- **Verifiable Factory** (separate from our PalmFactory): `deployProxy(impl, salt, data)`; salt mixes `msg.sender`; emits `ProxyDeployed(sender, proxy, salt, impl)` ([Verifiable Factory](https://docs.ens.domains/ensv2/verifiable-factory), [repo](https://github.com/ensdomains/verifiable-factory)) [DOC][FORK].

## 2. Enhanced Access Control (EAC)

Source: [EAC doc](https://docs.ens.domains/ensv2/enhanced-access-control) [DOC].

- **Resource** = any `uint256` the contract defines. `ROOT_RESOURCE = 0` is the master key: a role on root applies to every resource. Checks look at the specific resource and root.
- **Roles** = bitmap: 32 regular (low 128 bits) + 32 admin (`role << 128`), 1 nybble each; max **15 holders** per role per resource.
- **Admin role** needed to grant/revoke its regular role (and itself). `grantRoles/revokeRoles` reject ROOT_RESOURCE; use `grantRootRoles/revokeRootRoles`. Hooks: `_getRoles`, `_onRolesGranted`, `_getSettableRoles`, etc.
- **Revoking replaces fuse burning.** Revoke role + its admin = permanent lock.
- **Per-key scoping: YES, on the resolver (not the registry).** PermissionedResolver defines its resources from the setter argument: text/data key -> `keccak256(bytes(key))`, coin type -> `keccak256(abi.encode(v))`, interface id etc. A `ROLE_SET_TEXT` granted on resource `keccak256("status")` only allows `setText(..., "status", ...)`. Root `ROLE_SET_TEXT` allows all keys ([Permissioned Resolver: EAC](https://docs.ens.domains/ensv2/permissioned-resolver#eac-integration), source `setText` uses `onlyRoles(resource(key), ROLE_SET_TEXT)`: [PermissionedResolver.sol L221-223](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/src/resolver/PermissionedResolver.sol#L221-L223)) [DOC][CODE].
- **Per-NAME scoping: NO.** Docs state it plainly: "There is no per-name scoping: a role holder can write the covered records on every name served by the resolver instance"; the supported workaround is a **separate resolver instance per group of names** ([doc](https://docs.ens.domains/ensv2/permissioned-resolver#eac-integration), [Limit a Writer to a Group of Names](https://docs.ens.domains/ensv2/subnames#limit-a-writer-to-a-group-of-names)) [DOC]. I reproduced it: alice with a `url`-key role overwrote `bob.palmfi.eth`'s `url` [FORK].
- **Closest to palmfi's matrix:**

| Actor | Grant | Verified result |
|---|---|---|
| Hub | `grantSetterRoles(setText(_, "status", _), hub)` only | sets `status` OK; `verified` and `setAddress` revert `EACUnauthorizedAccountRoles` (0x4b27a133) [FORK] |
| PalmFactory | per-key `type`,`verified`,`tokens`,`status` + root `ROLE_SET_ADDRESS (1<<0)` | all OK [FORK] |
| Owners | **no role**; edits via Factory `setProfile` (checks owner, whitelists `url`/`avatar`) | owner direct `setText` reverts [FORK] |

  Giving the factory per-key (not root) `ROLE_SET_TEXT` means it cannot touch unlisted keys. Nobody else holds `verified` => "only the factory sets verified" holds on-chain.
- **Granting per key:** `grantSetterRoles(bytes setter, address account)`; `setter` = ABI calldata of the setter (only selector + key matter); caller needs the admin role for that resource (a root admin works, I did it from the init-granted account) [CODE L254-262][FORK]. `grantRoles()` on the resolver always reverts `EACCannotGrantRoles` [DOC][CODE L297].
- **Revoking per key:** `revokeRoles(resource, ROLE_SET_TEXT, account)` with `resource = uint256(keccak256(bytes(key)))`; root roles via `revokeRootRoles` ([doc example](https://docs.ens.domains/ensv2/permissioned-resolver#revoking-permissions)) [DOC]. Not run by me.
- **Resolver init:** `initialize(Grant[] grants, bytes[] calls)` grants *root* roles only (to whoever you pass); `calls` multicall runs with role checks skipped ([doc](https://docs.ens.domains/ensv2/permissioned-resolver#eac-integration)) [DOC]. So: init with deployer holding ALL (`0x1111...1111`), have deployer do the per-key grants, then revoke deployer's root roles (keep or hand `ROLE_UPGRADE`/admins to a multisig).
- **Security note:** whoever holds root `ROLE_UPGRADE` on the resolver/registry proxy can swap the implementation and bypass everything. Decide who holds it (ideally revoke + admin, like the lock example) [DOC].

## 3. Resolvers

- **PermissionedResolver**: one UUPS proxy per account by default; shared records via numbered "records" and links; setters take **DNS-encoded name bytes**, not node ([doc](https://docs.ens.domains/ensv2/permissioned-resolver)) [DOC]. Setters: `setAddress(bytes name,uint256 coinType,bytes addr)` (60 = ETH), `setText(bytes name,string key,string value)`, etc. Reads go through `resolve(name,data)` via UR; there are no standalone `text()` getters ("the contract has no standalone getters for record values") [DOC]. See 5.3 for the contract-read consequence.
- **Records and unlinked names:** a name with no record falls back to the "default record" (root name `0x00`). Once a name has its own record, missing keys do NOT fall back ([doc](https://docs.ens.domains/ensv2/permissioned-resolver#the-default-record)) [DOC]. Relevant: set `status` etc. explicitly on every name.
- **Custom resolver is allowed** (`setResolver` takes any address; interface unchanged) ([Verifiable Factory intro](https://docs.ens.domains/ensv2/verifiable-factory), [Overview](https://docs.ens.domains/ensv2/overview)) [DOC]. Fallback plan if per-name EAC is required: our own thin resolver; not needed for the matrix above.
- **Resolver for a subname**: set via `register(..., resolver, ...)` on the UserRegistry. If a subname has none, the nearest ancestor's resolver serves it ([For App Developers](https://docs.ens.domains/ensv2/tutorial-app-developers#resolving-names)) [DOC] (the revocation gotcha, see TL;DR 6) [FORK].

## 4. Non-transferable, revocable subnames

- **Transfer rule:** a token transfer needs `ROLE_CAN_TRANSFER_ADMIN` on the *current owner's name-specific resource*; holding it on root does not enable transfers ([doc](https://docs.ens.domains/ensv2/permissioned-registry#transfers), [source `_update`](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/src/registry/PermissionedRegistry.sol#L517-L545)) [DOC][CODE]. Also `ROLE_CAN_TRANSFER_ADMIN` has no non-admin variant and is not grantable after registration (admin roles on names only at registration) [DOC].
- **How:** register with `roleBitmap = 0` (or without `ROLE_CAN_TRANSFER_ADMIN`). Note the stock ETHRegistrar *hardcodes* a bitmap that includes it ([source L18-23](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/src/registrar/ETHRegistrar.sol#L18-L23)), but our registrar is our own contract, so we choose. Owner register with `roleBitmap=0` is accepted [FORK].
- **Fork results** (owner alice, registry root roles held by factory only): `safeTransferFrom` reverts `TransferUnsafeUntilRegistryIsEmancipated` (because factory holds `ROLE_UNREGISTER` on root, so registry is not emancipated); owner `unregister` and `setResolver` revert `EACUnauthorizedAccountRoles` [FORK]. The `unsafeTransfer` path is gated by the same `ROLE_CAN_TRANSFER_ADMIN` check in `_update` (read in code, not executed) [CODE].
- **Revocable:** factory holds `ROLE_UNREGISTER` on root; `unregister(anyId)` burns the token and sets expiry to now (AVAILABLE). Afterwards `getEnsResolver(nvidia.palmfi.eth)` = 0x0 and address/text resolve to null [FORK].
- **Trade-off (from docs):** factory root roles (`UNREGISTER`, `SET_RESOLVER`, ...) are "dangerous" => registry is *not* emancipated; owners must trust palmfi. That is exactly the managed pattern we want ([Registry Template: Fully Controlled](https://docs.ens.domains/ensv2/registry-template#fully-controlled-managed)) [DOC].
- **Gotchas:**
  - `mint` to a contract (or an EIP-7702-delegated EOA, e.g. the well-known anvil key `0xf39F...2266` has `0xef0100...` code on Sepolia) calls the ERC1155 receiver hook; without it the registration reverts `ERC1155InvalidReceiver` [FORK][CHAIN]. Vault clones as token owner need `onERC1155Received`.
  - Token IDs are **mutable** (change on role changes / re-registration); key everything on labelhash ([Mutable Token IDs](https://docs.ens.domains/ensv2/mutable-token-ids)) [DOC]. After `unregister`, label is AVAILABLE again; only holders of `ROLE_REGISTRAR` (factory) can re-register. For fraud, consider reserving rather than leaving available (register with owner = 0 creates RESERVED, needs `ROLE_REGISTER_RESERVED` to promote) [DOC].
  - Expiry is mandatory (absolute unix timestamp). Docs suggest `type(uint64).max` for permanent claims ([tutorial Next Steps](https://docs.ens.domains/ensv2/tutorial-contract-developers#next-steps)); I used ~1 year [FORK]. UR walk fails if a parent expires ([UR v2](https://docs.ens.domains/ensv2/universal-resolver-v2)) [DOC], so renew palmfi.eth (28-day min, 28-day grace) or register for several years.

## 5. Is ENSv2 live on Sepolia? Addresses and resolution

### 5.1 Status
- ENS App and Explorer entered public Beta on **Ethereum Sepolia** on 2026-08-12 ([ENS blog](https://ens.domains/blog/post/ensv2-beta-public-testing)) [DOC]. Docs: "Sepolia runs the ENSv2 contracts: the Universal Resolver and the ENS apps for Sepolia resolve through this deployment"; legacy v1 Sepolia contracts "still exist but are no longer in use" ([Deployments](https://docs.ens.domains/learn/deployments)) [DOC].
- Mainnet: contracts deployed (manifest 2026-10-26), "Until the launch completes, resolution and registrations on Mainnet continue through the ENSv1 contracts" [DOC]. **No Namechain/L2 in the current design**: hierarchy lives on L1; L2 only appears as reverse-registrar/CCIP partners [DOC]. UNVERIFIED: mainnet launch date.
- Confirmed on-chain: Sepolia UR proxy `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`; `ROOT_REGISTRY()` returns `0xB458d6a3a77919449d03e7A6903C26827c1eC43f`, which equals the docs-listed set below [CHAIN]. Real users registered v2 names (`blaze.eth`, `catcat.eth`) and viem resolves them [CHAIN].

### 5.2 Sepolia addresses (docs set, deployed 2026-10-01)
Official list the docs build from: [`contracts/docs/addresses/sepolia.md` @ pinned commit](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/docs/addresses/sepolia.md) (docs pin: [`scripts/ensv2-deployments.ts`](https://github.com/ensdomains/docs/blob/main/scripts/ensv2-deployments.ts)).

| Contract | Address |
|---|---|
| UpgradableUniversalResolverProxy (use this) | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` |
| UniversalResolverV2 (impl) | `0x24e1d8e068620b647ca097f961a61055f4f42d72` |
| RootRegistry | `0xb458d6a3a77919449d03e7a6903c26827c1ec43f` |
| ETHRegistry | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4` |
| ETHRegistrar | `0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3` |
| StandardRentPriceOracle | `0x8196665d4ca7488b6474a9ec8e7d2719fb42263a` |
| VerifiableFactory | `0xda70306c98e97ece36f997a21368e53298572991` |
| PermissionedResolverImpl | `0x115eb53f0c60696633855f90b138178fb40b2b2c` |
| UserRegistryImpl | `0x9bd8a88719068d09ecee662f36c0e3856708366a` |
| MockUSDC (6 dec, public `mint`) | `0x240b0316df57887dbbe58b586508b19e633a14aa` |
| MockDAI | `0xf6fac8a58a0be13b9197f27c41b73162fe32572b` |

**Doc/code disagreement:** `contracts/deployments/sepolia/` and `docs/addresses/sepolia.md` on contracts-v2 `main` list an **older** set (deployed 2026-06-29, e.g. ETHRegistry `0x67b7...`), and there is an archived `sepolia-official-v1-20260525-r2` set. Only the 2026-10-01 set is wired to the live UR proxy [CHAIN]. Do not copy addresses from `main`'s `deployments/sepolia`. The docs' `<ENSv2Deployments>` table is rendered client-side from the pinned commit, so I took addresses from the pinned file, not the HTML. Re-check before the demo, since ENS can redeploy again.

### 5.3 Reading from apps and contracts
- **viem/ENSjs/ethers:** just select the Sepolia chain; libraries ship the UR proxy address; "Do not hardcode a Universal Resolver address" ([For App Developers](https://docs.ens.domains/ensv2/tutorial-app-developers#project-setup)) [DOC]. Minimum versions: viem >= 2.35.0, ethers >= 6.17.0, ENSjs >= 4.2.3 ([readiness](https://docs.ens.domains/web/ensv2-readiness)); ENSjs >= 5.2.5 for `@ensdomains/ensjs/wallet/v2` write helpers [DOC]. viem's sepolia chain def has `ensUniversalResolver = 0xeeeeeeee14d718c2b47d9923deab1335e144eeee` ([source](https://github.com/wevm/viem/blob/main/src/chains/definitions/sepolia.ts)) [CODE]. I ran viem 2.57.16 `getEnsAddress/getEnsText` on my fork for `nvidia.palmfi.eth` => vault address, `status`, `verified`, `type` all correct [FORK].
- Readiness page suggests testing with `ur.integration-tests.eth` (expect `0x2222...`); on Sepolia viem returned `0x1111...` which the page says means "old library". I believe that name is mainnet-specific, but UNVERIFIED. Real v2-only names resolved fine, so I treat it as a non-issue.
- **On-chain read (PaymentRouter must refuse non-`active` names):** UR is the intended entry point (`resolve(name,data)`; supports CCIP-Read, which a contract can't do). For palmfi's own names there is no offchain data, so the router can instead call the **shared resolver directly** with `resolve(dnsName, abi.encodeCall(ITextResolver.text,(node,"status")))` (the resolver "has no standalone getters", you must call `resolve`) [DOC][CODE]. Alternative that avoids ENS reads on-chain entirely: also keep `status` in the Hub/Factory storage and treat ENS as the public mirror. UNVERIFIED: gas and exact return encoding of resolver `resolve` (not run).
- **Event/indexing:** registry events `LabelRegistered`, `LabelUnregistered`, `ResolverUpdated`; resolver `Linked`, `ResourceArgument`; EAC `EACRolesChanged` ([Indexing](https://docs.ens.domains/ensv2/indexing)) [DOC].

## 6. Registering palmfi.eth on Sepolia (v2 registrar flow)

Facts [CHAIN]: `ETHRegistry.getState(keccak("palmfi"))` status 0 (AVAILABLE); v1 Sepolia BaseRegistrar has no owner; `ETHRegistrar.getRegisterPrice("palmfi",1y,MockUSDC) = (8000021, 0)` (~8 USDC, premium 0); `MIN_COMMITMENT_AGE=60s`, `MAX=86400s`, `MIN_REGISTER_DURATION=2419200 (28d)`. `isAvailable` true. Anyone may `mint` MockUSDC (eth_call from a random address succeeded).

Flow ([ETH Registrar doc](https://docs.ens.domains/ensv2/eth-registrar#registering-a-name), [source](https://github.com/ensdomains/contracts-v2/blob/07e55a056f5b6a9c90119f501bdd05714e67dddd/contracts/src/registrar/ETHRegistrar.sol#L123-L135)); signatures match doc and code (no disagreement):
1. `MockUSDC.mint(owner, 100e6)`; `approve(ETHRegistrar, total)`.
2. `makeCommitment(label, owner, secret, subregistry, resolver, duration, referrer)` -> `commit(hash)`; wait >= 60 s.
3. `register(label, owner, secret, subregistry, resolver, duration, paymentToken, referrer)`.
Executed end to end on the fork => owner holds `palmfi.eth`, token owner roles = registration bitmap (set subregistry/resolver + admin, transfer admin) [FORK]. Alternative: UI at [sepolia.app.ens.domains](https://sepolia.app.ens.domains) (docs link) [DOC]; UNVERIFIED that the UI offers v2 registration with Mock USDC for a brand-new name.
**Owner must be a plain EOA (no code, no 7702 delegation) or ERC1155Receiver**; use a fresh deployer key.
**Using a different parent if registration is blocked:** register any other label (e.g. `palmfi-demo.eth`); everything below is parent-agnostic. Brief's "we own palmfi.eth" claim needs correcting (§11, §15 gotcha 29).

## 7. Code

### 7.1 Setup scripts (viem) after owning palmfi.eth
```ts
import { createWalletClient, createPublicClient, http, parseAbi, encodeAbiParameters, encodeFunctionData,
  keccak256, toHex, stringToHex, parseEventLogs } from 'viem'
import { sepolia } from 'viem/chains'
import { packetToBytes, normalize } from 'viem/ens'

const ALL = 0x1111111111111111111111111111111111111111111111111111111111111111n
const ROLE_REGISTRAR = 1n << 0n, ROLE_UNREGISTER = 1n << 12n, ROLE_SET_RESOLVER = 1n << 24n
const ROLE_SET_ADDRESS = 1n << 0n   // resolver role bits (resolver lib), distinct numbering from registry

const vfAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)'])
// 1. UserRegistry proxy; deployer gets ALL roles incl. admins (required to grant later)  [doc: verifiable-factory]
const regInit = encodeFunctionData({ abi: parseAbi(['function initialize((address account,uint256 roleBitmap)[] grants)']),
  functionName: 'initialize', args: [[{ account: deployer, roleBitmap: ALL }]] })
// -> deployProxy(USER_REGISTRY_IMPL, salt, regInit); read ProxyDeployed.proxyAddress

// 2. attach to palmfi.eth (deployer owns it; has ROLE_SET_SUBREGISTRY)  [doc: tutorial-contract-developers]
await wallet.writeContract({ address: ETH_REGISTRY, abi: parseAbi(['function setSubregistry(uint256 anyId,address sub)']),
  functionName: 'setSubregistry', args: [BigInt(keccak256(toHex('palmfi'))), userRegistry] })

// 3. let PalmFactory register/revoke  [doc: tutorial; ROLE_UNREGISTER added by us, tested on fork]
await wallet.writeContract({ address: userRegistry, abi: parseAbi(['function grantRootRoles(uint256,address) returns (bool)']),
  functionName: 'grantRootRoles', args: [ROLE_REGISTRAR | ROLE_UNREGISTER, palmFactory] })

// 4. shared PermissionedResolver proxy (init grants deployer ALL)  [doc: permissioned-resolver]
// 5. per-key grants (only selector + key matter in `setter`)
const setterFor = (key: string) => encodeFunctionData({
  abi: parseAbi(['function setText(bytes name,string key,string value)']), functionName: 'setText', args: ['0x', key, ''] })
for (const key of ['type', 'verified', 'tokens', 'status', 'url', 'avatar'] ) // factory-only keys; url/avatar written via factory.setProfile
  await wallet.writeContract({ address: resolver, abi: resolverAbi, functionName: 'grantSetterRoles', args: [setterFor(key), palmFactory] })
await wallet.writeContract({ address: resolver, abi: resolverAbi, functionName: 'grantSetterRoles', args: [setterFor('status'), HUB] }) // Hub: status only
await wallet.writeContract({ address: resolver, abi: resolverAbi, functionName: 'grantRootRoles', args: [ROLE_SET_ADDRESS, palmFactory] })
// then deployer revokes its own root roles / hands ROLE_UPGRADE(+admin) to a multisig or locks it
```
Revoke Hub per key: `resolver.revokeRoles(BigInt(keccak256(toHex('status'))), 1n<<4n, HUB)` [doc example].

### 7.2 PalmFactory (Solidity sketch, mirrors the doc tutorial and my fork test)
Imports per the doc tutorial (`forge install ensdomains/contracts-v2`, remap `@ensdomains/contracts-v2/=lib/contracts-v2/contracts/src/`).
```solidity
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IPermissionedRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import {IRegistry} from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";

interface IPR { // resolver setters, DNS-encoded name
  function setAddress(bytes calldata name, uint256 coinType, bytes calldata a) external;
  function setText(bytes calldata name, string calldata key, string calldata value) external;
}
contract PalmFactory is ERC1155Holder {
  IPermissionedRegistry public immutable REG; IPR public immutable RES; uint64 constant FOREVER = type(uint64).max;
  mapping(bytes32 => address) public controller; // labelhash => owner/vault controller
  function _mintName(string calldata label, bytes calldata dnsName, address ctrl, address vault, string calldata typ, bool verified) internal {
    // roleBitmap 0 => owner has no roles => non-transferable, owner cannot change resolver/unregister  [fork-tested]
    REG.register(label, address(this), IRegistry(address(0)), address(RES), 0, FOREVER);
    controller[keccak256(bytes(label))] = ctrl;
    RES.setAddress(dnsName, 60, abi.encodePacked(vault));
    RES.setText(dnsName, "type", typ); RES.setText(dnsName, "status", "active");
    RES.setText(dnsName, "verified", verified ? "true" : "false");
  }
  function setProfile(string calldata label, bytes calldata dnsName, string calldata key, string calldata v) external {
    require(controller[keccak256(bytes(label))] == msg.sender, "owner");
    require(_isProfileKey(key), "key");   // only "url","avatar" ...
    RES.setText(dnsName, key, v);
  }
  function revoke(string calldata label, bytes calldata dnsName) external /*onlyGov*/ {
    RES.setText(dnsName, "status", "revoked"); RES.setAddress(dnsName, 60, "");
    REG.unregister(uint256(keccak256(bytes(label))));
  }
}
```
If instead the token owner is the user EOA, drop `ERC1155Holder`/`controller` and read `REG.ownerOf`. Note `REG.register` expiry: using `type(uint64).max` is the documented option; I tested ~1 year (the fork test didn't use max) UNVERIFIED for max.
(Also note: Factory is `msg.sender` for the resolver and registry calls, so those roles must be granted to the Factory *contract*; the Hub must call `RES.setText(dnsName,"status",...)` itself; its role is per key `status`.)

### 7.3 Reading (viem)
```ts
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
const c = createPublicClient({ chain: sepolia, transport: http(RPC) })
const name = normalize('nvidia.palmfi.eth')
const vault  = await c.getEnsAddress({ name })
const status = await c.getEnsText({ name, key: 'status' })    // 'active' | 'frozen' | 'migrated' | 'revoked'
const verified = await c.getEnsText({ name, key: 'verified' })
```
Writing via viem directly to the resolver needs the DNS-encoded name: `toHex(packetToBytes(name))` ([doc](https://docs.ens.domains/ensv2/permissioned-resolver#setting-and-reading-records)) [DOC][FORK].

### 7.4 Runtime address discovery (no hard-coded ENS addresses)
```ts
const UR = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe'   // canonical proxy, same all networks  [DOC]
const root = await c.readContract({ address: UR, abi: parseAbi(['function ROOT_REGISTRY() view returns (address)']), functionName: 'ROOT_REGISTRY' })
const ethRegistry = await c.readContract({ address: root, abi: parseAbi(['function getSubregistry(string) view returns (address)']), functionName: 'getSubregistry', args: ['eth'] })
```
`ROOT_REGISTRY()` and `getSubregistry(string)` worked on Sepolia [CHAIN]. Implementation addresses (resolver impl, user-registry impl, VerifiableFactory) are only in the deployments list; read from there at deploy time into an env/config, not code.

## 8. Differences from brief.md assumptions
| brief.md | Reality |
|---|---|
| "ENSv2 runs on mainnet and Sepolia" | Sepolia live; mainnet contracts deployed but v1 still serves until launch [DOC] |
| "we own palmfi.eth" | Not on Sepolia v2 (AVAILABLE) nor v1; must register (~8 MockUSDC) [CHAIN] |
| "Permissioned resolver with EAC; Hub edits only `status`" | Works via per-key role (verified) [FORK] |
| "owners edit only their own profile fields" | **Not possible on-chain per name** with a shared resolver; use factory-mediated `setProfile`, or a resolver instance per name (cost: deploy+grants per user) [DOC][FORK] |
| "names resolve like any ENS name from apps" | Yes with viem >= 2.35; tested [CHAIN][FORK] |
| "revocable on fraud" | `unregister` works; avoid parent-resolver fallback (TL;DR 6) [FORK] |

## 9. Open risks
- ENS may redeploy Sepolia again (already did once, 2026-06-29 -> 2026-10-01); registered `palmfi.eth` would then vanish. Mitigation: register + record all addresses today; keep a deploy script that reruns end to end (steps 6-7.1); take demo video early.
- Sepolia RPC / UR availability and the public RPC load-balancing quirks (contracts-v2 PR #460 notes "load-balanced RPC can answer gas estimate from a node that has not..." [commit message](https://github.com/ensdomains/contracts-v2/commit/07e55a056f5b6a9c90119f501bdd05714e67dddd)): add gas margins.
- Resolver `resolve()` read from the PaymentRouter on-chain is untested (gas, encoding). Fallback: mirror `status` in the Hub.
- Factory/resolver `ROLE_UPGRADE` holder can bypass all guarantees; decide and document.
- ERC1155 receiver requirement if a vault contract is the token owner.
- Docs claim "ENSv2 beta"; behaviors may change before mainnet launch; the grant/ABI shapes above were verified against the pinned commit only (contracts-v2 main moved on 2026-11-05).
- My fork tests used an EOA as the Hub/Factory stand-in; contract callers behave the same under EAC (checks `msg.sender`) but not executed. `unsafeTransfer`, per-key `revokeRoles`, `type(uint64).max` expiry not executed.
