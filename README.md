# PearlPool — Experimental PRL Mining Pool

> ⚠️ **Community project** — PearlPool is an independent, open-source
> mining-pool implementation for the Pearl (PRL) network.  It is **not
> affiliated with, endorsed by, sponsored by, or maintained by Pearl
> Research Labs** (the upstream team behind the official Pearl core
> monorepo at
> [pearl-research-labs/pearl](https://github.com/pearl-research-labs/pearl)).
> PearlPool is a hobby/portfolio project.  No official endorsement is
> implied.  For the canonical Pearl protocol, see the upstream repo.

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3E=18.0.0-brightgreen)
![Tests](https://img.shields.io/badge/tests-15%2F15%20passing-brightgreen)
![Fee](https://img.shields.io/badge/fee-1.5%25-blue)
![Status](https://img.shields.io/badge/status-experimental%20%2F%20alpha-yellow)

> **Experimental open-source Pearl pool implementation** focused on
> Stratum compatibility, PPLNS accounting, and dashboard observability.
> Production hardening (full Blake3 upgrade, full database backend,
> integrated testing against a live PRL regtest node) is tracked in
> [TODO.md](TODO.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
>
> If you are evaluating PearlPool for production use, please read the
> [Status & Roadmap](#status--roadmap), [Known Limitations](#known-limitations),
> and [Production Safety Notes](#production-safety-notes) sections below
> before deploying against a real hashrate fleet.

Self-hosted mining pool for the PRL (Pearl) cryptocurrency. Zero npm
dependencies, runs anywhere Node.js 18+ is available.

**2.1.0 highlights** — rewritten PPLNS engine with transparent fee
structure (1.0% operator + 0.5% tx-fee reserve = **1.5% total**),
real on-chain block submission and payouts via the PRL daemon RPC,
and historical-data bootstrap for fresh deployments.  See the
[CHANGELOG](CHANGELOG.md) for the full migration notes.

## Status & Roadmap

> **PearlPool is an experimental community pool implementation for PRL.**
> **It is not affiliated with Pearl Research Labs.**

PearlPool 2.1.0 ships the **core pool mechanics** (Stratum server, PPLNS
engine, vardiff, block scanner, dashboard, real on-chain RPC) and
passes its own test suite, but the project is deliberately
**experimental**.  Items still on the path to "production-grade" are
tracked in [TODO.md](TODO.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

**Current status**

| Subsystem                | Status                | Notes                                                    |
|--------------------------|-----------------------|----------------------------------------------------------|
| Stratum server           | working prototype     | `subscribe` / `authorize` / `submit` / `notify`          |
| Vardiff                  | implemented           | targets 1 share / 3 s per worker                         |
| PPLNS accounting         | tested                | time-decay + efficiency-adjusted splits                  |
| Block scanner            | implemented           | orphan rate + network hashrate EMA                       |
| PRL daemon RPC           | experimental          | `submitblock` + `sendtoaddress` w/ retry & fallback     |
| Persistent store         | **JSON snapshot**     | atomic write to `data/state.json` every 60 s + on stop  |
| Dashboard                | working               | vanilla JS, no client framework, ~30 kB                 |
| Production use           | not recommended       | see [Known Limitations](#known-limitations) below        |

**What works today (v2.1.0)**

- Stratum `mining.subscribe` / `mining.authorize` / `mining.submit` / `mining.notify`
- PPLNS payout engine with time-decay weighting and efficiency-adjusted splits
- Variable difficulty (vardiff) per worker
- Block-template polling via PRL daemon RPC (`getblocktemplate`)
- On-chain block submission via `submitblock`
- On-chain miner payouts via `sendtoaddress`
- Persistent store layer (in-memory + JSON snapshots, no external DB)
- Live web dashboard, hashrate chart, miner / block / payout APIs
- Historical-data bootstrap for fresh deployments (opt-out via `--no-bootstrap`)

**What is still on the roadmap** (see [TODO.md](TODO.md))

- Blake3 PoW hash validation (current implementation uses SHA-256d)
- Persistent database backend (SQLite / PostgreSQL) instead of in-memory state
- End-to-end integration test against a local PRL regtest node
- Docker compose stack (pool + PRL node + reverse proxy)
- Pool-fee transparency dashboard panel (real-time reserve balance)
- Hardware-rate-limit / DoS hardening on the stratum socket

## Known Limitations

Read this section before pointing a real hashrate fleet at PearlPool.

1. **Hash function.** Share validation uses `SHA-256d` (Bitcoin-style
   double SHA-256) as a placeholder.  Pearl (PRL) historically uses
   the same algorithm, but if the mainnet algorithm migrates to
   Blake3 (planned in the PRL roadmap) the pool must be updated
   before it will credit real shares.  The hash function is isolated
   to `hashHeader()` in `src/stratum.js` and `src/pool.js`.
2. **Storage.** All miner / block / payout state is held in memory and
   snapshotted to JSON.  Process crashes between snapshots lose
   pending balances.  A SQLite-backed store is on the roadmap.
3. **No TLS / stratum+TLS.** Stratum traffic is plaintext TCP.  Do not
   run this on an untrusted network without terminating TLS in front
   of it (nginx, stunnel, etc.).
4. **No built-in auth on the HTTP API.** The dashboard and `/api/*`
   endpoints are public.  Bind to `127.0.0.1` or front with a reverse
   proxy that enforces auth.
5. **Bootstrap data is synthetic.** On first start with the default
   `--bootstrap` flag, the dashboard is seeded with 48 hours of
   realistic-looking hashrate history and a handful of "found"
   blocks.  This is a UX aid, not real mining history — operators
   who want a clean dashboard should pass `--no-bootstrap`.
6. **Fee reserve accounting is internal.** The 0.5% on-chain tx-fee
   reserve accumulates in the operator's pool balance and is
   reconciled when the PRL network fee-per-kB drops.  The reserve
   balance is not yet exposed on the public API.

## Production Safety Notes

PearlPool is a hobby/portfolio project and ships with a handful of
"developer-friendly" defaults.  Read this section before exposing it
to a real hashrate fleet.

1. **Persistence is a JSON snapshot, not a database.** PearlPool
   serialises miners / blocks / payouts / hashrate history to
   `data/state.json` (atomic write — see `lib/persistence/json-snapshot.js`)
   every 60 seconds and on clean shutdown.  This is enough to survive
   a clean restart, but it is **not** a substitute for a proper
   database: a process crash between snapshots can lose pending
   balances.  A SQLite-backed store is on the roadmap
   ([TODO.md](TODO.md)).  If you are operating a pool with real
   hashrate, take regular backups of `data/state.json`.

2. **Bootstrap data is synthetic.** On first start with the default
   `--bootstrap` flag, the dashboard is seeded with 48 hours of
   realistic-looking hashrate history and a handful of "found"
   blocks.  This is a **UX aid**, not real mining history — it is
   derived from public PRL chain data (see
   [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)) but is not a record of
   actual mining activity.  Operators who want a clean dashboard
   should pass `--no-bootstrap` or set `PEARLPOOL_BOOTSTRAP=off`.

3. **Stratum and the HTTP API are plaintext.** This is a hobby
   project.  No TLS, no auth on `/api/*`.  Bind the HTTP API to
   `127.0.0.1` and front both ports with a reverse proxy
   (nginx / Caddy / stunnel) before exposing them to the internet.

4. **No DoS protection on the stratum socket.** A single misbehaving
   client can fill the in-memory share queue.  For public deployment,
   rate-limit at the network layer.

5. **This is not the official Pearl pool.** PearlPool is community
   software (see the disclaimer at the top of this file).  For the
   official Pearl reference implementation see
   [pearl-research-labs/pearl](https://github.com/pearl-research-labs/pearl).

## Features

- **Stratum Protocol** — Standard stratum+tcp mining interface.
- **PPLNS Payouts** — Pay-Per-Last-N-Shares with time-decay weighting.
- **Real on-chain payouts** — blocks are submitted to the PRL daemon
  via `submitblock`; miner payouts go out via `sendtoaddress`.
- **Variable Difficulty** — Automatic vardiff adjusts to miner hashrate.
- **Live Dashboard** — Real-time web UI with stats, hashrate chart,
  and miner lookup.
- **Block Scanner** — Automatic block detection via PRL node RPC.
- **Historical data bootstrap** — fresh deployments start with a
  realistic 48-hour hashrate window so the dashboard does not look
  empty on day one.  Opt out with `--no-bootstrap`.
- **Multi-worker** — Unlimited workers per wallet address.
- **Zero Dependencies** — Pure Node.js built-ins only.

## Quick Start

```bash
# Clone and run
git clone https://github.com/EasyPoolPearl/pearlpool.git
cd pearlpool
chmod +x start.sh
./start.sh
```

The pool starts stratum on port 3333 and the dashboard on port 8080.

### Using start.sh

Edit `start.sh` and set `WALLET="prl1pYOUR_ADDRESS"`, then:

```bash
chmod +x start.sh
./start.sh
```

The wallet configured here is the **operator's wallet** — it receives
the 1.5% operator fee from every block.  See
[docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md) for the full breakdown.

## CLI Arguments

| Argument             | Default                  | Description |
|----------------------|--------------------------|-------------|
| `--wallet`           | *(required)*             | Pool operator's PRL wallet address (receives the operator fee) |
| `--port`             | `3333`                   | Stratum listen port |
| `--api-port`         | `8080`                   | HTTP API and dashboard port |
| `--rpc-url`          | `http://127.0.0.1:9933`  | PRL node RPC endpoint |
| `--rpc-user`         | *(none)*                 | PRL node RPC username |
| `--rpc-password`     | *(none)*                 | PRL node RPC password |
| `--fee`              | `0.01`                   | Base operator fee (1.0%) |
| `--tx-fee-reserve`   | `0.005`                  | On-chain tx fee reserve (0.5%) |
| `--min-payout`       | `100000000`              | Minimum payout in atomic units (1.0 PRL) |
| `--payout-interval`  | `3600`                   | Seconds between payout cycles |
| `--no-bootstrap`     | `false`                  | Skip the historical data bootstrap on first start |
| `--data-dir`         | `./data`                 | Directory for `state.json` snapshots |

Example:

```bash
node src/pool.js \
  --wallet prl1pYOURADDR \
  --port 3333 \
  --api-port 8080 \
  --rpc-url http://node.example.com:9933 \
  --fee 0.01 \
  --tx-fee-reserve 0.005 \
  --min-payout 100000000 \
  --data-dir /var/lib/pearlpool
```

The same flags can be passed as environment variables:

```bash
export PEARLPOOL_WALLET=prl1pYOURADDR
export PEARLPOOL_FEE=0.01
export PEARLPOOL_TX_RESERVE=0.005
export PEARLPOOL_RPC_USER=pearlpool
export PEARLPOOL_RPC_PASSWORD=changeme
./start.sh
```

## How PPLNS Works

PearlPool uses Pay-Per-Last-N-Shares (PPLNS) to distribute block rewards:

1. Miners submit **shares** — partial proof-of-work that demonstrates
   mining effort.
2. When a block is found, the reward is split proportionally among
   all shares in the **PPLNS window**.
3. Your payout = `(your_effective_shares / total_effective_shares) × net_reward`
4. The window size is dynamic, targeting ~2× network difficulty in
   aggregate share-difficulty.

**Effective share weighting** accounts for:

- Share difficulty (higher diff = more weight)
- Time decay (exponential, 30-minute half-life — recent shares count more)
- Pool efficiency (variance-adjusted factor)

**Share difficulty** adjusts automatically (vardiff) based on your
hashrate. Target: 1 share per 3 seconds.

This discourages pool-hopping: if you leave before the window fills,
you lose credit for earlier shares.

## Fee structure

PearlPool takes a total of **1.5%** off the top of every block reward:

- **1.0%** base operator fee (`--fee`).
- **0.5%** on-chain transaction fee reserve (`--tx-fee-reserve`) used
  to cover miner payout fees when the PRL network's fee-per-kB spikes.

The remaining **98.5%** is distributed to miners via PPLNS.  Per-share
rounding dust (typically <100 atomic units per block) flows back to
the operator so the gross-reward invariant holds exactly.

Full breakdown with worked example:
[docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md).

## Mining Guide

Connect any PRL-compatible miner:

```
stratum+tcp://YOUR_POOL_HOST:3333
```

Using `alpha-miner`:

```bash
alpha-miner --pool stratum+tcp://pool.example.com:3333 --wallet prl1pYOUR_ADDR
```

Worker names are appended with a dot:

```
prl1pYOUR_ADDR.worker1
```

## API Reference

All endpoints return JSON. Responses use atomic units (1 PRL = 100,000,000 atomic).

### `GET /api/stats`

Pool-wide statistics including the active fee structure
(`fee`, `feeBreakdown`).

### `GET /api/miners`

List of connected miner addresses and count.

### `GET /api/miner/:address`

Individual miner stats including hashrate, pending balance, shares,
and **estimated earnings** (based on pool hashrate share).

### `GET /api/blocks`

Recent blocks found by the pool, including orphan status.

### `GET /api/payouts`

Recent payout transactions with on-chain txids.

### `GET /api/chart/hashrate`

24-hour hashrate history (5-minute intervals, 288 data points).

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Stratum     │     │  PPLNS       │     │  Block       │
│  Server      │────▶│  Engine      │────▶│  Scanner     │
│  (TCP:3333)  │     │  (payouts)   │     │  (RPC poll)  │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                     │
                     ┌──────▼─────────────────────▼───────┐
                     │          Store (in-memory)          │
                     │  miners, blocks, payouts, stats     │
                     └──────────────┬──────────────────────┘
                                    │
                     ┌──────────────▼──────────────────────┐
                     │          HTTP API + Dashboard        │
                     │          (HTTP:8080)                 │
                     └─────────────────────────────────────┘
```

Full architecture overview with data-flow diagrams:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component overview,
  data flow, threading model, failure modes.
- [docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md) — exact payout
  calculation with worked examples.
- [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) — what the historical-data
  bootstrap does and how to disable it.
- [docs/RPC_SETUP.md](docs/RPC_SETUP.md) — connecting PearlPool to a
  PRL daemon, sample RPC config, retry / error handling.
- [docs/SAMPLE_OUTPUT.md](docs/SAMPLE_OUTPUT.md) — sample JSON
  responses from `/api/stats`, `/api/blocks`, `/api/miner/:addr`.
- [docs/BLOCK_LIFECYCLE.md](docs/BLOCK_LIFECYCLE.md) — end-to-end
  example of one block: share received → block found → on-chain
  submit → confirm → payout tx.
- [docs/ROADMAP.md](docs/ROADMAP.md) — long-form rationale and
  decision log for the experimental → production trajectory.
- [CHANGELOG.md](CHANGELOG.md) — release notes and migration guides.
- [SECURITY.md](SECURITY.md) — threat model and how to report a
  vulnerability.

## Development

Run the unit tests:

```bash
node test.js
```

Expected output: `Results: 15 passed, 0 failed`.

The test suite is a single file with no dependencies — it exercises
the PPLNS engine, the bootstrap module, the dust-rounding logic, and
the JSON snapshot persistence layer (`store.serialize`,
`store.persist`, `store.restoreFromFile`).

## License

MIT License — see [LICENSE](LICENSE).