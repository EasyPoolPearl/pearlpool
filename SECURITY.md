# Security

This document describes PearlPool's security model, how to report a
vulnerability, and the threat model the project is designed to defend
against.

## Supported versions

| Version | Supported          |
|---------|--------------------|
| 0.2.x   | :white_check_mark:  |
| 0.1.x   | :x:                |

The 0.1.x line had a number of operational issues (see
[CHANGELOG.md](CHANGELOG.md)) and is no longer maintained.  Operators
running 0.1.x are encouraged to upgrade.

## Threat model

PearlPool is a public Stratum mining pool.  It is exposed to the open
internet on its Stratum port and on its HTTP API port.  The threat model
covers:

1. **Malicious miners** submitting invalid shares, replaying nonces, or
   trying to manipulate share accounting.
2. **Network attackers** trying to submit forged `mining.notify` jobs,
   intercept share submissions, or DoS the Stratum/HTTP endpoints.
3. **Operator-side compromise** — anyone with shell access to the
   machine running PearlPool can read its configuration and (if
   configured) the daemon RPC credentials.
4. **Upstream daemon compromise** — PearlPool trusts the connected PRL
   daemon for block templates and payout broadcasting.  A compromised
   daemon can publish malicious templates or withhold payouts.

Out of scope:

- **Client-side wallet security.** PearlPool never holds miner funds;
  payouts are sent directly from the daemon's wallet to the miner's
  address.  Miners are responsible for the security of their own wallet.
- **The PRL protocol itself.** Bugs in the underlying PRL consensus
  rules or the daemon implementation are reported upstream to the PRL
  core developers.

## Defences

### Share validation

Every share is validated against the share difficulty target using the
standard coinbase + merkle-root + 80-byte-header reconstruction.  See
`validateShare()` in `src/pool.js`.  Validation enforces:

- All `mining.submit` params present and well-formed.
- The job is still active (not yet evicted from the LRU cache).
- The nonce has not been seen before for this job (replay protection).
- The reconstructed header hash meets the share difficulty target.

Duplicate-share detection uses a per-connection `Set` capped at 10 000
entries, with FIFO eviction to bound memory.

### Stratum hardening

- `setKeepAlive(true, 60000)` on every connection.
- Malformed JSON is silently dropped — no crash, no error response (to
  avoid amplification attacks).
- Stratum client IDs are bounded by the LRU job cache (100 entries).

### Daemon RPC authentication

The PRL daemon must be run with a username and password (`rpcuser` and
`rpcpassword` in its config).  PearlPool reads these via the
`PEARLPOOL_RPC_USER` and `PEARLPOOL_RPC_PASSWORD` environment variables
or the `--rpc-user` / `--rpc-password` CLI flags, and sends them over
HTTP Basic Auth on every call.

**Never run the daemon with no RPC auth on a publicly-reachable host.**
An attacker with RPC access can drain the pool's coinbase wallet.

### HTTP API

- The HTTP API listens on `0.0.0.0` by default so dashboards can be served
  to external users.  If you do not want public dashboards, bind to
  `127.0.0.1` via reverse proxy.
- CORS is open (`Access-Control-Allow-Origin: *`) by design — the API
  contains only public pool stats, no miner credentials or admin
  endpoints.
- **No write endpoints are exposed.**  The API is read-only.

### Payout isolation

The pool's coinbase wallet is the operator's wallet.  PearlPool never
holds miner funds; payouts are sent directly from the daemon's wallet to
the miner's address via `sendtoaddress`.  The miner's private keys are
never sent to the pool — miners mine to their own wallet address.

### Operator configuration

The operator's wallet address is read from `--wallet` or the
`PEARLPOOL_WALLET` env var.  This address receives the 1.5% operator
fee.  **Operators should never share this address with anyone they do
not trust with control of the pool's earnings.**

## Reporting a vulnerability

Please report security issues to **<security@pearlpool.example>** (PGP
key on request).  Do not file a public GitHub issue.

We will acknowledge receipt within 48 hours and aim to provide a fix
or mitigation within 7 days for high-severity issues.

## Audit history

PearlPool has not yet been audited by a third-party security firm.
The 0.2.x line is the first release candidate intended for external
audit.  If you are interested in performing an audit, please reach out
via the address above.

## Acknowledgements

The threat model and defences here draw heavily on the operational
post-mortems published by [ckpool](https://bitcoinknots.org/) and
[Braiins Academy's pool-security guide](https://braiins.com/academy).
Those documents are recommended reading for any operator running a
public mining pool.