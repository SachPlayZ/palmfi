# palmfi build flow (Matt Pocock skills)

Copy-paste prompts, in order. `/x` = type it yourself. Most of these skills are `disable-model-invocation`: the agent **won't** start them on its own, so they need the slash command.
Model-invoked (agent pulls them in on its own): `tdd`, `code-review`, `domain-modeling`, `codebase-design`, `pr`, `wizard`, `diagnosing-bugs`, `verify-*`, `solidity`.

Not sure which skill to use? `/ask-matt <situation>`.

---

## 0. Precondition (done)

`/setup-matt-pocock-skills`: GitHub tracker `SachPlayZ/palmfi`, default triage labels, single-context docs.

Optional one-time hardening:
```
/git-guardrails-claude-code
```
```
/setup-pre-commit
```

---

## 1. Research (background, parallel)

Kick these off first so the reading runs while you grill. Each one leaves a cited `.md` file in the repo.

```
/research CRE TS SDK: EVM log trigger, cron trigger, HTTP trigger, Confidential HTTP, onReport/ReceiverTemplate consumer contracts, KeystoneForwarder on Ethereum Sepolia, `cre workflow simulate --limits default`. Save to docs/research/cre.md
```
```
/research Uniswap v4 custom-curve hooks: LitePSM aggregator hook pattern, beforeSwap return-delta, HookMiner, beforeInitialize pool-key restriction, Universal Router v4 commands, PoolManager + UR addresses on Sepolia. Save to docs/research/uniswap-v4.md
```
```
/research ENSv2 on Sepolia: Permissioned Registry, Enhanced Access Control roles, subname issuance under palmfi.eth, text records, contract addresses. Save to docs/research/ensv2.md
```
```
/research Uniswap/tjar repo: TokenJar + Releaser deploy, threshold/recipient config, locking terms. Plus Chainlink Data Feeds available on Ethereum Sepolia with heartbeats/decimals. Save to docs/research/tjar-feeds.md
```

---

## 2. Grill the idea (one unbroken context through step 4)

Interview that leaves `GLOSSARY.md` + ADRs behind as it goes.

```
/grill-with-docs Read brief.md. We have until the Nov 7 ETHGlobal Mumbai deadline. Grill me on scope cuts first (must/should/stretch in §16.2), then the vault state machine (§6.3 queued-lane resolution table), CRE report authenticity (§8.4), the hook budget-sharing (§9.1), and the ENS status flow (§11). Pull in docs/research/*.md where it exists. Record terms (Vault, Instant lane, Queued lane, Floor, Hard cap, Verdict, Reason code, Safe-harbor swap, Market mode, Recovery vault) in GLOSSARY.md and hard-to-reverse calls (immutable clones, burn-and-mint settlement, FLAG-beats-CLEAR, fail-open vs fail-closed) as ADRs.
```

If an answer only shows up in running code, take the prototype detour:
```
/handoff prototype question: <e.g. does the queued-request state machine (CLEAR/HOLD/FLAG × second factor × CRE silent) hold up as code?>
```
→ new session in the prototype dir:
```
/prototype <same question>. Throwaway Foundry test harness, state model only.
```
```
/handoff back: what the prototype answered
```
→ back in the main thread: "Read <handoff file> and fold it in."

**Too foggy to grill in one session?** Use this instead of step 2, then rejoin at step 3:
```
/wayfinder Destination: a buildable spec for palmfi per brief.md, cut to fit the hackathon deadline.
```

---

## 3. Spec

```
/to-spec
```
Confirm the test seams it proposes. Suggested seams for palmfi:
- Contracts: the `Vault` external interface through the `Hub` (Foundry tests + invariant tests per §6.7)
- Hook: a swap through `PoolManager` against a factory-created pool key
- CRE: `cre workflow simulate` fixtures, one per failure-matrix row (§8.5)
- Frontend: ENS name → vault resolution plus the tx flows

---

## 4. Tickets

```
/to-tickets
```
Tracer-bullet slices with native GitHub blocking links. Suggested skeleton for the first bullet: factory onboard → vault deposit → instant-lane unwrap within budget → ENS name resolves. Everything else hangs off that.

> Clear or compact only **after** this step.

---

## 5. Build

**Option A: orchestrated, parallel (best for the deadline)**
```
/implement-spec <spec issue URL>
```
Runs implementer subagents across the ready frontier, each in its own worktree, all landing on one integration branch, then runs one `/code-review` at the end.

**Option B: one ticket per fresh context**
```
/implement #<ticket>
```
then `/clear`, then the next unblocked ticket. Each ticket runs `tdd` → `code-review` → commit.

Prompts that keep the domain skills involved during the build:
```
Use the solidity skill for every contract. Run verify-contracts before marking any contract ticket done: forge build, forge test, invariant tests from §6.7.
```
```
Frontend ticket: use frontend-ux for wallet/tx states and verify-frontend before done. Resolve names via ENS; nothing hard-coded (ENS prize rule).
```

Standalone, without a spec:
```
/tdd <behaviour>, e.g. "FLAG after CLEAR leaves the vault frozen"
```

---

## 6. On-ramps during the build

Something broken:
```
/diagnosing-bugs <symptom + repro command>
```
Issues you didn't write yourself (teammates, judges, bug reports). Never use this on `/to-tickets` output:
```
/triage
```
Steps only a human can do (Sepolia keys, CRE login, ENS parent ownership, Vercel):
```
/wizard set up .env + GitHub secrets: SEPOLIA_RPC_URL, DEPLOYER_PK, ETHERSCAN_KEY, CRE credentials, palmfi.eth owner
```
Didn't follow the agent's last message:
```
/wait-what
```

---

## 7. Review and ship

```
/code-review main
```
```
/thermo-nuclear-code-quality-review
```
(optional, harsh)

Creating a PR applies `pr` automatically. Then:
```
/loop 10m /babysit-pr
```

Submission artifacts (§16.4):
```
/create-readme Include setup, architecture diagram, Sepolia addresses, and pointers to exact contracts/lines for each prize (Uniswap, ENS, Chainlink CRE).
```
```
Write FEEDBACK.md for the Uniswap prize: honest dev feedback from building the VaultHook, Universal Router routes, and TJAR on Sepolia.
```

---

## 8. Close the loop

Run this in the session it reviews, before clearing:
```
/retro
```

Upkeep, between features:
```
/improve-codebase-architecture
```

---

## Phase-boundary cheat sheet

| Situation | Do |
|---|---|
| Next step needs this context | Continue |
| Nothing here matters next | `/clear` |
| New directory, harness or colleague | `/handoff` |
| Tight side task | subagent |
| Window near ~150k before `/to-tickets` | `/compact` at the nearest boundary |
