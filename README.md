# PearlPool — Open-source PRL Mining Pool

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)

Self-hosted mining pool for the PRL (Pearl) cryptocurrency. Zero dependencies, single binary, runs anywhere Node.js 18+ is available.

## Features

- **Stratum Protocol** — Standard stratum+tcp mining interface
- **PPLNS Payouts** — Pay-Per-Last-N-Shares for fair reward distribution
- **Variable Difficulty** — Automatic vardiff adjusts to miner hashrate
- **Live Dashboard** — Real-time web UI with stats, charts, and miner lookup
- **Block Scanner** — Automatic block detection and confirmation tracking
- **Multi-worker** — Unlimited workers per wallet address
- **Zero Dependencies** — Pure Node.js, no npm packages required

## Quick Start

```bash
# Install
curl -sL https://raw.githubusercontent.com/EasyPoolPearl/pearlpool/main/install.sh | bash

# Run
./pearlpool --wallet prl1pYOUR_WALLET_ADDRESS
```

The pool will start stratum on port 3333 and the API/dashboard on port 8080.

## CLI Arguments

| Argument | Default | Description |
|---|---|---|
| `--wallet` | *(required)* | Pool operator's PRL wallet address |
| `--port` | `3333` | Stratum listen port |
| `--api-port` | `8080` | HTTP API and dashboard port |
| `--rpc-url` | `http://127.0.0.1:11332` | PRL node RPC endpoint |
| `--fee` | `1.0` | Pool fee percentage |
| `--min-payout` | `0.1` | Minimum payout threshold (PRL) |
| `--log-level` | `info` | Log verbosity: debug, info, warn, error |

Example with all options:

```bash
./pearlpool \
  --wallet prl1pYOURADDR \
  --port 3333 \
  --api-port 8080 \
  --rpc-url http://node.example.com:11332 \
  --fee 1.0 \
  --min-payout 0.5
```

## How PPLNS Works

PearlPool uses Pay-Per-Last-N-Shares (PPLNS) to distribute block rewards:

1. Miners submit **shares** — partial proof-of-work that demonstrates mining effort.
2. When a block is found, the reward is split proportionally among all shares in the **PPLNS window** (the last N shares submitted).
3. Your payout = `(your_shares / total_shares_in_window) × block_reward × (1 - pool_fee)`
4. The window size is dynamic, targeting ~30 minutes of pool share history.

This discourages pool-hopping: if you leave before the window fills, you lose credit for earlier shares.

**Share difficulty** adjusts automatically (vardiff) based on your hashrate. Higher hashrate → higher difficulty shares → fewer stale/orphaned shares.

## Mining Guide

Connect any PRL-compatible miner to the pool's stratum endpoint:

```
stratum+tcp://YOUR_POOL_HOST:3333
```

Using `alpha-miner`:

```bash
alpha-miner --pool stratum+tcp://pool.example.com:3333 --wallet prl1pYOUR_ADDR
```

Using other miners — point them at `stratum+tcp://HOST:3333` with your wallet as username. Worker names are appended with a dot:

```
prl1pYOUR_ADDR.worker1
```

## API Reference

All endpoints return JSON.

### `GET /api/stats`

Pool statistics.

```json
{
  "poolHashrate": 125000000,
  "activeMiners": 47,
  "blocksFound": 132,
  "networkHashrate": 5000000000,
  "networkDifficulty": 892345,
  "lastBlockTime": 1718000000000,
  "poolFee": 1.0
}
```

### `GET /api/miners`

Active miner count.

```json
{
  "count": 47,
  "miners": ["prl1p...", "prl1p..."]
}
```

### `GET /api/miner/:address`

Individual miner stats.

```json
{
  "address": "prl1p...",
  "hashrate": 2500000,
  "pending": 0.0543,
  "paid": 12.87,
  "shares24h": 18432,
  "workers": 3,
  "lastShare": 1718000000000
}
```

### `GET /api/blocks`

Recent blocks found by the pool.

```json
{
  "blocks": [
    {
      "height": 284510,
      "hash": "0000abc...",
      "finder": "prl1p...",
      "timestamp": 1718000000000,
      "reward": 12.5,
      "confirmations": 6
    }
  ]
}
```

### `GET /api/chart/hashrate`

24-hour hashrate history (5-minute intervals).

```json
{
  "points": [
    { "time": 1718000000000, "hashrate": 120000000 },
    { "time": 1718000300000, "hashrate": 125000000 }
  ]
}
```

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Stratum     │     │  Share       │     │  Block       │
│  Server      │────▶│  Manager     │────▶│  Scanner     │
│  (TCP:3333)  │     │  (PPLNS)     │     │  (RPC poll)  │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                     │
                     ┌──────▼─────────────────────▼───────┐
                     │          State Manager              │
                     │  (shares, balances, blocks)         │
                     └──────────────┬──────────────────────┘
                                    │
                     ┌──────────────▼──────────────────────┐
                     │          HTTP API / Dashboard        │
                     │          (HTTP:8080)                 │
                     └─────────────────────────────────────┘
```

- **Stratum Server**: Handles miner connections, vardiff, share validation.
- **Share Manager**: PPLNS window tracking, payout calculation.
- **Block Scanner**: Polls the PRL node via RPC for new blocks.
- **State Manager**: In-memory state with periodic persistence.
- **HTTP API**: REST endpoints + serves the web dashboard.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-thing`)
3. Commit with clear messages
4. Open a PR against `main`

Keep it simple. No unnecessary dependencies. Match existing code style.

## License

MIT License — see [LICENSE](LICENSE).
