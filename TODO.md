# PearlPool TODO

This file tracks the open work required to take PearlPool from its
current **experimental / alpha** state to a hardened production pool.
Items are ordered roughly by priority.  See [docs/ROADMAP.md](docs/ROADMAP.md)
for the long-form version with rationale and design notes.

## High priority — correctness & on-chain integration

- [ ] **PRL Blake3 header validation.**  Replace the SHA-256d placeholder
      in `src/stratum.js:hashHeader()` and `src/pool.js:hashHeader()`
      with a Blake3 implementation once the PRL mainnet algorithm
      is finalized.  The hash function is the only PRL-specific part
      of the share-validation pipeline, so this is a self-contained
      change.
- [ ] **Real `submitblock` validation against mainnet.**  Current code
      calls `submitblock` and surfaces the daemon's return value, but
      we do not yet drive a real PRL node from CI to assert that
      submitted blocks are accepted.  Add a regtest harness.
- [ ] **Real wallet payout RPC integration test.**  The `sendtoaddress`
      path is implemented (`src/pool.js:sendPayoutTx`) but the
      integration test against a live daemon is pending.
- [ ] **End-to-end integration test against a local PRL regtest node.**
      Spin up `pearld -regtest` in CI, submit a block, and assert the
      full pool → PPLNS → on-chain payout round-trip.

## High priority — storage & observability

- [ ] **Persistent database backend.**  Replace the in-memory `Store`
      with a SQLite (or PostgreSQL) backend so process restarts do
      not lose pending balances.  Required before pointing real
      hashrate at the pool.  A thin **JSON snapshot** layer
      (`lib/persistence/json-snapshot.js`, used by
      `store.persist` / `store.restoreFromFile` and called every 60 s
      + on clean shutdown) is now in place as the basis for this swap;
      see [Production Safety Notes](README.md#production-safety-notes)
      for the gap it does and does not cover.
- [ ] **Pool-fee transparency dashboard panel.**  Expose the operator
      reserve balance, the per-block fee breakdown, and the
      cumulative reserve drawdown on a public `/api/fee-stats` endpoint
      and a dedicated dashboard panel.
- [ ] **Stratum socket DoS hardening.**  Per-IP rate limits, max
      connections per IP, and a max-subscriptions-per-connection cap.

## Medium priority — deployment & developer experience

- [ ] **Docker compose full stack.**  `docker-compose.yml` with three
      services: pool, PRL daemon (regtest by default, mainnet via
      profile), and nginx for TLS / reverse proxy.  One-command bring-up
      for evaluators.
- [ ] **CI workflow extension.**  GitHub Actions currently runs the
      unit test suite.  Add lint, coverage, and (eventually) the
      regtest integration test from a separate job.
- [ ] **Operator wallet multi-sig support.**  The operator wallet is
      currently a single P2PKH/P2SH address.  Pluggable signer
      interface (local key, HSM, remote signer) is on the roadmap.

## Low priority — nice-to-have

- [ ] **Stratum+TLS support** (`stratum+ssl://`).
- [ ] **Multi-coin support** — abstract the chain adapter so the same
      pool can run against a Pearl regtest and a Bitcoin regtest
      from the same binary.
- [ ] **WebSocket push** to the dashboard instead of polling.

## Non-goals (intentionally out of scope)

- Mobile mining apps.  PearlPool is a stratum pool, not a miner.
- Pool-to-pool merged mining.  Single-chain only for now.
- ASIC firmware / hardware.  We integrate with existing miners via
  stratum; we do not build miners.

## Reporting issues

Open an issue at https://github.com/EasyPoolPearl/pearlpool/issues
or, for security issues, follow the disclosure process in
[SECURITY.md](SECURITY.md).
