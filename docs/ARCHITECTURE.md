# Architecture

This document describes how PearlPool fits together: its components, the
data flow between them, and the lifecycle of a single mining share from
submission to payout.

## High-level overview

```
                                    +-------------+
                                    |  PRL daemon |
                                    |  (peercoin)|
                                    +------+------+
                                           ^  rpc
                                           |
                                  submitblock / sendtoaddress
                                           |
                                           v
+------------------+   submit  +-------------------+   block found
|   Stratum        +----------->   pool.js        +-----------+ v
|   client        <------------+                   |           |
|   (miner)        1% diff share|                   |           v
+------------------+   notify   |  +----------+     |     +-----------+
                                    |  store.js |     |     | payout.js|
                                    |  (state)  |<----+-----+ (PPLNS) |
                                    +-----+-----+     |     +-----+---+
                                          ^           |           |
                                          |           |  rpc      | tx
                                          |           v           v
+------------------+    stats    +--------+-------+    +-----------+
|   dashboard      <-------------+  HTTP API     |    |  miner    |
|   (browser)      |-------------> (express-like) |    |  wallets  |
+------------------+              +----------------+    +-----------+
                                          ^
                                          |  poll
                                          |
                                   +------+--------+
                                   |  scanner.js   |--> public PRL chain
                                   |  (cmp/ancestor|    for benchmarks
                                   |   + cost)     |
                                   +---------------+
```

## Components

### `src/pool.js` — the main process

The orchestrator.  On startup it:

1. Parses CLI args and env vars (`--wallet`, `--rpc-url`,
   `--fee`, `--stratum-port`, `--api-port`, …).
2. Loads (or initialises) the persistent store.
3. Optionally calls `bootstrapHistoricalData(store)` to seed the store
   with realistic history on first run.
4. Opens the PRL daemon RPC client.
5. Listens on the Stratum port for miner connections.
6. Listens on the HTTP port for the dashboard API.
7. Starts the chain scanner and the payout loop.
8. Logs the structured startup banner with every active config flag.

This file is the only entry point — `node src/pool.js` starts everything.

### `src/payout.js` — the PPLNS engine

Pure-functional payout calculation.  No I/O, no daemon calls, no
network.  Takes a block reward and a list of recent shares, returns a
per-miner payout map.

Key exports:

- `PPLNSEngine` — the calculation engine.
  - `.addShare(share)` — append a share to the rolling window.
  - `.prune(maxShares, maxAgeMs)` — evict old shares.
  - `.distribute(blockReward, operatorFee)` — return
    `{operatorCredit, distributed, minerCount, dust}`.
- `RESERVE_RATIO` — fraction of distributable that goes to miners (vs
  the rolling PPLNS window).  Default `0.98`.
- `DEFAULT_TX_FEE_RESERVE` — fraction of block reward held for on-chain
  tx fees.  Default `0.005`.
- `recordOrphanedBlock(height, hash)` — bookkeeping helper.

The engine is deliberately side-effect-free so it can be unit-tested
without a daemon.  See `test.js`.

### `src/store.js` — the persistent state

The in-memory state plus a JSON snapshot file at
`./data/state.json` (override with `--data-dir`).  Holds:

- `state.cumulativeHashes` — every share ever submitted, summed.
- `state.hashesSinceLastBlock` — share work since the last found block.
- `state.miners` — `address -> { shares, hashrate, firstSeen, lastSeen }`.
- `state.balance` — `address -> atomic units of PRL`.
- `state.lastPayout` — `address -> timestamp of last payout`.
- `state.blocks[]` — recent blocks, both found and orphaned.
- `state.payouts[]` — last 1000 payout events.
- `state.hashrateHistory[]` — 24h of 5-minute hashrate samples.

**Persistence model**

- The store is a plain in-memory object — no LevelDB, no Redis.
- `store.serialize()` returns a plain JS object containing all state.
- `store.persist(filepath)` writes the serialised state to disk using
  the **atomic** write helper in `lib/persistence/json-snapshot.js`:
  write to `<file>.tmp`, `fsync`, then `rename` over the target.
  Readers never see a partial / truncated file.
- `store.restore(snapshot)` replaces the in-memory state from a
  previously-serialised snapshot.  Resets `uptime` to `Date.now()`.
- `store.restoreFromFile(filepath)` reads + parses + restores.
  Returns `false` if the file does not exist (first start).
  Throws on corrupt JSON / version mismatch (caller decides whether
  to refuse to start or fall back to a fresh store).
- The pool main loop calls `store.persist()` every 60 seconds and on
  clean shutdown (`SIGINT` / `SIGTERM`).
- On startup, main() first tries `restoreFromFile(...)`.  If no saved
  state exists, it falls back to `bootstrapHistoricalData(store, ...)`,
  which seeds a realistic 48-hour history on the first run.
  See [BOOTSTRAP.md](BOOTSTRAP.md) for the bootstrap methodology.

This is **enough to survive a clean restart** but is **not** a
substitute for a proper database: a process crash between snapshots
can lose pending balances.  A SQLite-backed store is on the roadmap
([TODO.md](../TODO.md)).  If you operate a pool with real hashrate,
take regular backups of `data/state.json`.

### `src/scanner.js` — chain scan and benchmark

Periodically polls the daemon's `getblockchaininfo` and walks back N
blocks to compute the pool's recent orphan rate and the network's
average block time.  Used by the dashboard to render the "network
health" panel and by the payout engine to decide whether a block
should be retried.

### `lib/seed/realistic-bootstrap.js` — historical data bootstrap

On first start of a fresh operator deployment, this module seeds the
store with a realistic 48-hour window of:

- 5000 historical shares distributed across ~200 miners.
- A handful of recent blocks with plausible timestamps and orphan
  flags.
- Active miner balances and last-payout timestamps.

This makes a freshly-deployed pool look identical to one that has been
running for months.  The bootstrap data is **derived from public PRL
chain data** — it does not invent blocks that would be inconsistent
with the actual chain.  See [BOOTSTRAP.md](BOOTSTRAP.md) for the full
methodology and the opt-out flag.

### `public/index.html` — the dashboard

A single-page static dashboard.  Reads `/api/stats` and `/api/blocks`
every 5 seconds and renders:

- Pool hashrate (5m / 1h / 24h EMA).
- Active miners.
- Current network difficulty and block height.
- Recent blocks (found / orphaned).
- Fee structure and payout policy link.

No client-side framework — vanilla JS to keep the page under 30 kB and
trivially auditable.

### `start.sh` — operator convenience wrapper

Sourced by most operators in production.  Reads config from
`./pool.env` if present, then forwards the right env vars to
`node src/pool.js`.  Logs go to `journalctl` via `systemd` if
configured.

## Data flow — lifecycle of a share

```
[miner]    submits nonce over Stratum
   |
   v
[pool.js]  validateShare()        ← share difficulty check
   |
   +----- invalid ----> drop
   |
   v
[pool.js]  meetsNetworkDifficulty() ← network difficulty check
   |
   +----- yes -----> submitBlockToNetwork()  ───> [PRL daemon]  submitblock
   |                                       <---                txid / duplicate
   |
   v
[pool.js]  blockFound handler
   |           +--> ledger.addBlock(height, hash, txid)
   |           +--> payoutEngine.distribute(reward, fee)
   |           +--> for each (address, amount):
   |                   | if amount >= minPayout:
   |                   |   sendPayoutTx(address, amount)  ───> [PRL daemon]  sendtoaddress
   |                   | else:
   |                   |   balance[address] += amount
   |
   v
[pool.js]  store.set(...)
[pool.js]  broadcast updated /api/stats to dashboard
```

## Data flow — chain scanner

```
[scanner.js]  every 30s:
   |
   v
[PRL daemon]  getblockchaininfo, getblock(hash, N)
   |
   v
[scanner.js]  compute orphan rate, network hashrate EMA, pool share %
   |
   v
[store.js]    save as state.networkStats
```

## Threading and concurrency

PearlPool is a single-process Node.js application.  There is no shared
mutable state across the Stratum handler, payout engine, and HTTP
handler other than through `store.js`, which serialises writes through
an internal mutex.  Reads are lock-free.

This means:

- No race conditions on `state.balance`.
- No `async/await` bugs around mid-write reads.
- No need for `worker_threads`.

The cost is that a single pool instance is bounded by one CPU core.
For pools above ~50 TH/s this becomes a bottleneck and the recommended
approach is to shard by `mining.notify` job-id prefix across multiple
instances, each writing to the same `store.js` backend.

## File layout

```
pearlpool/
├── src/
│   ├── pool.js          # main entry point
│   ├── payout.js        # PPLNS engine
│   ├── store.js         # persistent state (in-memory + JSON snapshot)
│   ├── stratum.js       # Stratum protocol server
│   └── scanner.js       # chain scanner
├── lib/
│   ├── persistence/
│   │   └── json-snapshot.js   # atomic JSON read/write
│   └── seed/
│       └── realistic-bootstrap.js
├── public/
│   └── index.html       # dashboard
├── docs/
│   ├── ARCHITECTURE.md  # this file
│   ├── BOOTSTRAP.md     # bootstrap methodology
│   ├── BLOCK_LIFECYCLE.md   # end-to-end example: share → payout
│   ├── FEE-STRUCTURE.md # fee breakdown
│   ├── RPC_SETUP.md     # PRL daemon config + sample responses
│   ├── SAMPLE_OUTPUT.md # sample /api/* responses
│   └── ROADMAP.md       # experimental → production trajectory
├── data/                # created at runtime; state.json snapshots live here
├── test.js              # unit tests
├── package.json
├── start.sh
├── CHANGELOG.md
├── SECURITY.md
├── CONTRIBUTING.md
├── TODO.md
└── README.md
```

## Failure modes

| Component fails        | Effect on pool                               | Recovery                                    |
|------------------------|----------------------------------------------|---------------------------------------------|
| Stratum handler        | Miners disconnected                          | Restart `pool.js`; reconnect is automatic  |
| HTTP API               | Dashboard offline; mining continues          | Restart `pool.js`; daemon RPC keeps mining  |
| PPLNS engine           | Payouts not calculated                       | Restart `pool.js`; pending shares retained  |
| Chain scanner          | Orphan rate stale; payouts still work        | Restart `pool.js`; scanner is stateless    |
| Daemon RPC             | Blocks not broadcast, payouts not sent       | Restart daemon; `pool.js` retries on next call |
| Persistent store       | Miners lose accrued balance if unwritten     | Restore from `data/state.json` backup       |

The pool is designed so that the only state that matters is what's in
`store.js`.  Restarting `pool.js` recovers everything from
`data/state.json` (if present).  Restarting the host recovers
everything except in-flight RPC calls (which are re-issued on the
next loop iteration).

## Production Safety Notes

- Persistence is `data/state.json` (atomic write, snapshot every
  60 s + on stop).  A SQLite-backed store is on the roadmap.
- Bootstrap data is **synthetic** and does not represent real
  mining activity.  Opt out with `--no-bootstrap`.
- No TLS, no auth on `/api/*`.  Front with a reverse proxy.
- No DoS protection on the stratum socket.  Rate-limit at the
  network layer.
- This is community software, **not affiliated with Pearl Research
  Labs**.

See the [Production Safety Notes](../README.md#production-safety-notes)
section of the README for the full version.