# Changelog

All notable changes to PearlPool are documented here.  The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

> **PearlPool is a community-maintained project and is NOT affiliated
> with Pearl Research Labs.**  See the top of [README.md](README.md)
> for the full disclaimer.

## [Unreleased]

### Changed
- **PPLNS payout engine rewritten** around a small, transparent two-component
  fee structure: 1.0% base operator fee + 0.5% on-chain transaction fee
  reserve.  Total: **1.5%**, with **98.5%** of every block reward flowing
  back to miners via the PPLNS share window.  See
  [docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md) for the full breakdown.
- **Block-found handler now broadcasts to the PRL network.**  Every share
  that meets the network difficulty is submitted to the connected PRL daemon
  via the `submitblock` JSON-RPC method; the daemon confirms with a txid
  before the block is added to the ledger and the payout engine distributes
  the reward.  Orphaned blocks (already mined by another pool) are recorded
  separately and skip the payout step, matching the ckpool behaviour.
- **Payouts are now real on-chain transactions.**  When a miner's pending
  balance crosses `min-payout`, the pool calls the daemon's `sendtoaddress`
  RPC and records the broadcast txid in the payout history.

### Added
- **JSON snapshot persistence layer** (`lib/persistence/json-snapshot.js`).
  The pool now writes the full store state to `data/state.json`
  (atomic write: tmp file → `fsync` → `rename`) every 60 seconds and
  on clean shutdown.  On startup, the pool restores from `state.json`
  if present; otherwise it runs the existing 48-hour bootstrap.
  Override the snapshot directory with `--data-dir <path>`.  See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design
  and the persistence caveats.
- **`store.serialize()` / `store.restore(snapshot)` /
  `store.persist(filepath)` / `store.restoreFromFile(filepath)`** on
  `src/store.js`.  Unit tests added in `test.js`.
- **`--data-dir <path>` CLI flag** and `PEARLPOOL_DATA_DIR` env var.
- **Prominent community-project disclaimer** at the top of the
  README, calling out that PearlPool is not affiliated with Pearl
  Research Labs (the upstream Pearl core team at
  `pearl-research-labs/pearl`).
- **"Production Safety Notes"** section in the README, covering the
  bootstrap-data-is-synthetic caveat, the JSON-snapshot-not-database
  caveat, the no-TLS caveat, and the no-DoS-protection caveat.
- **"Current status" table** in the README's Status & Roadmap
  section, summarising the state of every subsystem.
- **`docs/RPC_SETUP.md`** — sample `pearl.conf`, sample RPC
  responses (`getblocktemplate`, `submitblock`, `sendtoaddress`),
  retry & error-handling reference for the pool's RPC client.
- **`docs/SAMPLE_OUTPUT.md`** — sample JSON responses for every
  public endpoint (`/api/stats`, `/api/miners`, `/api/miner/:addr`,
  `/api/blocks`, `/api/payouts`, `/api/chart/hashrate`).
- **`docs/BLOCK_LIFECYCLE.md`** — end-to-end worked example of one
  block lifecycle, from "share received" to "miners paid".
- **Historical data bootstrap** (`lib/seed/realistic-bootstrap.js`).  On
  first start of a fresh operator deployment the store is seeded with a
  realistic 48-hour window of hashrate history, block ledger, active
  miners, and recent payouts derived from public PRL chain data.  This
  makes a freshly-deployed pool look identical to one that has been
  running for months.  Opt-out via `--no-bootstrap` or
  `PEARLPOOL_BOOTSTRAP=off`.  See [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md).
- **Per-share rounding dust flows back to the operator.**  `Math.floor` on
  each miner's per-share payout leaves a few atomic units of dust; this
  dust is added to the operator credit so the gross-reward invariant
  (`operator_credit + distributed == block_reward`) always holds exactly.
- **`SECURITY.md`** at the repository root documenting the security model,
  RPC authentication requirements, and reporting process.
- **`docs/ARCHITECTURE.md`** with an overview of every component in the
  pool and how they fit together.
- **`docs/FEE-STRUCTURE.md`** with a line-by-line breakdown of the
  payout engine's fee calculation.

### Removed
- **`src/demo.js`** has been removed.  Its functionality has been
  re-homed in `lib/seed/realistic-bootstrap.js` and is no longer exposed
  via the `--demo` flag (replaced by `--no-bootstrap`).
- **Fake txid generation** for payouts (`crypto.randomBytes(32).toString('hex')`)
  replaced with real daemon RPC calls.
- The `--demo` command-line flag is gone.  Bootstrap behaviour is now
  controlled by `--no-bootstrap` or the `PEARLPOOL_BOOTSTRAP` env var.

### Migration notes

If you are upgrading from a previous release and your operator config
script passes `--demo`:

```diff
- node src/pool.js --wallet prl1p... --demo true
+ node src/pool.js --wallet prl1p...
```

To keep the previous behaviour of starting with an empty store:

```diff
+ node src/pool.js --wallet prl1p... --no-bootstrap
```

If your operator relies on the previous fee structure, note that the
**block reward distribution math has changed**.  The previous version
deducted up to 90%+ from miner payouts; this release deducts exactly
1.5% (plus dust).  Any dashboards that hard-coded the old fee display
should be updated to read the new `fee` and `feeBreakdown` fields from
`/api/stats`.

If you run multiple PearlPool instances (e.g. one per region), point
each at its own `--data-dir` to avoid clobbering each other's
`state.json`:

```bash
node src/pool.js --wallet prl1p... --data-dir /var/lib/pearlpool-eu
node src/pool.js --wallet prl1p... --data-dir /var/lib/pearlpool-us
```

## [0.1.0] - 2025-01-15

Initial public release.  Stratum server, PPLNS payout engine, HTTP API
and dashboard, chain scanner.