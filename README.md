# PearlPool — Open-source PRL Mining Pool

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3E=18.0.0-brightgreen)
![Tests](https://img.shields.io/badge/tests-15%2F15%20passing-brightgreen)
![Fee](https://img.shields.io/badge/fee-1.5%25-blue)

Self-hosted mining pool for the PRL (Pearl) cryptocurrency. Zero npm
dependencies, runs anywhere Node.js 18+ is available.

> **New in 2.1.0** — rewritten PPLNS engine with transparent fee
> structure (1.0% operator + 0.5% tx-fee reserve = **1.5% total**),
> real on-chain block submission and payouts via the PRL daemon RPC,
> and historical-data bootstrap for fresh deployments.  See the
> [CHANGELOG](CHANGELOG.md) for the full migration notes.

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

Example:

```bash
node src/pool.js \
  --wallet prl1pYOURADDR \
  --port 3333 \
  --api-port 8080 \
  --rpc-url http://node.example.com:9933 \
  --fee 0.01 \
  --tx-fee-reserve 0.005 \
  --min-payout 100000000
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
the PPLNS engine, the bootstrap module, and the dust-rounding logic.

## License

MIT License — see [LICENSE](LICENSE).