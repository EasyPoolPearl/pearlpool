# PearlPool RPC Setup

PearlPool requires a running Pearl (PRL) daemon reachable over JSON-RPC for
block-template polling, on-chain block submission, and miner payouts.  This
document shows the daemon configuration we test against, the JSON-RPC
methods we use, and how to verify each one.

> **Tested against:** `pearld` v0.18.x (PRL mainnet) and `pearld -regtest`
> (local regression testnet).  Earlier versions back to v0.16 also work
> but the `submitblock` response shape changed in v0.17.

---

## 1. Daemon configuration (`pearl.conf`)

Place this at `~/.pearl/pearl.conf` (Linux) or
`%APPDATA%\Pearl\pearl.conf` (Windows).

```ini
# --- Network ---
# Mainnet (default)
# testnet=0

# Regtest (local, fast blocks, deterministic rewards)
regtest=1

# --- RPC server ---
# Bind to localhost only by default.  If the pool runs on a different
# host, set `rpcallowip` to the pool's IP / CIDR, or use stunnel / an
# SSH tunnel to keep RPC off the public network.
rpcuser=pearlpool
rpcpassword=CHANGE_ME_LONG_RANDOM_STRING
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=9933

# --- P2P ---
listen=1
port=9934

# --- Mining / Coinbase ---
# Pool's coinbase payout script (PRL address)
# Set this to the operator's wallet from --wallet in pool.js
miningaddr=prl1pYOUR_OPERATOR_ADDRESS

# Don't let the daemon mine its own blocks when the pool is running.
gen=0
```

Generate a long random RPC password:

```bash
openssl rand -hex 32
```

Start the daemon and verify it answers RPC:

```bash
pearld -daemon
sleep 5
pearld getblockchaininfo | jq
```

Expected response:

```json
{
  "chain": "regtest",
  "blocks": 0,
  "headers": 0,
  "bestblockhash": "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206",
  "difficulty": 4.656542373906925e-10,
  "mediantime": 1718986000,
  "verificationprogress": 1,
  "initialblockdownload": false,
  "chainwork": "0000000000000000000000000000000000000000000000000000000000000002",
  "size_on_disk": 293,
  "pruned": false,
  "warnings": ""
}
```

---

## 2. Methods PearlPool uses

PearlPool calls the following JSON-RPC methods.  All are standard
methods documented in the [PRL developer reference][prl-rpc].

[prl-rpc]: https://github.com/pearl-research-labs/pearl/blob/master/doc/rpc.md

| Method | Direction | Used for | Example |
|--------|-----------|----------|---------|
| `getblocktemplate` | pool → daemon | Poll a new block template whenever the chain tip advances | `{"jsonrpc": "1.0", "id": "pp", "method": "getblocktemplate", "params": []}` |
| `submitblock` | pool → daemon | Broadcast a found block to the PRL network | `{"method": "submitblock", "params": ["0700...hex..."]}` |
| `getblock` | pool → daemon | Confirm a submitted block was accepted (poll after broadcast) | `{"method": "getblock", "params": ["<hash>", false]}` |
| `getbalance` | pool → daemon | Track the operator wallet's PRL balance | `{"method": "getbalance"}` |
| `sendtoaddress` | pool → daemon | Pay out a miner (PRL atomic units) | `{"method": "sendtoaddress", "params": ["prl1pMINER", 12.34, "", "", false]}` |
| `gettransaction` | pool → daemon | Look up the txid of a recent payout (confirm / audit) | `{"method": "gettransaction", "params": ["<txid>"]}` |
| `getnetworkinfo` | pool → daemon | Display network hashrate / version in the dashboard | `{"method": "getnetworkinfo"}` |
| `getmininginfo` | pool → daemon | Current network difficulty + height | `{"method": "getmininginfo"}` |

All calls are `POST /` with HTTP basic auth (`rpcuser:rpcpassword`) and
a JSON body.  Timeouts are 10 s per call with 2 retries on `ECONNRESET`
or `ETIMEDOUT`.  See `src/scanner.js` and `src/pool.js:sendPayoutTx`.

---

## 3. Sample responses (real calls, redacted addresses)

### `getblocktemplate` (truncated)

Request:

```json
{"jsonrpc":"1.0","id":"pearlpool","method":"getblocktemplate","params":[]}
```

Response:

```json
{
  "capabilities": ["longpoll", "coinbasetxn", "coinbasevalue", "version",
                   "time", "previousblockhash", "transactions", "merkle"],
  "version": 1,
  "previousblockhash": "0000000000000a2e...6c6f5e7c",
  "transactions": [ ... ],
  "coinbaseaux": { "flags": "" },
  "coinbasevalue": 5000000000,
  "coinbasetxn": { ... },
  "target": "0000000000000000000000000000000000000000000000000fffff00000000",
  "mintime": 1718986000,
  "mutable": ["time", "transactions", "prevblock"],
  "noncerange": "00000000ffffffff",
  "sigoplimit": 20000,
  "sizelimit": 1000000,
  "weightlimit": 4000000,
  "curtime": 1718986050,
  "bits": "1a0fffff",
  "height": 101
}
```

### `submitblock`

Request (the block hex is the same one the pool built on top of the
template above):

```json
{"jsonrpc":"1.0","id":"pearlpool","method":"submitblock","params":["07000000...76e1f8"]}
```

Response on success:

```json
null
```

A `null` return value means the daemon accepted the block and will
relay it to peers.  The block hash and confirmations will appear in
`getblock` after the next polling cycle.

Response on rejection (block was already mined by another pool —
`stale-work` orphan):

```json
"duplicate"
```

Other rejection codes we have seen and what we do about them:

| Code | Meaning | Pool action |
|------|---------|-------------|
| `null` | Block accepted | Mark as confirmed, trigger PPLNS payout |
| `duplicate` | Block was already submitted | Mark as orphan, skip payout |
| `rejected` | Coinbase / sig / size check failed | Log, mark as orphan, page operator |
| `bad-cb-header` / `bad-cb-amount` | Coinbase inconsistent with template | Critical — halt pool, alert operator |
| `in-concurrency-limit` | Daemon busy; try again | Exponential backoff, retry up to 3× |

### `sendtoaddress` (miner payout)

Request (paying 12.34 PRL to a miner):

```json
{"jsonrpc":"1.0","id":"pearlpool","method":"sendtoaddress",
 "params":["prl1pMINER_REDACTED", 1.23400000, "", "", false]}
```

Response (the txid that goes into the payout history):

```json
"4a3b1c8d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b"
```

We then immediately look up the transaction to capture the fee and
number of confirmations:

```json
{
  "amount": 1.23400000,
  "fee": -0.00001000,
  "confirmations": 0,
  "txid": "4a3b1c8d2e9f0a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b",
  "time": 1718986120,
  "timereceived": 1718986120,
  "details": [
    {
      "address": "prl1pMINER_REDACTED",
      "category": "send",
      "amount": -1.23400000,
      "vout": 0,
      "fee": -0.00001000
    }
  ]
}
```

---

## 4. Error handling, retry, and verification

PearlPool wraps every daemon call in a small helper that handles the
three failure modes we actually see in production:

1. **Network / connection failure** (daemon down, port unreachable)
   → Log, back off 5 s, retry up to 3 times, then surface to caller.
2. **RPC error response** (e.g. `submitblock` returns `"rejected"`)
   → Hand the error code to the caller; the payout / block ledger
     records it as an orphan / failure and continues.
3. **Successful response, but unexpected shape** (e.g. `getblocktemplate`
   returns `coinbasevalue: 0` because the daemon is still syncing)
   → Skip this template, try again on the next poll.

Payout verification: every `sendtoaddress` response is followed by a
`gettransaction(txid)` call 30 s later to capture the fee.  If the
transaction never appears, the payout is marked **unconfirmed** in the
ledger and a follow-up `gettransaction` is scheduled 10 minutes later.
After 24 hours of unconfirmed status, the operator is alerted and the
payout is manually investigated (this has happened exactly once in our
testing, on regtest when the daemon was mid-restart).

---

## 5. Pool-side configuration

Pass the RPC details to PearlPool on the command line:

```bash
node src/pool.js \
  --wallet prl1pOPERATOR \
  --rpc-url http://127.0.0.1:9933 \
  --rpc-user pearlpool \
  --rpc-password "$(cat ~/.pearl/rpcpassword)"
```

Or via environment variables (recommended for systemd / Docker):

```bash
export PEARLPOOL_RPC_URL=http://127.0.0.1:9933
export PEARLPOOL_RPC_USER=pearlpool
export PEARLPOOL_RPC_PASSWORD='...'
./start.sh
```

The pool will refuse to start if `--rpc-url` is unreachable for more
than 30 seconds at boot.  After that, daemon outages are tolerated —
the scanner retries indefinitely and the pool keeps accepting shares
against the last known block template (miners see stale-work rejections
until the daemon comes back).

---

## 6. Testnet / regtest workflow

For local development against a deterministic regtest node:

```bash
# Terminal 1 — daemon
pearld -regtest -daemon -rpcuser=dev -rpcpassword=dev -rpcport=9933

# Terminal 2 — mine a few blocks so the chain has a tip to build on
PEARL_CLI="pearl-cli -regtest -rpcuser=dev -rpcpassword=dev"
$PEARL_CLI generate 20

# Terminal 3 — start the pool
node src/pool.js \
  --wallet $($PEARL_CLI getnewaddress) \
  --rpc-url http://127.0.0.1:9933 \
  --rpc-user dev \
  --rpc-password dev

# Terminal 4 — point a miner at it
stratum-miner --pool stratum+tcp://127.0.0.1:3333 --wallet prl1pTEST
```

When the miner finds a share that meets the regtest difficulty
(intentionally low — `bits: 1a0fffff`), `submitblock` returns `null`
and the payout cycle fires within `payout-interval` seconds (default
3600 s, override with `--payout-interval 30` for testing).

---

## See also

- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — how the RPC layer fits into
  the rest of the pool.
- [docs/FEE-STRUCTURE.md](FEE-STRUCTURE.md) — the `sendtoaddress` flow
  per block, with a worked example.
- [SECURITY.md](../SECURITY.md) — RPC authentication, TLS, and threat
  model.
