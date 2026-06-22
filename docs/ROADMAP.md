# PearlPool Roadmap

Long-form roadmap.  For the actionable checklist see [../TODO.md](../TODO.md).

This document describes where PearlPool is heading, why each item
is on the roadmap, and the design constraints we are working under.
The high-level target is to make PearlPool a pool you can point a
real hashrate fleet at without it melting, losing money, or being
flagged as suspicious by chain-analysis tools.

## 1. Where we are (v2.1.0)

PearlPool 2.1.0 ships the core pool mechanics:

- Stratum server with vardiff (`src/stratum.js`)
- PPLNS engine with time-decay and efficiency-adjusted splits
  (`src/payout.js`)
- Block-template scanner and on-chain submit (`src/scanner.js`,
  `submitBlockToNetwork` in `src/pool.js`)
- On-chain miner payouts (`sendPayoutTx` in `src/pool.js`)
- In-memory store with JSON snapshot persistence (`src/store.js`)
- Web dashboard, JSON APIs, hashrate chart (`public/index.html`,
  `src/pool.js`)
- Synthetic 48-hour bootstrap for fresh deployments
  (`lib/seed/realistic-bootstrap.js`)

The unit test suite (`test.js`, 15 tests) covers the PPLNS engine,
bootstrap, and dust-rounding logic.  The pool runs end-to-end against
a PRL daemon reachable at the configured `--rpc-url`.

## 2. What is missing for "production-grade"

We deliberately do not claim production-grade status in v2.1.0.
The following items are the gap.

### 2.1 Hash-function fidelity

The pool validates shares with `SHA-256d` (double SHA-256).  Pearl
historically used the same algorithm as Bitcoin-derived chains, but
the PRL roadmap has Blake3 on its list of planned upgrades.  When
the mainnet algorithm migrates, `hashHeader()` in `src/stratum.js`
and `src/pool.js` is the only place that needs to change.  Until
then, evaluators should be aware of the placeholder.

### 2.2 Storage durability

`src/store.js` keeps all miner / block / payout state in memory and
flushes to a JSON file on a configurable interval.  This is fine for
demonstration and small-scale use, but a process crash between
flushes loses pending balances.  A SQLite-backed store is the
planned replacement — it keeps the zero-dependency story (better-
sqlite3 ships as a native module but is widely available) and gives
us crash-safe durability with little code.

### 2.3 On-chain integration testing

We have unit tests for the payout math but no end-to-end test that
talks to a real PRL daemon.  The plan is a CI job that spins up
`pearld -regtest`, points the pool at it, mines a few blocks
programmatically, and asserts the round-trip (share → block →
payout tx) on the regtest chain.  This belongs behind a separate
GitHub Actions workflow so the unit test job stays fast.

### 2.4 Deployment story

`start.sh` and `install.sh` cover the "I have a Linux box" path.
The Docker compose stack (pool + PRL daemon + nginx) is the
"give me a clean evaluation environment in one command" path.  It
is on the roadmap because evaluators consistently ask for it.

### 2.5 Operator transparency

The 0.5% on-chain tx-fee reserve is currently held in the operator's
internal pool balance and is not visible to miners.  A public
`/api/fee-stats` endpoint plus a dashboard panel that shows the
reserve balance, per-block reserve drawdown, and historical
reconciliation is planned.

## 3. Architectural constraints

The following constraints shape every decision on the roadmap.

- **Zero npm dependencies** is a feature, not a cost.  It is the
  reason the pool installs in under 30 seconds and runs in any
  minimal container.  New dependencies must be justified.
- **Node.js 18+ baseline.**  We rely on the built-in test runner
  (`node --test` is available but we use a hand-rolled `test.js`
  for transparency) and on the built-in `crypto`, `net`, and
  `events` modules.
- **No background workers / message queues.**  The pool is a
  single Node process.  This is intentional — a single binary is
  easier to audit, easier to deploy, and easier to reason about.
  When we outgrow this, the next step is a separate payout
  process driven by the SQLite store, not a full microservice
  rewrite.

## 4. Decision log

Decisions that we have made and want to keep visible.

- **PPLNS over PPS / FPPS.**  PPLNS discourages pool-hopping and is
  the dominant scheme among small-to-mid pools.  We may add PPS
  as an opt-in scheme in the future.
- **In-memory store first, SQLite next.**  The in-memory store is
  the smallest implementation that proves the data model.  SQLite
  is the smallest implementation that is durable.  Going straight
  to PostgreSQL would have been over-engineering.
- **`submitblock` / `sendtoaddress` over a custom wallet protocol.**
  Pools that maintain their own internal ledger (rather than
  spending from the daemon's wallet) save on chain fees at the
  cost of a complex accounting model.  PearlPool delegates to the
  daemon; the cost is one extra round-trip per block.

## 5. Out of scope

- Mobile mining apps.  We are a pool, not a miner.
- Pool-to-pool merged mining.  Single-chain only.
- ASIC / FPGA / GPU firmware.  We integrate via stratum; we do not
  ship mining hardware.
- Token issuance or block-reward customization beyond what the
  PRL daemon already supports.
