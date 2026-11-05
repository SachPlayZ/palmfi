# TJAR + Chainlink Data Feeds on Ethereum Sepolia

Researched 2026-11-06. Sepolia on-chain facts were read live via `cast` against `https://ethereum-sepolia-rpc.publicnode.com` (marked "on-chain check"). Anything not confirmed is marked UNVERIFIED.

## TL;DR: what palmfi should do

1. TJAR is NOT on Sepolia. `Factory` (`0xfAc70EEE...9fee`) and `FeeController` (`0xfEeC0FEE...9EF8`) have empty code on Sepolia (on-chain check). Deploy both from `Uniswap/tjar` with `script/Deploy.s.sol` ([repo](https://github.com/Uniswap/tjar), [script](https://github.com/Uniswap/tjar/blob/main/script/Deploy.s.sol)).
2. Edit `INITIAL_OPS_OWNER` in `Deploy.s.sol` to our own EOA before deploying. Otherwise Uniswap's ops EOA owns our FeeController and could set a fee up to 10% (source: [Deploy.s.sol](https://github.com/Uniswap/tjar/blob/main/script/Deploy.s.sol), [FeeController.sol](https://github.com/Uniswap/tjar/blob/main/src/FeeController.sol)). Changing it changes the addresses, which is fine on a testnet.
3. Create the jar with one call: `factory.deploy(USDC, safetyFund, threshold, owner, configSetter, salt)` ([Factory.sol](https://github.com/Uniswap/tjar/blob/main/src/Factory.sol)).
4. To lock terms permanently pass `owner = 0x000...dEaD` and `configSetter = address(0)`. The README calls this "trustless from birth" ([README](https://github.com/Uniswap/tjar/blob/main/README.md)). Cost: the threshold can never be retuned. Use `owner = 0xdead` plus a live setter if you want to freeze wiring but keep the threshold tunable.
5. Pick the threshold once, in USDC base units (6 decimals). Pick it knowing the demo jar contents, so the demo searcher has a profit.
6. Demo searcher script: fund it with Circle test USDC, call `releaseCost()`, `approve(releaser, total)`, then `release(nonce(), assets[], recipient, maxFee)`. Native ETH is `address(0)` in `assets`. All of this is from the [searcher guide](http://developers.uniswap.org/llms.mdx/docs/protocols/tjar/guides/search-token-jars).
7. Chainlink Sepolia feeds that exist: ETH/USD, BTC/USD, LINK/USD, USDC/USD, DAI/USD, EUR/USD (plus others). There is NO UNI/USD feed (checked against the Chainlink feed directory JSON, 61 entries, no "UNI"). Do not list UNI as priced.
8. Staleness: hard-code a per-feed max age in the vault. Use 3600 s for ETH, BTC and LINK. Use 86400 s for USDC, DAI and EUR. Read `decimals()` (it is 8 for all of them). Do not use an L2 sequencer check (Ethereum L1 is not a listed sequencer network).
9. Crash demo: deploy Chainlink's `MockV3Aggregator(8, price)` and point the vault's ETH feed slot at it in demo mode. It implements `AggregatorV3Interface`. Call `updateAnswer()` to crash the price. Label it "DEMO MODE" in the UI.
10. USDC on Sepolia: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (Circle docs). WETH9: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` (on-chain check; its Uniswap docs listing is UNVERIFIED). A contract with symbol "UNI" exists at the mainnet UNI address on Sepolia, but it is not confirmed as an official Uniswap deployment (UNVERIFIED).

---

## A. Uniswap TJAR

Repo HEAD read: `f7642c685c051badf3056c4d7e9ed4777222e1d9` ([Uniswap/tjar](https://github.com/Uniswap/tjar)). Solidity `0.8.29`, EVM `cancun`, optimizer 10,000,000 runs ([foundry.toml](https://github.com/Uniswap/tjar/blob/main/foundry.toml)).

### A1. Contracts and constructor args

| Contract | Constructor | Notes | Source |
|---|---|---|---|
| `TokenJar` | none. Deployer becomes `Owned` owner. | Holds assets. Only `releaser` may call `release(Currency[] assets, address recipient)`. Sends the FULL balance of each listed asset. `receive()` accepts ETH. `nonReentrant`. | [TokenJar.sol](https://github.com/Uniswap/tjar/blob/main/src/TokenJar.sol) |
| `ExchangeReleaser` | `(address _resource, uint256 _threshold, address _tokenJar, address _recipient, address _feeController)`. Owner = `msg.sender`. | The concrete releaser. `resource` is the payout token. `_recipient` is the resource recipient. Defaults: `maxReleaseLength = 20`, `configSetter = 0`. | [ExchangeReleaser.sol](https://github.com/Uniswap/tjar/blob/main/src/releasers/ExchangeReleaser.sol), [ResourceManager.sol](https://github.com/Uniswap/tjar/blob/main/src/base/ResourceManager.sol) |
| `FeeController` | `(address _owner)`. Reverts on zero owner. | Per-chain singleton. `feeBps` starts at 0. `MAX_FEE_BPS = 1000` (10%). A non-zero fee needs `feeRecipient` set. | [FeeController.sol](https://github.com/Uniswap/tjar/blob/main/src/FeeController.sol) |
| `Factory` | `(address _feeController)`. Must have code. | `deploy(revenueToken, revenueRecipient, threshold, owner, configSetter, salt)` returns `(jar, releaser)`. It sets the releaser on the jar and transfers ownership of both contracts to `owner`. It keeps no residual authority and no registry. | [Factory.sol](https://github.com/Uniswap/tjar/blob/main/src/Factory.sol) |

Mapping to palmfi: `revenueToken` = USDC, `revenueRecipient` = SafetyFund, `threshold` = USDC amount in 6-decimal units.

### A2. Roles and how terms are set/changed

- `TokenJar.owner` can call `setReleaser(addr)`. Zero address is rejected. Only the owner can do this, and it is the system's trust anchor ([TokenJar.sol](https://github.com/Uniswap/tjar/blob/main/src/TokenJar.sol)).
- `ExchangeReleaser.owner` and `configSetter` can both call `setConfig(resource, resourceRecipient, threshold, maxReleaseLength)`. This is the only way to change payout token, destination and threshold, and there are no per-field setters ([ResourceManager.sol](https://github.com/Uniswap/tjar/blob/main/src/base/ResourceManager.sol)).
- `setConfig` always bumps the nonce, even for a no-op set. This invalidates pending searcher txs.
- Only the releaser `owner` can call `setConfigSetter`. Changing the setter does not bump the nonce.
- `setConfig` rejects: zero or codeless resource, zero recipient, zero threshold, zero max length. The ExchangeReleaser also rejects a recipient equal to the jar or to the releaser itself.
- The blog says the owner or a delegated config setter can change token, threshold and destination, and that controls can be "relinquished entirely" ([How TJAR Works](https://blog.uniswap.org/how-tjar-works-uniswaps-onchain-fee-conversion-system)). The blog does not describe the mechanism; the repo README does.

### A3. Locking terms permanently

- Mechanism: solmate `Owned.transferOwnership` has no zero-address check, and the constructor sets `owner = _owner` directly ([solmate Owned.sol](https://raw.githubusercontent.com/transmissions11/solmate/main/src/auth/Owned.sol)). There is no `renounceOwnership`. TJAR's recommended way is the burn address `0xdead`.
- One-transaction lock via Factory: `factory.deploy(..., owner = 0xdead, configSetter = address(0), ...)`. README: "No key ever holds power over the pair, and nothing — recipient, threshold, or the jar↔releaser wiring — can ever change" ([README, burn configurations](https://github.com/Uniswap/tjar/blob/main/README.md)).
- Factory rejects only `owner == address(0)`; `0xdead` is accepted ([Factory.sol](https://github.com/Uniswap/tjar/blob/main/src/Factory.sol)).
- Intermediate option: `owner = 0xdead` with a live `configSetter` freezes roles and wiring but terms stay tunable by that fixed address.
- Not immutable at the code level. The README says the jar/releaser are "owner-controlled", so locking is entirely an ownership choice. Locking BOTH contracts is required: the Factory path does both in one tx.
- Trade-off: a frozen threshold. The README says releases become over- or under-priced forever if the price drifts.
- Liveness caveat: Factory-made releasers read `FeeController.feeConfig()` on every release. If the FeeController owner (us, on Sepolia, if we deploy it) set a bad fee recipient, releases could revert. With fee 0 and nobody touching it, this is a non-issue. Consider also locking our own FeeController by `transferOwnership(0xdead)` after deployment (the README warns `transferOwnership` is single-step and unrecoverable).

### A4. Release flow (what a searcher does)

From the [searcher guide](http://developers.uniswap.org/llms.mdx/docs/protocols/tjar/guides/search-token-jars) and [ExchangeReleaser.sol](https://github.com/Uniswap/tjar/blob/main/src/releasers/ExchangeReleaser.sol):

1. `releaser.releaseCost()` returns `(total, fee)` where `total = threshold + fee` and `fee = threshold * feeBps / 10000`.
2. `resource.approve(releaser, total)`. This is the only approval. The releaser pulls with `safeTransferFrom`: `threshold` to `resourceRecipient`, then `fee` to the fee recipient if non-zero.
3. `releaser.release(uint256 nonce, Currency[] assets, address recipient, uint256 maxFee)`. `nonce` must equal `releaser.nonce()`. `recipient` (the searcher) cannot be zero. `assets.length <= maxReleaseLength` (default 20). `maxFee` is an upper bound on the protocol fee.
4. The releaser calls `TOKEN_JAR.release(assets, recipient)`, which sends the FULL balance of each listed asset (native = `address(0)`, ERC-20 = token address) to the searcher.
- It only sweeps the tokens the searcher lists. The price is fixed regardless of how many assets are listed.
- Gotchas from the guide: listing a non-zero address with no code reverts the whole release. A token that reverts on `transfer` or `balanceOf` reverts the whole release. Native transfers emit no logs. A rotated-out releaser reverts with `Unauthorized`.
- A fee-on-transfer resource makes the recipient receive less than nominal. Not relevant for USDC.
- Events: `Released(nonce, recipient, resource, resourceRecipient, threshold, fee, feeRecipient, assets)`.
- Revert table (`InvalidNonce`, `Unauthorized`, `TooManyAssets`, `FeeExceedsMax`, `InvalidRecipient`, `TRANSFER_FROM_FAILED`) is in the searcher guide.

### A5. Deploy script, deps, Sepolia how-to

- Script: `script/Deploy.s.sol`. It deploys `FeeController(INITIAL_OPS_OWNER)` then `Factory(feeController)` through the canonical CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` with fixed salts. It is idempotent ([Deploy.s.sol](https://github.com/Uniswap/tjar/blob/main/script/Deploy.s.sol)). The CREATE2 deployer has code on Sepolia (on-chain check).
- Usage: `forge script script/Deploy.s.sol --rpc-url <sepolia> --broadcast --verify` ([script header](https://github.com/Uniswap/tjar/blob/main/script/Deploy.s.sol)). Add `--private-key` or an account flag.
- Deps (git submodules, installed by `forge install`): `forge-std`, `solmate`, `v4-core` ([.gitmodules](https://github.com/Uniswap/tjar/blob/main/.gitmodules), [README](https://github.com/Uniswap/tjar/blob/main/README.md)). Note: `v4-core` is used for the `Currency` type. A shallow clone did not pull submodules; run `git submodule update --init --recursive` or `forge install`.
- Compiler: solc 0.8.29, `evm_version = "cancun"`. Sepolia supports Cancun (transient-storage `ReentrancyGuard` needs EIP-1153). I did not test a Sepolia deployment. UNVERIFIED on-chain.
- Sepolia recipe:
  1. Clone and `forge install`.
  2. Edit `INITIAL_OPS_OWNER` to our deployer EOA.
  3. Run the deploy script. Salts stay the same; the owner constant changes the FeeController initcode, so the addresses differ from mainnet's.
  4. The script prints both addresses.
  5. Call `factory.deploy(...)` from our deployer EOA.
  6. Use `factory.predictJar(deployer, salt)` to know the jar address before deploying. The README warns: deploy the jar BEFORE sending funds to it, and deploy from an EOA.
  7. Optionally call `feeController.transferOwnership(0xdead)`.
- Alternative: skip the Factory and deploy `TokenJar`, `ExchangeReleaser`, `FeeController` manually. More calls, no benefit.
- Audits are in the repo `audit/` (Cantina, OpenZeppelin). Not reviewed here.

### A6. Official deployment chains

- Official list: Ethereum (1), Optimism (10), BNB Chain (56), Polygon (137), Base (8453), Arbitrum (42161), Robinhood Chain (4663). The page says Sepolia is not included and lists no testnets (confirmed by the fetch summary) ([Deployments](http://developers.uniswap.org/llms.mdx/docs/protocols/tjar/deployments)). Factory `0xfAc70EEEE259F2140CBbB8e3157b75A52ce39fee`, FeeController `0xfEeC0FEE579Be52a5409cd75a42bCc9E6b149EF8`.
- On-chain check: `eth_getCode` for both addresses on Sepolia returns `0x`. Not deployed there. Safe to say "not on Sepolia".

### A7. Gotchas for palmfi

- Posted price, no oracle. Searcher profit = jar value minus threshold minus gas. Big deposits make it very profitable for the searcher; tiny deposits mean nobody releases. For the demo, our script is the searcher ([blog](https://blog.uniswap.org/how-tjar-works-uniswaps-onchain-fee-conversion-system)).
- The searcher needs the resource token (USDC) in hand. On Sepolia, USDC comes from Circle's faucet. The faucet URL is not on the Circle contract-address page I read; check [Circle's testnet faucet](https://faucet.circle.com) (UNVERIFIED).
- `maxReleaseLength` defaults to 20. List all the fee tokens (palmfi PaymentRouter fee tokens + ETH) in one call.
- Don't set the recipient to the jar (the contract blocks it: otherwise a searcher could list USDC as an asset and reclaim the payment). SafetyFund must be a different address.
- If the SafetyFund contract rejects USDC transfers or reverts, releases fail. Test with a plain address first.
- The `resource` token must be non-upgradeable and un-blacklistable ideally. Circle USDC is upgradeable and blacklistable ([README: prefer immutable resources](https://github.com/Uniswap/tjar/blob/main/README.md)). Acceptable on a testnet; say so.
- Locking with `0xdead` is irreversible. Do a dry-run deploy first with a non-locked owner, and run the end-to-end release before the locked deploy. Redeploy from scratch if wrong (fresh salt).
- Blog line used in the brief ("terms can be changed later or locked permanently") is also repeated by [The Block](https://theblock.co/news/defi/2026-10-29-uniswap-token-jar-tjar-robinhood-432131) (secondary source; the repo is primary).
- The brief (§10) says the Releaser owner "can change payout token, threshold and destination". Confirmed correct. The brief also says the jar owner can swap the releaser (`setReleaser`); this adds a second path, so lock both.

---

## B. Chainlink Data Feeds on Ethereum Sepolia

Feed list source: Chainlink's public feed directory JSON `https://reference-data-directory.vercel.app/feeds-ethereum-testnet-sepolia.json` (the data behind the docs [price feed addresses page](https://docs.chain.link/data-feeds/price-feeds/addresses); the docs table renders in-browser and I could not scrape it, so the JSON is the source). Cross-checked with `cast call` on each proxy (decimals, description, `latestRoundData`).

### B1. Relevant Sepolia feeds

| Pair | Proxy address | Decimals | Heartbeat | Deviation | Last update age at check |
|---|---|---|---|---|---|
| ETH / USD | `0x694AA1769357215DE4FAC081bf1f309aDC325306` | 8 | 3600 s | 1% | ~288 s |
| BTC / USD | `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` | 8 | 3600 s | 1% | ~3048 s |
| LINK / USD | `0xc59E3633BAAC79493d908e63626716e204A45EdF` | 8 | 3600 s | 1% | ~48 s |
| USDC / USD | `0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E` | 8 | 86400 s | 1% | ~50,340 s (14 h) |
| DAI / USD | `0x14866185B1962B63C3Ea9E03Bc1da838bab34C19` | 8 | 86400 s | 1% | ~6,840 s |
| EUR / USD | `0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910` | 8 | 86400 s | 0.5% | ~78,828 s (21.9 h) |

Notes:
- Heartbeat and deviation come from the directory JSON (`heartbeat`, `threshold` fields). Decimals and description were confirmed on-chain; ages are from the on-chain `updatedAt` vs local time at check (2026-11-06).
- The docs example uses BTC/USD `0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43` on Sepolia ([Using Data Feeds](https://docs.chain.link/data-feeds/using-data-feeds)).
- Warning: the JSON also contains several entries with `docs.hidden = true` for the same pairs (other ETH/USD, BTC/USD, LINK/USD addresses, e.g. ETH/USD `0xD9d6f482B88C43B256fD481826890dffC8544B13`). Use the addresses in the table above, not the hidden ones.
- EUR/USD sat at ~22 h of a 24 h heartbeat at check time: a 24 h staleness limit would trip soon, and it may genuinely flip stale during the demo. Same risk, smaller, for USDC/USD. Do the staleness check, but don't build the demo on EUR/USD.
- Other Sepolia entries exist (stETH/USD-style, GBP/USD, JPY/USD, XAU/USD, PYUSD/USD, USDG/USD, GHO/USD, SNX/USD and more) in the directory JSON. Not needed.
- No UNI/USD feed and no WETH/USD feed: grep for "UNI" and "WETH" in the 61-entry directory JSON found nothing. Price WETH with ETH/USD (ETH/USD feed is for ETH; WETH is 1:1 wrapped). UNI is not priceable via Chainlink on Sepolia.
- The 61 entries include non-price feeds (NAV, Proof of Reserves, realized volatility). Filter by the exact pair names above.

### B2. AggregatorV3Interface usage

Interface (from [chainlink-evm `AggregatorV3Interface.sol`](https://github.com/smartcontractkit/chainlink-evm/blob/develop/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol), HEAD `982da1fb36c737664187c787fe5bfcba19d651a7`):
```solidity
function decimals() external view returns (uint8);
function description() external view returns (string memory);
function version() external view returns (uint256);
function getRoundData(uint80 _roundId) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
```
- `latestRoundData` returns five values ([Using Data Feeds](https://docs.chain.link/data-feeds/using-data-feeds)). `answer` is `int256`: check `answer > 0`. `updatedAt` is the timestamp used for staleness.
- Per-feed staleness: `require(block.timestamp - updatedAt <= maxAge[feed])`, with `maxAge` set per feed from its heartbeat (plus a small grace). The brief's §7 wants this. A single global value would be wrong because heartbeats differ (3600 vs 86400 above).
- `decimals()`: all six feeds above are 8, but read it from the feed ([brief §7](/Users/sachplayz/Projects/palmfi/brief.md)). Normalise USD values to a common precision (e.g. 18).
- `answeredInRound`: legacy sanity check (`answeredInRound >= roundId`). On the live Sepolia proxies, `roundId == answeredInRound` (on-chain check; round ids are phase-encoded and huge, about 1.84e19). The current docs example ignores it and the mock returns `roundId` for both. Treat it as optional/legacy; the `updatedAt` age check is what matters. This is my reading; Chainlink docs don't state it as deprecated in what I read (UNVERIFIED).
- L2 sequencer uptime check: needed only on L2s. The [L2 Sequencer Uptime Feeds page](https://docs.chain.link/data-feeds/l2-sequencer-feeds) lists Arbitrum, Base, Celo, Mantle, MegaETH, Metis, OP, Scroll, Soneium, X Layer, ZKsync. Ethereum is not on it, so none is needed on Sepolia L1. (There is a "L2 Sequencer Uptime Status Feed" entry in the Sepolia JSON; flagged hidden. Ignore.)

### B3. Mock aggregator for the crash demo

- Location: `contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol` in [smartcontractkit/chainlink-evm](https://github.com/smartcontractkit/chainlink-evm/blob/develop/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol). The old path `contracts/src/v0.8/tests/MockV3Aggregator.sol` in `smartcontractkit/chainlink` returned 404 on `develop`. The npm package `@chainlink/contracts` also ships it (the Chainlink [docs sample](https://github.com/smartcontractkit/documentation) imports `@chainlink/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol`); I did not inspect the npm tarball (UNVERIFIED for the installed version). Also available in [chainlink-local](https://github.com/smartcontractkit/chainlink-local/blob/main/src/data-feeds/MockV3Aggregator.sol).
- Interface parity: `MockV3Aggregator is AggregatorV2V3Interface` (V3 plus the older `latestAnswer`, `latestTimestamp`, etc.), so it has all five AggregatorV3 functions.
- Constructor: `(uint8 _decimals, int256 _initialAnswer)`. Use `8` and `ETH * 1e8`.
- Crash: `updateAnswer(int256)` sets the answer and `updatedAt = block.timestamp`. `updateRoundData(roundId, answer, timestamp, startedAt)` lets you set an old timestamp to simulate a stale feed.
- Mock differences to remember: `description()` returns the string "v0.8/tests/MockV3Aggregator.sol", `version()` is 0, `answeredInRound == roundId`, and `updateAnswer` is permissionless (anyone can call it). On Sepolia, anyone can crash the demo price, so only point the vault at it in an explicit demo mode. Label it in the UI.
- Round ids are small (1, 2, ...) unlike the real phase-encoded ids. Don't assume large ids.

### B4. Tokens on Sepolia

- USDC (Circle): `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` ([Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses)). On-chain check: symbol "USDC", 6 decimals, name "USDC".
- WETH9: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`. On-chain check: symbol "WETH", 18 decimals. I did not find this address on an official Uniswap docs page in this session (UNVERIFIED as "the official" WETH). Confirm via the [Uniswap v4 deployments page](https://developers.uniswap.org/docs/protocols/v4/deployments) / v3 deployments before using it in pool keys.
- UNI: code exists at `0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984` on Sepolia (same address as the mainnet UNI), symbol "UNI", 18 decimals (on-chain check). Whether it is the official Uniswap-controlled test token, and whether it has testnet supply/minting, is UNVERIFIED. No Chainlink UNI/USD feed exists on Sepolia anyway.
- For reference, Uniswap v4 on Sepolia (11155111), from the [v4 deployments page](https://developers.uniswap.org/docs/protocols/v4/deployments): PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, Universal Router `0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b` (2.1.2: `0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3`), PositionManager `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4`, Quoter `0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244`, StateView `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Not requested, but relevant to brief §9.

### B5. Feed-hygiene best practices (Chainlink docs)

From [Selecting Quality Data Feeds](https://docs.chain.link/data-feeds/selecting-data-feeds):
- Chainlink recommends circuit breakers: "monitor data feeds for unexpected scenarios such as stale prices, drastic price changes, or prices approaching a predetermined min/max threshold" and pause contract functionality.
- Contract update delays: don't update until a recent, fresh input arrives.
- Manual kill switch, own monitoring alerts on deviations, and soak testing before securing value.
- Single-source and high-risk feeds need value bounds, caps, freshness checks, fallback and pause behaviour.
- Stablecoins: assess upside risk and set an explicit valuation ceiling per stablecoin; don't assume $1. (The page's stablecoin section was only partly captured; the ceiling recommendation is from the table-of-contents and the heading text. Treat details as partly UNVERIFIED.)
- Market hours: crypto feeds are 24/7; equity-like feeds have market hours, so avoid forex feeds like EUR/USD outside market hours (the page lists market-hours categories; it recommends using feeds only during their specified hours).
- Network congestion can reduce update frequency; apps should detect and handle it.
- Apply these for palmfi: per-feed `maxAge`, `answer > 0`, bounds/ceiling for stablecoins (e.g. USDC between 0.95 and 1.05 else degraded), vault-side enforcement independent of CRE, and a degraded mode on stale/deviation.
- Deprecation: feeds can be wound down under the Data Feed Shutdown Policy. For Sepolia/testnet feeds, availability is not guaranteed; re-check the proxy addresses the morning of the demo.

---

## Open risks / UNVERIFIED summary

- Sepolia deploy of TJAR not executed here; only code reading + empty-code checks. `forge build` with submodules not run.
- Chainlink docs address table could not be scraped (the page is client-rendered); the feed list is from Chainlink's directory JSON. Verify the six proxies on [docs.chain.link](https://docs.chain.link/data-feeds/price-feeds/addresses) (Sepolia tab) in a browser.
- Real feed freshness at demo time: EUR/USD and USDC/USD can be near their 24 h heartbeats (1 h feeds are fine).
- Official-ness of Sepolia WETH9 and UNI is UNVERIFIED.
- Circle USDC faucet URL/limits UNVERIFIED.
- `MockV3Aggregator` npm path for the installed `@chainlink/contracts` version UNVERIFIED (repo path confirmed).
- Locking TJAR with `0xdead` is irreversible; dry-run first.
