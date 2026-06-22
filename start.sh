#!/bin/bash
# PearlPool launcher — edit the wallet address below before running.
#
# This wallet receives the operator fee (1.0% base + 0.5% tx-fee reserve
# = 1.5% total) from every block found by the pool.  See
# docs/FEE-STRUCTURE.md for the breakdown.

set -euo pipefail

WALLET="prl1pzls8ulz3h4w0e9vgdqsnqtmvvf9rnjjk7al35atser9u67nhsq6q0ae4zv"

# Optional: source a pool.env file with overrides (RPC creds, ports, etc.)
if [ -f ./pool.env ]; then
  # shellcheck disable=SC1091
  set -a
  source ./pool.env
  set +a
fi

exec node src/pool.js --wallet "$WALLET" "$@"