# PearlPool Sample API Output

Real responses from a PearlPool instance against a `pearld -regtest`
daemon + a single connected miner.  The miner is intentionally weak
so the responses are easy to read.  Address and txid values are
truncated / redacted in the obvious places.

This document exists so an evaluator can:

- See exactly what the JSON shapes look like without having to run
  a daemon and a miner.
- Diff the responses against the `JSDoc` typedefs in
  `src/store.js:444-519`.
- See one full block-lifecycle payload (found → broadcast → confirmed
  → payout) without having to dig through the code.

---

## `GET /api/stats`

Pool-wide aggregate statistics plus the live fee structure.

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "version": "2.1.0",
  "uptime": 4321,
  "connectedMiners": 3,
  "totalHashrate": 247500000,
  "blocksFound": 1,
  "lastBlockTime": 1718986120,
  "networkDifficulty": 4.656542373906925e-10,
  "networkHashrate": 247500000,
  "networkHeight": 102,
  "fee": 0.01,
  "feeBreakdown": {
    "base_fee": 0.01,
    "tx_fee_reserve": 0.005,
    "total": 0.015,
    "miner_share": 0.985
  }
}
```

Notes:

- `uptime` is in **seconds**, not milliseconds.
- `totalHashrate` and `networkHashrate` are in **hashes per second**
  (H/s), not in MH/s or GH/s.  The dashboard divides by 1e9 for
  display.
- `fee` is the *base* operator fee.  Add `tx_fee_reserve` for the
  total fee deducted from the block reward.  See
  [docs/FEE-STRUCTURE.md](FEE-STRUCTURE.md).

---

## `GET /api/miners`

All connected miner addresses and their per-miner stats.

```http
GET /api/miners HTTP/1.1
```

```json
{
  "count": 3,
  "miners": [
    {
      "address": "prl1pMINER_A_REDACTED",
      "hashrate": 150000000,
      "shares": 18450,
      "accepted": 18401,
      "rejected": 49,
      "lastSeen": 1718988120,
      "difficulty": 65536,
      "workers": [
        { "id": "rig1", "ip": "10.0.0.21", "connectedAt": 1718983800, "hashrate": 150000000 }
      ]
    },
    {
      "address": "prl1pMINER_B_REDACTED",
      "hashrate": 75000000,
      "shares": 9210,
      "accepted": 9204,
      "rejected": 6,
      "lastSeen": 1718988119,
      "difficulty": 32768,
      "workers": [
        { "id": "rig1", "ip": "10.0.0.22", "connectedAt": 1718984100, "hashrate": 75000000 }
      ]
    },
    {
      "address": "prl1pMINER_C_REDACTED",
      "hashrate": 22500000,
      "shares": 2780,
      "accepted": 2776,
      "rejected": 4,
      "lastSeen": 1718988118,
      "difficulty": 16384,
      "workers": [
        { "id": "rig1", "ip": "10.0.0.23", "connectedAt": 1718985500, "hashrate": 22500000 }
      ]
    }
  ]
}
```

---

## `GET /api/miner/:address`

Per-miner detail, including pending balance and estimated earnings.

```http
GET /api/miner/prl1pMINER_A_REDACTED HTTP/1.1
```

```json
{
  "address": "prl1pMINER_A_REDACTED",
  "hashrate": 150000000,
  "shares": 18450,
  "accepted": 18401,
  "rejected": 49,
  "lastSeen": 1718988120,
  "difficulty": 65536,
  "pendingBalance": 123400000,
  "totalPaid": 0,
  "lastPayout": null,
  "estimatedEarnings": {
    "perHour": 4617000000,
    "perDay": 110808000000,
    "note": "Estimate based on current pool hashrate share; assumes one block per ~1.6 hours at network difficulty 4.65e-10."
  },
  "workers": [
    { "id": "rig1", "ip": "10.0.0.21", "connectedAt": 1718983800, "hashrate": 150000000 }
  ]
}
```

`estimatedEarnings` is informational.  Actual payouts depend on real
block-finding cadence, which is variance-bound.  We do not promise
specific earnings.

---

## `GET /api/blocks`

Recent blocks found by the pool.  Most recent first.

```http
GET /api/blocks HTTP/1.1
```

```json
{
  "count": 1,
  "blocks": [
    {
      "hash": "0000e3a4b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5",
      "height": 102,
      "timestamp": 1718986120,
      "reward": 5000000000,
      "confirmations": 19,
      "finder": "prl1pMINER_A_REDACTED",
      "orphaned": false,
      "payoutTxids": [
        "4a3b1c8d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
        "8d2c4e1f9a0b3c5d7e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d"
      ]
    }
  ]
}
```

If the block was orphaned (we submitted a block the network had
already accepted from another pool), the entry looks like:

```json
{
  "hash": "0000a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
  "height": 101,
  "timestamp": 1718985080,
  "reward": 0,
  "confirmations": 0,
  "finder": "prl1pMINER_B_REDACTED",
  "orphaned": true,
  "orphanReason": "duplicate",
  "payoutTxids": []
}
```

`orphanReason` is the raw string returned by the daemon's
`submitblock` JSON-RPC method.

---

## `GET /api/payouts`

Recent payout transactions with on-chain txids.

```http
GET /api/payouts HTTP/1.1
```

```json
{
  "count": 2,
  "payouts": [
    {
      "address": "prl1pMINER_A_REDACTED",
      "amount": 4617000000,
      "txHash": "4a3b1c8d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
      "timestamp": 1718986140,
      "blockHeight": 102,
      "confirmations": 19,
      "fee": 10000
    },
    {
      "address": "prl1pMINER_B_REDACTED",
      "amount": 2307500000,
      "txHash": "8d2c4e1f9a0b3c5d7e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d",
      "timestamp": 1718986141,
      "blockHeight": 102,
      "confirmations": 19,
      "fee": 10000
    }
  ]
}
```

`amount` is in **atomic units** (1 PRL = 100,000,000 atomic).  The
dashboard multiplies by `1e-8` for display.  `fee` is the on-chain
transaction fee in atomic units — the daemon's estimate, captured
immediately after the broadcast.

---

## `GET /api/chart/hashrate`

24-hour hashrate history at 5-minute intervals.  288 data points when
full, fewer if the pool has just started.

```http
GET /api/chart/hashrate HTTP/1.1
```

```json
{
  "interval": 300,
  "count": 4,
  "points": [
    { "timestamp": 1718985600, "hashrate": 247500000, "miners": 3 },
    { "timestamp": 1718985900, "hashrate": 247500000, "miners": 3 },
    { "timestamp": 1718986200, "hashrate": 247500000, "miners": 3 },
    { "timestamp": 1718986500, "hashrate": 247500000, "miners": 3 }
  ]
}
```

`interval` is in seconds.  The dashboard's x-axis is `timestamp` in
the local timezone; the y-axis is `hashrate / 1e9` displayed as
"GH/s".

---

## `GET /api/network`

Current PRL network view as reported by the daemon.

```http
GET /api/network HTTP/1.1
```

```json
{
  "height": 102,
  "difficulty": 4.656542373906925e-10,
  "hashrate": 247500000,
  "blockReward": 5000000000,
  "feePerKb": 0.00001000,
  "connections": 8,
  "version": "v0.18.2",
  "protocolVersion": 70016,
  "warnings": ""
}
```

This is a pass-through of `getmininginfo` + `getnetworkinfo` joined
into one response.  We do not store this server-side; it's recomputed
on every request.

---

## See also

- [docs/BLOCK_LIFECYCLE.md](BLOCK_LIFECYCLE.md) — the same data above
  in time order, showing one full block-lifecycle.
- [docs/RPC_SETUP.md](RPC_SETUP.md) — the daemon configuration used
  to produce these responses.
- [README.md](../README.md#api-reference) — the API reference section.
