#!/bin/bash
# PearlPool launcher — edit the wallet address below before running
WALLET="prl1pzls8ulz3h4w0e9vgdqsnqtmvvf9rnjjk7al35atser9u67nhsq6q0ae4zv"

exec node src/pool.js --wallet "$WALLET" "$@"
