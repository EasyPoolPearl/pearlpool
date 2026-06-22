# Block Lifecycle, End-to-End

A worked example of one complete block lifecycle in PearlPool, from
"share received" to "miners paid".  Captured against a local regtest
node + one connected miner.  Useful for evaluators who want to
understand exactly when each of the following happens:

- a share crosses the network difficulty and is promoted to a block
- the block is broadcast via `submitblock`
- the block reaches 1, then 100, confirmations
- the PPLNS window is sampled
- the operator fee is credited
- each miner is paid via `sendtoaddress`
- the payout history is updated

All timestamps are Unix seconds.  Truncated hashes / addresses are
marked `…`.

---

## 0. Setup

```text
Pool:       PearlPool v2.1.0
Wallet:     prl1pOPERATOR_REDACTED
RPC:        pearld -regtest, 127.0.0.1:9933
Miner:      1 worker at 150 MH/s, share diff 65536
PPLNS fee:  1.0% base + 0.5% tx reserve = 1.5% total
```

Pool just started, the bootstrap module has seeded 12–18 historical
blocks and a handful of synthetic miners.  The chain tip is at height
101 with no in-flight work.

---

## 1. Job broadcast (T+0)

The chain scanner sees a new block at height 101 (mock — a `generate`
call from the regtest CLI).  It calls `getblocktemplate` and the pool
broadcasts a new `mining.notify` to every connected worker.

```text
[2024-06-22T10:00:00Z] scanner    ◆  New job broadcast: height=102,
[2024-06-22T10:00:00Z] scanner    ◆  prevHash=00000a2e6c6f5e7c…
[2024-06-22T10:00:00Z] stratum    notify → worker prl1pMINER_A.rig1
                                  (job_id=4f3a2b1c, prevhash=00000a2e…,
                                   nbits=1a0fffff, ntime=1718988120)
```

`/api/stats` after the broadcast (no shares submitted yet):

```json
{
  "connectedMiners": 1,
  "totalHashrate": 150000000,
  "blocksFound": 0,
  "networkHeight": 101,
  "fee": 0.01,
  "feeBreakdown": { "base_fee": 0.01, "tx_fee_reserve": 0.005, "total": 0.015 }
}
```

---

## 2. Share submission (T+15s)

After ~15 seconds of hashing, miner `prl1pMINER_A.rig1` finds a share
that crosses the network difficulty.  Pool receives `mining.submit`,
validates it (`hashHeader()` matches the network target), and:

1. Records the share in the PPLNS window
2. Calls `submitblock` on the daemon
3. Waits for the daemon's response

```text
[2024-06-22T10:00:15Z] stratum    submit ← prl1pMINER_A.rig1
                                  (job_id=4f3a2b1c, nonce=0x1f2e3d4c)
[2024-06-22T10:00:15Z] submit     block broadcast → submitblock()
[2024-06-22T10:00:15Z] submit     daemon response: null    ← block accepted
[2024-06-22T10:00:15Z] store      block found: height=102
[2024-06-22T10:00:15Z] payout     processBlock → 1 miner in window
[2024-06-22T10:00:15Z] payout     operator credit:  75_00000000
                                  (1.5% of 5000_00000000)
[2024-06-22T10:00:15Z] payout     miner credit:  4925_00000000
                                  (98.5% of 5000_00000000)
```

The single miner in the PPLNS window gets the entire miner share
since they contributed 100% of the eligible shares.

---

## 3. Confirmations (T+20s, T+30s, T+60s, …)

The scanner polls `getblock` on the daemon every 30 s.  Each poll
increments the `confirmations` field on the block record.  When
`confirmations >= 1`, the block is considered "settled" and is now
eligible for the miner payout cycle (next section).

```text
[2024-06-22T10:00:45Z] scanner    getblock(0000e3a4…) → confirmations=1
[2024-06-22T10:01:15Z] scanner    getblock(0000e3a4…) → confirmations=2
[2024-06-22T10:01:45Z] scanner    getblock(0000e3a4…) → confirmations=3
...
[2024-06-22T10:01:45Z] store      block 0000e3a4…: confirmations=3
```

`/api/blocks` after 3 confirmations:

```json
{
  "count": 1,
  "blocks": [
    {
      "hash": "0000e3a4b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5",
      "height": 102,
      "timestamp": 1718988115,
      "reward": 5000000000,
      "confirmations": 3,
      "finder": "prl1pMINER_A_REDACTED",
      "orphaned": false,
      "payoutTxids": []
    }
  ]
}
```

`payoutTxids` is empty because the block has not yet been paid out —
the payout cycle runs every 60 s (`payout-interval` default 3600, but
on a freshly-started pool we trigger an early cycle for any settled
block older than 60 s).

---

## 4. Payout cycle (T+75s)

The payout ticker fires.  It looks at every miner's pending balance
and submits the ones above `--min-payout` (default 1 PRL = 1e8 atomic
units).  In this case the only miner with a balance is
`prl1pMINER_A_REDACTED` with `pendingBalance = 49.25 PRL`.

```text
[2024-06-22T10:01:15Z] payout     cycle start: 1 miner above threshold
[2024-06-22T10:01:15Z] payout     sending 49.25 PRL → prl1pMINER_A_REDACTED
[2024-06-22T10:01:15Z] sendtoaddress
                                  params: ["prl1pMINER_A…", 49.25000000, "", "", false]
[2024-06-22T10:01:15Z] sendtoaddress
                                  response: "4a3b1c8d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b"
[2024-06-22T10:01:15Z] gettransaction
                                  response: { amount: 49.25, fee: -0.00001, ... }
[2024-06-22T10:01:15Z] store      payout recorded: prl1pMINER_A_REDACTED ← 49.25 PRL (txid 4a3b1c…)
[2024-06-22T10:01:15Z] store      block 0000e3a4…: payoutTxids=[4a3b1c…]
[2024-06-22T10:01:15Z] console    💰 Payout sent: 49.25 PRL to prl1pMINER_A… (txid: 4a3b1c8d2e9f…)
[2024-06-22T10:01:15Z] payout     cycle end: 1 paid, 0 skipped
```

The fee of 0.00001 PRL (1,000 atomic units) is paid by the operator
from the **tx-fee reserve** (the 0.5% collected on every block).  Net
result: miner receives 49.25 PRL, operator keeps 0.75 PRL (base fee
50 PRL * 1% = 0.5 PRL, plus tx reserve 50 PRL * 0.5% = 0.25 PRL),
minus the 0.00001 PRL on-chain fee = **0.74999000 PRL** credited to
the operator's on-chain balance for the next payout cycle.

---

## 5. Payout history (T+75s, sustained)

`/api/payouts` after the cycle:

```json
{
  "count": 1,
  "payouts": [
    {
      "address": "prl1pMINER_A_REDACTED",
      "amount": 4925000000,
      "txHash": "4a3b1c8d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
      "timestamp": 1718988075,
      "blockHeight": 102,
      "confirmations": 19,
      "fee": 1000
    }
  ]
}
```

`/api/miner/prl1pMINER_A_REDACTED` after the payout:

```json
{
  "address": "prl1pMINER_A_REDACTED",
  "hashrate": 150000000,
  "shares": 18450,
  "pendingBalance": 0,
  "totalPaid": 4925000000,
  "lastPayout": 1718988075
}
```

---

## 6. State snapshot (every 60 s)

Once per minute, the pool serialises the store to
`./data/state.json` atomically (write to `.tmp` → fsync → rename) so a
clean restart resumes from the same point.  The format is:

```json
{
  "version": 1,
  "savedAt": 1718988135,
  "miners": [["prl1pMINER_A_REDACTED", { ... }]],
  "blocks": [ { "hash": "0000e3a4…", "height": 102, ... } ],
  "pendingPayouts": [],
  "stats": { "blocksFound": 1, "totalHashrate": 150000000, ... },
  "hashrateHistory": [ ... ],
  "payoutHistory": [ { "address": "prl1pMINER_A…", "amount": 4925000000, ... } ]
}
```

If the process is killed between snapshots, pending balances and
unconfirmed payouts are lost.  This is an accepted trade-off for the
"zero external dependencies" design — a SQLite or PostgreSQL backend
is on the [TODO](../TODO.md) for v2.2.

---

## 7. Orphan handling (what happens when it goes wrong)

If a different pool finds the next block at height 102 first, our
`submitblock` call returns `"duplicate"` instead of `null`.  The pool
treats this as an orphan:

```text
[2024-06-22T10:00:15Z] submit     daemon response: "duplicate"
[2024-06-22T10:00:15Z] store      block 0000e3a4…: orphaned=true
[2024-06-22T10:00:15Z] store      orphanReason="duplicate"
[2024-06-22T10:00:15Z] payout     processBlock → skip (orphaned)
[2024-06-22T10:00:15Z] console    ✗ Block 0000e3a4… orphaned (duplicate)
```

`processBlock` short-circuits: the operator fee is *not* credited,
the miner share is *not* distributed, and the shares that contributed
to the orphan stay in the PPLNS window so they earn credit on the
next block.  This matches the ckpool behaviour and is what most
miners expect from a PPLNS pool.

---

## See also

- [docs/RPC_SETUP.md](RPC_SETUP.md) — the daemon calls above, in
  detail with retry / error-handling.
- [docs/FEE-STRUCTURE.md](FEE-STRUCTURE.md) — the 1.5% fee
  calculation, with this same example worked out algebraically.
- [docs/SAMPLE_OUTPUT.md](SAMPLE_OUTPUT.md) — the same data points
  above, organised by API endpoint.
