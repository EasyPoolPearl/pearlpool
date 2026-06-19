# PearlPool — Open-source PRL Mining Pool

![Version](https://img.shields.io/badge/version-2.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3E=18.0.0-brightgreen)

Self-hosted mining pool for the PRL (Pearl) cryptocurrency. Zero npm dependencies, runs anywhere Node.js 18+ is available.

## Features

- **Stratum Protocol** — Standard stratum+tcp mining interface
- **PPLNS Payouts** — Pay-Per-Last-N-Shares with time-decay weighting
- **Variable Difficulty** — Automatic vardiff adjusts to miner hashrate
- **Live Dashboard** — Real-time web UI with stats, hashrate chart, and miner lookup
- **Block Scanner** — Automatic block detection via PRL node RPC
- **Multi-worker** — Unlimited workers per wallet address
- **Zero Dependencies** — Pure Node.js built-ins only

## Quick Start

```bash
# Install
curl -sL https://raw.githubusercontent.com/EasyPoolPearl/pearlpool/main/install.sh | bash

# Run (edit start.sh with your wallet, or use --wallet directly)
./pearlpool --wallet prl1pYOUR_WALLET_ADDRESS
```

The pool starts stratum on port 3333 and the dashboard on port 8080.

### Using start.sh

Edit `start.sh` with your wallet address, then:

```bash
chmod +x start.sh
./start.sh
```

## CLI Arguments

| Argument | Default | Description |
|---|---|---|
| `--wallet` | *(required)* | Pool operator's PRL wallet address |
| `--port` | `3333` | Stratum listen port |
| `--api-port` | `8080` | HTTP API and dashboard port |
| `--rpc-url` | `http://127.0.0.1:18555` | PRL node RPC endpoint |
| `--fee` | `1.0` | Base fee percentage |
| `--min-payout` | `0.1` | Minimum payout threshold (PRL) |

Example:

```bash
./pearlpool \
  --wallet prl1pYOURADDR \
  --port 3333 \
  --api-port 8080 \
  --rpc-url http://node.example.com:18555 \
  --fee 1.0 \
  --min-payout 0.5
```

## How PPLNS Works

PearlPool uses Pay-Per-Last-N-Shares (PPLNS) to distribute block rewards:

1. Miners submit **shares** — partial proof-of-work that demonstrates mining effort.
2. When a block is found, the reward is split proportionally among all shares in the **PPLNS window**.
3. Your payout = `(your_effective_shares / total_effective_shares) × net_reward`
4. The window size is dynamic, targeting ~2× network difficulty in aggregate share-difficulty.

**Effective share weighting** accounts for:
- Share difficulty (higher diff = more weight)
- Time decay (exponential, 30-minute half-life — recent shares count more)
- Pool efficiency (variance-adjusted factor)

**Share difficulty** adjusts automatically (vardiff) based on your hashrate. Target: 1 share per 3 seconds.

This discourages pool-hopping: if you leave before the window fills, you lose credit for earlier shares.

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

Pool-wide statistics.

### `GET /api/miners`

List of connected miner addresses and count.

### `GET /api/miner/:address`

Individual miner stats including hashrate, pending balance, shares, and **estimated earnings** (based on pool hashrate share).

### `GET /api/blocks`

Recent blocks found by the pool.

### `GET /api/payouts`

Recent payout transactions.

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

## License

MIT License — see [LICENSE](LICENSE).
