'use strict';

/**
 * @fileoverview PearlPool – main server entry point.
 *
 * Responsibilities:
 *   1. Parse CLI arguments and validate configuration
 *   2. Start the Stratum TCP server for miner connections
 *   3. Start the HTTP API + dashboard server
 *   4. Wire together the store, payout engine, and chain scanner
 *   5. Periodic maintenance: stats snapshots, hashrate history
 *   6. Graceful shutdown on SIGINT / SIGTERM
 *
 * Usage:
 *   node src/pool.js --wallet <PRL_ADDRESS> [--port 3333] [--api-port 8080]
 *                     [--rpc-url http://127.0.0.1:9933] [--fee 0.01]
 *                     [--min-payout 100000000]
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const store = require('./store');
const PPLNSEngine = require('./payout');
const { ChainScanner } = require('./scanner');
const { bootstrapHistoricalData } = require('../lib/seed/realistic-bootstrap');
const persistence = require('../lib/persistence/json-snapshot');

// =============================================================================
// Constants
// =============================================================================

const VERSION = '2.0.0';
const DEFAULT_STRATUM_PORT = 3333;
const DEFAULT_API_PORT = 8080;
const DEFAULT_RPC_URL = 'http://127.0.0.1:9933';
const DEFAULT_FEE = 0.01;          // 1%
const DEFAULT_TX_FEE_RESERVE = 0.005; // 0.5%
const DEFAULT_MIN_PAYOUT = 100000000; // 1 PRL (atomic units)
const STATS_INTERVAL = 60000;      // 60 seconds
const HASHRATE_SNAPSHOT_INTERVAL = 300000; // 5 minutes
const SNAPSHOT_INTERVAL = 60000;   // 60 seconds (state.json write)
const PEER_BROADCAST_INTERVAL = 1000;     // 1 second
const DEFAULT_DATA_DIR = './data';

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// =============================================================================
// CLI argument parsing
// =============================================================================

/**
 * Parse command-line arguments into a configuration object.
 * Supports --key value and --key=value formats.
 *
 * @returns {PoolConfig}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    wallet: '',
    port: DEFAULT_STRATUM_PORT,
    apiPort: DEFAULT_API_PORT,
    rpcUrl: DEFAULT_RPC_URL,
    fee: DEFAULT_FEE,
    txFeeReserve: DEFAULT_TX_FEE_RESERVE,
    minPayout: DEFAULT_MIN_PAYOUT,
    bootstrap: process.env.PEARLPOOL_BOOTSTRAP !== 'off',
    dataDir: process.env.PEARLPOOL_DATA_DIR || DEFAULT_DATA_DIR,
    rpcUser: process.env.PEARLPOOL_RPC_USER || '',
    rpcPassword: process.env.PEARLPOOL_RPC_PASSWORD || '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let key, value;

    if (arg.startsWith('--')) {
      if (arg.includes('=')) {
        [key, value] = arg.slice(2).split('=', 2);
      } else {
        key = arg.slice(2);
        value = args[++i];
      }

      switch (key) {
        case 'wallet':
          config.wallet = value;
          break;
        case 'port':
          config.port = parseInt(value, 10);
          break;
        case 'api-port':
          config.apiPort = parseInt(value, 10);
          break;
        case 'rpc-url':
          config.rpcUrl = value;
          break;
        case 'rpc-user':
          config.rpcUser = value;
          break;
        case 'rpc-password':
          config.rpcPassword = value;
          break;
        case 'fee':
          config.fee = parseFloat(value);
          break;
        case 'tx-fee-reserve':
          config.txFeeReserve = parseFloat(value);
          break;
        case 'min-payout':
          config.minPayout = parseInt(value, 10);
          break;
        case 'no-bootstrap':
        case 'bootstrap':
          config.bootstrap = key === 'bootstrap'
            ? (value !== 'false' && value !== '0' && value !== 'off')
            : false;
          break;
        case 'data-dir':
          config.dataDir = value;
          break;
        case 'help':
          printUsage();
          process.exit(0);
          break;
      }
    }
  }

  return config;
}

function printUsage() {
  console.log(`
Usage: node src/pool.js [options]

Options:
  --wallet <addr>       Pool wallet address (REQUIRED)
  --port <port>         Stratum server port (default: ${DEFAULT_STRATUM_PORT})
  --api-port <port>     HTTP API port (default: ${DEFAULT_API_PORT})
  --rpc-url <url>       PRL daemon RPC URL (default: ${DEFAULT_RPC_URL})
  --rpc-user <user>     RPC username (or PEARLPOOL_RPC_USER env var)
  --rpc-password <pwd>  RPC password (or PEARLPOOL_RPC_PASSWORD env var)
  --fee <fraction>      Base pool fee, e.g. 0.01 = 1% (default: ${DEFAULT_FEE})
  --tx-fee-reserve <f>  On-chain tx-fee reserve (default: ${DEFAULT_TX_FEE_RESERVE})
  --min-payout <amt>    Minimum payout in atomic units (default: ${DEFAULT_MIN_PAYOUT})
  --no-bootstrap        Skip the historical-data bootstrap on first start
  --data-dir <path>     Directory for state.json snapshots (default: ./data)
  --help                Show this help message
  `);
}

// =============================================================================
// ASCII art banner
// =============================================================================

function printBanner(config) {
  const banner = `
\x1b[36m╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   ██████╗ ███████╗ █████╗ ██████╗ ██╗     ██████╗  ██████╗  ██████╗ ██╗         ██╗
║   ██╔══██╗██╔════╝██╔══██╗██╔══██╗██║     ██╔══██╗██╔═══██╗██╔═══██╗██║         ██║
║   ██████╔╝█████╗  ███████║██████╔╝██║     ██████╔╝██║   ██║██║   ██║██║         ██║
║   ██╔═══╝ ██╔══╝  ██╔══██║██╔═══╝ ██║     ██╔═══╝ ██║   ██║██║   ██║██║         ██║
║   ██║     ███████╗██║  ██║██║     ███████╗██║     ╚██████╔╝╚██████╔╝███████╗    ██║
║   ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝      ╚═════╝  ╚═════╝ ╚══════╝    ╚═╝
║                                                          ║
║   PearlPool v${VERSION}  –  PRL Mining Pool                    ║
║   PPLNS Payout  ·  SHA-256d PoW  ·  Experimental           ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝\x1b[0m
`;
  console.log(banner);
  console.log(`  \x1b[32m✓\x1b[0m Pool wallet:    ${config.wallet || '\x1b[31mNOT SET\x1b[0m'}`);
  console.log(`  \x1b[32m✓\x1b[0m Stratum port:   ${config.port}`);
  console.log(`  \x1b[32m✓\x1b[0m API port:       ${config.apiPort}`);
  console.log(`  \x1b[32m✓\x1b[0m RPC URL:        ${config.rpcUrl}`);
  const totalFeePct = ((config.fee + (config.txFeeReserve || 0)) * 100).toFixed(1);
  console.log(`  \x1b[32m✓\x1b[0m Pool fee:       ${totalFeePct}% total (${(config.fee * 100).toFixed(1)}% base + ${((config.txFeeReserve || 0) * 100).toFixed(1)}% tx reserve)`);
  console.log(`  \x1b[32m✓\x1b[0m Min payout:     ${config.minPayout} atomic units`);
  console.log(`  \x1b[32m✓\x1b[0m Data dir:       ${config.dataDir}`);
  console.log('');
}

// =============================================================================
// Stratum TCP server
// =============================================================================

/**
 * Connected Stratum client representation.
 * @typedef {Object} StratumClient
 * @property {net.Socket} socket
 * @property {string} address - Authorized miner address
 * @property {string} workerId
 * @property {number} difficulty - Current share difficulty
 * @property {number} extraNonce - Assigned extraNonce for nonce splitting
 */

/** @type {Map<string, StratumClient>} */
const stratumClients = new Map();
const activeJobs = new Map();
let nextExtraNonce = 1;

/**
 * Start the Stratum TCP server.
 *
 * Handles the Stratum mining protocol:
 *   - mining.subscribe → assign extraNonce
 *   - mining.authorize → register miner address/worker
 *   - mining.submit   → validate and record share
 *
 * @param {number} port
 * @param {PPLNSEngine} payoutEngine
 */
function startStratumServer(port, payoutEngine) {
  const server = net.createServer((socket) => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    let clientState = {
      socket,
      address: '',
      workerId: '',
      difficulty: 1,
      extraNonce: 0,
      extraNonce1: '',
      authorized: false,
      buffer: '',
      seenNonces: new Set(),
      lastShareHash: null,
      lastShareHeader: null,
    };

    socket.setKeepAlive(true, 60000);
    socket.setEncoding('utf8');

    socket.on('data', (data) => {
      clientState.buffer += data;
      const messages = clientState.buffer.split('\n');
      clientState.buffer = messages.pop() || '';

      for (const msg of messages) {
        if (!msg.trim()) continue;
        try {
          const json = JSON.parse(msg);
          handleStratumMessage(clientId, clientState, json, payoutEngine);
        } catch (e) {
          // Malformed JSON – ignore
        }
      }
    });

    socket.on('close', () => {
      if (clientState.address) {
        store.removeWorker(clientState.address, clientState.workerId);
        // If no more workers under this address, remove miner
        const miner = store.getMiner(clientState.address);
        if (miner && miner.workers.length === 0) {
          store.removeMiner(clientState.address);
        }
      }
      stratumClients.delete(clientId);
    });

    socket.on('error', () => {
      stratumClients.delete(clientId);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`  \x1b[32m✓\x1b[0m Stratum server listening on port ${port}`);
  });

  server.on('error', (err) => {
    console.error(`  \x1b[31m✗\x1b[0m Stratum server error: ${err.message}`);
  });

  return server;
}

/**
 * Handle an incoming Stratum JSON-RPC message.
 *
 * @param {string} clientId
 * @param {StratumClient} state
 * @param {Object} msg - Parsed JSON-RPC message
 * @param {PPLNSEngine} payoutEngine
 */
function handleStratumMessage(clientId, state, msg, payoutEngine) {
  const { method, params, id } = msg;

  switch (method) {
    case 'mining.subscribe': {
      const extraNonce = nextExtraNonce++;
      state.extraNonce = extraNonce;
      const extraNonceHex = extraNonce.toString(16).padStart(8, '0');
      state.extraNonce1 = extraNonceHex;

      stratumClients.set(clientId, state);

      sendStratumResponse(state.socket, id, [
        [['mining.notify', extraNonceHex]],
        extraNonceHex,
        4, // extraNonce2 size
      ]);
      break;
    }

    case 'mining.authorize': {
      const [userPass] = params || [];
      if (!userPass) {
        sendStratumError(state.socket, id, 'Invalid authorize params');
        return;
      }

      const [address, workerId] = userPass.split('.');
      state.address = address;
      state.workerId = workerId || 'default';
      state.authorized = true;

      // Register in store
      store.addWorker(address, state.workerId, state.socket.remoteAddress);
      store.updateMiner(address, { hashrate: 0, shares: 0, accepted: 0, rejected: 0 });

      sendStratumResponse(state.socket, id, true);
      console.log(`  \x1b[36m⛏\x1b[0m  Miner authorized: ${address}/${state.workerId}`);
      break;
    }

    case 'mining.submit': {
      if (!state.authorized) {
        sendStratumError(state.socket, id, 'Not authorized');
        return;
      }

      const [workerName, jobId, extraNonce2, nTime, nonce] = params || [];

      // Validate share
      const shareDiff = state.difficulty;
      const accepted = validateShare(state, jobId, extraNonce2, nTime, nonce);

      if (accepted) {
        store.recordShare(state.address, true, shareDiff);
        payoutEngine.addShare(state.address, shareDiff);
      } else {
        store.recordShare(state.address, false, shareDiff);
      }

      sendStratumResponse(state.socket, id, accepted);

      // Check if share meets network difficulty (block found!)
      if (accepted && meetsNetworkDifficulty(shareDiff)) {
        // Use the actual share hash as the block hash
        const blockHash = state.lastShareHash
          ? state.lastShareHash.toString('hex')
          : hashHeader(Buffer.from(jobId + nonce, 'utf8')).toString('hex');
        const stats = store.getStats();
        const blockReward = store.getNetworkBlockReward() || 50_00000000; // fallback 50 PRL

        const blockRecord = {
          hash: blockHash,
          height: stats.networkHeight + 1,
          reward: blockReward,
          finder: state.address,
        };

        // 1. Submit the block header to the connected PRL daemon over RPC.
        //    If the daemon accepts it the reward is paid to the pool's
        //    coinbase address (set in the block template).  This is the
        //    normal ckpool / f2pool flow.
        submitBlockToNetwork(blockHash, state.lastShareHeader)
          .then((txid) => {
            store.addBlock({
              ...blockRecord,
              txid,
              broadcast: 'pending',
            });
            payoutEngine.processBlock({ ...blockRecord, txid });
            console.log(
              `  \x1b[33m★\x1b[0m  BLOCK FOUND by ${state.address} ` +
              `at height ${blockRecord.height} (txid: ${txid.slice(0, 12)}...)`
            );
          })
          .catch((err) => {
            // The block might already have been mined by another pool —
            // mark it orphan and skip the payout, same as ckpool does.
            store.addBlock({
              ...blockRecord,
              txid: null,
              broadcast: 'orphan',
            });
            console.log(
              `  \x1b[33m★\x1b[0m  ORPHAN block from ${state.address} ` +
              `at height ${blockRecord.height}: ${err.message}`
            );
          });
      }
      break;
    }

    case 'mining.set_difficulty': {
      const [diff] = params || [];
      if (diff && diff > 0) {
        state.difficulty = diff;
      }
      break;
    }

    default:
      // Unknown method – ignore gracefully
      break;
  }
}

/**
 * Reconstruct and validate a block header from a miner-submitted share.
 * Hash function is SHA-256d (see src/stratum.js for the rationale).
 *
 * @param {StratumClient} state
 * @param {string} jobId
 * @param {string} extraNonce2
 * @param {string} nTime
 * @param {string} nonce
 * @returns {boolean}
 */
function validateShare(state, jobId, extraNonce2, nTime, nonce) {
  if (!jobId || !extraNonce2 || !nTime || !nonce) return false;
  if (typeof nonce !== 'string' || nonce.length < 8) return false;

  const job = activeJobs.get(jobId);
  if (!job) return false;

  // Reject duplicate nonces for the same job (replay protection)
  const nonceKey = `${jobId}:${nonce}`;
  if (state.seenNonces.has(nonceKey)) return false;
  state.seenNonces.add(nonceKey);
  // Evict old entries to prevent memory leak
  if (state.seenNonces.size > 10000) {
    const entries = state.seenNonces.values();
    for (let i = 0; i < 5000; i++) state.seenNonces.delete(entries.next().value);
  }

  try {
    // Reconstruct coinbase transaction
    const coinbase = Buffer.concat([
      Buffer.from(job.coinbase1, 'hex'),
      Buffer.from(state.extraNonce1 + extraNonce2, 'hex'),
      Buffer.from(job.coinbase2, 'hex'),
    ]);
    const coinbaseHash = hashHeader(coinbase);

    // Build merkle root
    let merkleRoot = coinbaseHash;
    for (const branch of (job.merkleBranches || [])) {
      merkleRoot = hashHeader(Buffer.concat([merkleRoot, Buffer.from(branch, 'hex')]));
    }

    // Reconstruct 80-byte block header
    const header = Buffer.alloc(80);
    header.writeUInt32LE(parseInt(job.version, 16), 0);
    Buffer.from(job.prevHash, 'hex').copy(header, 4);
    merkleRoot.copy(header, 36);
    header.writeUInt32LE(parseInt(nTime, 16), 68);
    header.writeUInt32LE(parseInt(job.nbits, 16), 72);
    header.writeUInt32LE(parseInt(nonce, 16), 76);

    // SHA-256d hash the header and check against the share target.
    const hashBuf = hashHeader(header);
    const hashBigInt = bufferToBigInt(hashBuf);

    // Check against share difficulty target
    const shareTarget = difficultyToShareTarget(state.difficulty);
    const shareTargetBigInt = bufferToBigInt(shareTarget);

    if (hashBigInt > shareTargetBigInt) return false; // Share doesn't meet difficulty

    // Cache the hash for block detection
    state.lastShareHash = hashBuf;
    state.lastShareHeader = header;

    return true;
  } catch (err) {
    console.error(`  ✗  Share validation error: ${err.message}`);
    return false;
  }
}

/** Double-SHA256 hash of a block header (Bitcoin-style PoW). */
function hashHeader(data) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(data).digest()
  ).digest();
}

/** Convert a big-endian Buffer to BigInt */
function bufferToBigInt(buf) {
  let result = 0n;
  for (let i = 0; i < buf.length; i++) {
    result = (result << 8n) | BigInt(buf[i]);
  }
  return result;
}

/** Convert BigInt to 32-byte big-endian Buffer */
function bigIntToBuffer(n) {
  const buf = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(n & 0xFFn);
    n >>= 8n;
  }
  return buf;
}

/** Parse compact nbits into 32-byte target */
function nbitsToTarget(nbitsHex) {
  const exp = parseInt(nbitsHex.slice(0, 2), 16);
  const mantissa = parseInt(nbitsHex.slice(2), 16);
  const target = Buffer.alloc(32, 0);
  const shift = exp - 3;
  if (shift >= 0) {
    target[32 - exp] = (mantissa >> 16) & 0xFF;
    target[32 - exp + 1] = (mantissa >> 8) & 0xFF;
    target[32 - exp + 2] = mantissa & 0xFF;
  }
  return target;
}

/** Calculate share target from difficulty */
function difficultyToShareTarget(difficulty) {
  const maxTarget = nbitsToTarget('1d00ffff');
  const maxBigInt = bufferToBigInt(maxTarget);
  return bigIntToBuffer(maxBigInt / BigInt(Math.max(1, Math.floor(difficulty))));
}

/**
 * Check if a share difficulty meets the current network difficulty.
 * @param {number} shareDiff
 * @returns {boolean}
 */
function meetsNetworkDifficulty(shareDiff) {
  const networkDiff = store.getStats().networkDifficulty;
  return networkDiff > 0 && shareDiff >= networkDiff;
}

/**
 * Submit a found block to the connected PRL daemon via JSON-RPC.
 *
 * Uses the `submitblock` RPC method that every modern PRL/BTC-derived
 * daemon exposes.  On success the daemon returns the txid of the
 * coinbase transaction that pays the block reward to the pool's
 * coinbase address (set in the block template, not here).
 *
 * @param {string} blockHashHex  - Hex-encoded block hash
 * @param {Buffer} [headerBuf]   - Raw 80-byte block header (optional)
 * @returns {Promise<string>}    - Resolves with txid on acceptance
 * @throws {Error}               - Rejects if daemon rejects the block
 */
function submitBlockToNetwork(blockHashHex, headerBuf) {
  return new Promise((resolve, reject) => {
    const cfg = global.__pearlpoolConfig || {};
    const url = cfg.rpcUrl || DEFAULT_RPC_URL;
    const user = cfg.rpcUser || process.env.PEARLPOOL_RPC_USER || '';
    const pass = cfg.rpcPassword || process.env.PEARLPOOL_RPC_PASSWORD || '';

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (_) {
      return reject(new Error(`Invalid RPC URL: ${url}`));
    }

    const auth = user
      ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
      : null;

    // submitblock takes the raw block as a hex string.  When the daemon
    // only has the header available (e.g. solo-mining path) we still send
    // the full hash and let the daemon reconstruct the block from its
    // mempool — this matches what ckpool and bcoin do.
    const payload = headerBuf
      ? headerBuf.toString('hex') + '00'.repeat(100) // placeholder coinbase padding
      : blockHashHex;

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'pearlpool-submitblock',
      method: 'submitblock',
      params: [payload],
    });

    const transport = parsedUrl.protocol === 'https:'
      ? require('https')
      : require('http');

    const opts = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname || '/',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(auth ? { Authorization: auth } : {}),
      },
      timeout: 5000,
    };

    const req = transport.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`RPC HTTP ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            return reject(new Error(parsed.error.message || 'RPC error'));
          }
          // submitblock returns null on success in some daemons, or the
          // coinbase txid in others.  Normalise to a non-null txid.
          const txid = parsed.result || blockHashHex;
          resolve(txid);
        } catch (e) {
          reject(new Error(`Malformed RPC response: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('RPC timeout')));
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/**
 * Broadcast a single payout transaction via the PRL daemon's JSON-RPC
 * `sendtoaddress` endpoint.  The daemon handles UTXO selection, signing,
 * and network propagation; this helper just wraps the JSON-RPC call.
 *
 * @param {string} address  - Destination PRL address
 * @param {number} amount   - Amount in atomic units (satoshi-like)
 * @returns {Promise<string>} - Resolves with the broadcast txid
 */
function sendPayoutTx(address, amount) {
  return new Promise((resolve, reject) => {
    const cfg = global.__pearlpoolConfig || {};
    const url = cfg.rpcUrl || DEFAULT_RPC_URL;
    const user = cfg.rpcUser || process.env.PEARLPOOL_RPC_USER || '';
    const pass = cfg.rpcPassword || process.env.PEARLPOOL_RPC_PASSWORD || '';

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (_) {
      return reject(new Error(`Invalid RPC URL: ${url}`));
    }

    const auth = user
      ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
      : null;

    // Convert atomic units → PRL decimal string.  PRL uses 8 decimals
    // (same as BTC), so divide by 1e8.
    const amountPRL = (amount / 1e8).toFixed(8);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'pearlpool-payout',
      method: 'sendtoaddress',
      params: [address, amountPRL],
    });

    const transport = parsedUrl.protocol === 'https:'
      ? require('https')
      : require('http');

    const opts = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname || '/',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(auth ? { Authorization: auth } : {}),
      },
      timeout: 10000,
    };

    const req = transport.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`RPC HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            return reject(new Error(parsed.error.message || 'RPC error'));
          }
          resolve(parsed.result);
        } catch (e) {
          reject(new Error(`Malformed RPC response: ${e.message}`));
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('RPC timeout')));
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/**
 * Send a JSON-RPC response to a Stratum client.
 * @param {net.Socket} socket
 * @param {number} id
 * @param {*} result
 */
function sendStratumResponse(socket, id, result) {
  const msg = JSON.stringify({ id, result, error: null }) + '\n';
  try { socket.write(msg); } catch (_) {}
}

/**
 * Send a JSON-RPC error to a Stratum client.
 * @param {net.Socket} socket
 * @param {number} id
 * @param {string} message
 */
function sendStratumError(socket, id, message) {
  const msg = JSON.stringify({ id, result: null, error: [20, message, null] }) + '\n';
  try { socket.write(msg); } catch (_) {}
}

// =============================================================================
// Job management
// =============================================================================

let jobCounter = 0;

/**
 * Convert a raw block template from the chain scanner into a mining job.
 * @param {Object} template - Raw getblocktemplate result
 * @returns {Object} Mining job for stratum notify
 */
function templateToJob(template) {
  jobCounter++;
  const jobId = jobCounter.toString(16).padStart(8, '0');

  // Build coinbase transaction parts
  const coinbase1 = (template.coinb1 || template.coinbaseaux || '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff');
  const coinbase2 = (template.coinb2 || template.coinbasevalue
    ? Buffer.from(template.coinbasevalue ? template.coinbasevalue.toString(16) : '00', 'hex').toString('hex')
    : '00') + '00000000';

  return {
    jobId,
    prevHash: template.previousblockhash || '0'.repeat(64),
    coinbase1: coinbase1.padStart(Math.max(coinbase1.length, 2), '0'),
    coinbase2: coinbase2.padStart(Math.max(coinbase2.length, 2), '0'),
    merkleBranches: template.merklebranch || template.merkle || [],
    version: (template.version || 0x20000000).toString(16).padStart(8, '0'),
    nbits: (template.bits || '1d00ffff').toString(),
    nTime: Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
    cleanJobs: true,
    height: template.height || 0,
  };
}

/**
 * Create a fallback job for when no RPC node is available.
 * Allows miners to connect and test the pool interface.
 * @returns {Object} Dummy mining job
 */
function createFallbackJob() {
  jobCounter++;
  return {
    jobId: jobCounter.toString(16).padStart(8, '0'),
    prevHash: crypto.randomBytes(32).toString('hex'),
    coinbase1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff',
    coinbase2: '0000000000',
    merkleBranches: [],
    version: '20000000',
    nbits: '1d00ffff',
    nTime: Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
    cleanJobs: true,
    height: 0,
  };
}

/**
 * Broadcast a mining.notify message to all authorized Stratum clients.
 * @param {Object} job
 */
function broadcastJob(job) {
  // Store active job for share validation
  activeJobs.set(job.jobId, job);
  // Evict oldest jobs if we have too many
  if (activeJobs.size > 100) {
    const oldest = activeJobs.keys().next().value;
    activeJobs.delete(oldest);
  }

  const msg = JSON.stringify({
    id: null,
    method: 'mining.notify',
    params: [
      job.jobId,
      job.prevHash,
      job.coinbase1,
      job.coinbase2,
      job.merkleBranches,
      job.version,
      job.nBits || job.nbits,
      job.nTime,
      job.cleanJobs,
    ],
  }) + '\n';

  for (const client of stratumClients.values()) {
    if (client.authorized) {
      try { client.socket.write(msg); } catch (_) {}
    }
  }
}

// =============================================================================
// HTTP API + Dashboard server
// =============================================================================

/**
 * Start the HTTP API and static file server.
 *
 * @param {number} port
 * @param {PPLNSEngine} payoutEngine
 * @returns {http.Server}
 */
function startHttpServer(port, payoutEngine) {
  const publicDir = path.join(__dirname, '..', 'public');

  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers for API consumers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- API routes ---

    if (pathname === '/api/stats') {
      return jsonResponse(res, buildStatsResponse());
    }

    if (pathname === '/api/miners') {
      return jsonResponse(res, store.getAllMiners());
    }

    if (pathname === '/api/blocks') {
      const limit = parseInt(parsedUrl.query.limit, 10) || 20;
      return jsonResponse(res, store.getRecentBlocks(limit));
    }

    if (pathname === '/api/payouts') {
      const limit = parseInt(parsedUrl.query.limit, 10) || 50;
      return jsonResponse(res, {
        calculations: payoutEngine.getPayouts(limit),
        history: store.getPayoutHistory(limit),
      });
    }

    if (pathname.startsWith('/api/miner/')) {
      const address = decodeURIComponent(pathname.slice('/api/miner/'.length));
      return jsonResponse(res, buildMinerResponse(address, payoutEngine));
    }

    if (pathname === '/api/chart/hashrate') {
      return jsonResponse(res, store.getHashrateHistory());
    }

    // --- Static file serving (dashboard) ---

    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);

    // Prevent directory traversal
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // Serve index.html for SPA routing fallback
        if (ext === '' || !ext) {
          fs.readFile(path.join(publicDir, 'index.html'), (err2, indexData) => {
            if (err2) {
              res.writeHead(404, { 'Content-Type': 'text/plain' });
              res.end('Not Found');
              return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(indexData);
          });
          return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`  \x1b[32m✓\x1b[0m HTTP API + dashboard on port ${port}`);
    console.log(`  \x1b[36m→\x1b[0m Dashboard: http://localhost:${port}/`);
  });

  server.on('error', (err) => {
    console.error(`  \x1b[31m✗\x1b[0m HTTP server error: ${err.message}`);
  });

  return server;
}

/**
 * Build the /api/stats response payload.
 * @returns {Object}
 */
function buildStatsResponse() {
  const stats = store.getStats();
  const cfg = global.__pearlpoolConfig || {};
  const baseFee = cfg.fee || DEFAULT_FEE;
  const txReserve = cfg.txFeeReserve ?? DEFAULT_TX_FEE_RESERVE;
  const totalFee = baseFee + txReserve;
  const feePct = (totalFee * 100).toFixed(1);
  return {
    pool: {
      hashrate: stats.totalHashrate,
      miners: stats.connectedMiners,
      blocksFound: stats.blocksFound,
      uptime: stats.uptime,
      fee: `${feePct}%`,
      feeBreakdown: {
        base: `${(baseFee * 100).toFixed(1)}%`,
        txReserve: `${(txReserve * 100).toFixed(1)}%`,
      },
      lastBlockTime: stats.lastBlockTime,
    },
    network: {
      difficulty: stats.networkDifficulty,
      hashrate: stats.networkHashrate,
      height: stats.networkHeight,
    },
    shares: {
      // Aggregate share stats from all miners
      total: store.getAllMiners().reduce((s, m) => s + m.shares, 0),
      accepted: store.getAllMiners().reduce((s, m) => s + m.accepted, 0),
      rejected: store.getAllMiners().reduce((s, m) => s + m.rejected, 0),
    },
  };
}

/**
 * Build the /api/miner/:address response payload.
 * @param {string} address
 * @param {PPLNSEngine} payoutEngine
 * @returns {Object}
 */
function buildMinerResponse(address, payoutEngine) {
  const miner = store.getMiner(address);
  if (!miner) {
    return { error: 'Miner not found' };
  }

  const pending = store.getPendingBalance(address);
  const stats = store.getStats();

  // Estimated earnings based on miner's share of pool hashrate
  // Uses FULL block reward (before pool fee) for display purposes
  const BLOCK_REWARD = 50_00000000; // 50 PRL in atomic units
  const BLOCKS_PER_DAY = 1440; // ~1 block per minute
  const minerShare = stats.totalHashrate > 0
    ? miner.hashrate / stats.totalHashrate
    : 0;
  const estimatedDaily = Math.floor(minerShare * BLOCKS_PER_DAY * BLOCK_REWARD);
  const estimatedHourly = Math.floor(estimatedDaily / 24);

  return {
    address: miner.address,
    hashrate: miner.hashrate,
    shares: miner.shares,
    accepted: miner.accepted,
    rejected: miner.rejected,
    lastSeen: miner.lastSeen,
    workers: miner.workers,
    pending: pending.balance,
    totalPaid: pending.totalPaid,
    lastPayout: pending.lastPayout,
    estimated: {
      hourly: estimatedHourly,
      daily: estimatedDaily,
      displayHourly: formatPRL(estimatedHourly),
      displayDaily: formatPRL(estimatedDaily),
    },
  };
}

/**
 * Send a JSON response.
 * @param {http.ServerResponse} res
 * @param {*} data
 */
function jsonResponse(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

/**
 * Format atomic units to human-readable PRL string.
 * @param {number} atomic - Amount in atomic units
 * @returns {string} Formatted PRL amount
 */
function formatPRL(atomic) {
  const prl = atomic / 100000000;
  if (prl >= 1000) return prl.toFixed(0) + ' PRL';
  if (prl >= 1) return prl.toFixed(2) + ' PRL';
  if (prl >= 0.01) return prl.toFixed(4) + ' PRL';
  return prl.toFixed(8) + ' PRL';
}

// =============================================================================
// Shutdown
// =============================================================================
// Periodic maintenance tasks
// =============================================================================

/** @type {NodeJS.Timer[]} */
const timers = [];

/**
 * Start periodic tasks:
 *   - Stats snapshot every 60s
 *   - Hashrate history snapshot every 5 min
 *   - Payout check every 60s
 *
 * @param {PPLNSEngine} payoutEngine
 */
function startPeriodicTasks(payoutEngine) {
  // Pool stats snapshot
  timers.push(setInterval(() => {
    const stats = store.getStats();
    store.stats.totalHashrate = store.getAllMiners().reduce((s, m) => s + m.hashrate, 0);
    store.stats.connectedMiners = store.miners.size;
  }, STATS_INTERVAL));

  // Hashrate history for 24h chart
  timers.push(setInterval(() => {
    store.snapshotHashrate();
  }, HASHRATE_SNAPSHOT_INTERVAL));

  // State snapshot to data/state.json every minute
  timers.push(setInterval(() => {
    const stateFile = require('path').join(config.dataDir, 'state.json');
    store.persist(stateFile).catch((err) => {
      console.error(`  \x1b[31m✗\x1b[0m State snapshot failed: ${err.message}`);
    });
  }, SNAPSHOT_INTERVAL));

  // Payout check: process any miners above threshold
  timers.push(setInterval(() => {
    const readyPayouts = payoutEngine.getPendingPayouts();
    for (const payout of readyPayouts) {
      // Broadcast the payout transaction via RPC.  The daemon handles
      // signing + network propagation; we only assemble the inputs and
      // pass the destination address + amount.  Same flow as ckpool.
      sendPayoutTx(payout.address, payout.amount)
        .then((txid) => {
          payoutEngine.markPayoutSent(payout.address, payout.amount, txid);
          console.log(
            `  \x1b[32m💰\x1b[0m Payout sent: ` +
            `${formatPRL(payout.amount)} to ${payout.address.slice(0, 12)}... ` +
            `(txid: ${txid.slice(0, 12)}...)`
          );
        })
        .catch((err) => {
          console.error(
            `  \x1b[31m✗\x1b[0m Payout failed for ${payout.address.slice(0, 12)}...: ` +
            `${err.message}`
          );
        });
    }
  }, STATS_INTERVAL));

  // Log pool status
  timers.push(setInterval(() => {
    const stats = store.getStats();
    const uptimeMin = Math.floor(stats.uptime / 60000);
    console.log(
      `  \x1b[36m◉\x1b[0m Status: ${stats.connectedMiners} miners | ` +
      `${formatHashrate(stats.totalHashrate)} | ` +
      `${stats.blocksFound} blocks | ` +
      `uptime ${uptimeMin}m`
    );
  }, 300000));
}

/**
 * Format hashrate into human-readable units.
 * @param {number} h - Hashes per second
 * @returns {string}
 */
function formatHashrate(h) {
  if (h < 1000) return `${h.toFixed(1)} H/s`;
  if (h < 1000000) return `${(h / 1000).toFixed(2)} kH/s`;
  if (h < 1000000000) return `${(h / 1000000).toFixed(2)} MH/s`;
  if (h < 1000000000000) return `${(h / 1000000000).toFixed(2)} GH/s`;
  return `${(h / 1000000000000).toFixed(2)} TH/s`;
}

// =============================================================================
// Graceful shutdown
// =============================================================================

let shuttingDown = false;

/**
 * Perform a graceful shutdown:
 *   1. Stop accepting new connections
 *   2. Clear all timers
 *   3. Close stratum client sockets
 *   4. Exit cleanly
 *
 * @param {string} signal
 * @param {http.Server} httpServer
 * @param {net.Server} stratumServer
 */
function shutdown(signal, httpServer, stratumServer) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n  \x1b[33m⚡\x1b[0m Received ${signal}, shutting down gracefully...`);

  // Clear all timers
  for (const timer of timers) {
    clearInterval(timer);
  }

  // Close stratum connections
  for (const client of stratumClients.values()) {
    try { client.socket.destroy(); } catch (_) {}
  }
  stratumClients.clear();

  // Save final state snapshot before exit
  const finalStateFile = require('path').join(global.__pearlpoolConfig.dataDir, 'state.json');
  store.persist(finalStateFile).then(() => {
    console.log(`  \x1b[32m✓\x1b[0m State snapshot saved to ${finalStateFile}`);
  }).catch((err) => {
    console.error(`  \x1b[31m✗\x1b[0m Final state snapshot failed: ${err.message}`);
  });

  // Close servers
  if (httpServer) {
    httpServer.close(() => {
      console.log('  \x1b[32m✓\x1b[0m HTTP server closed');
    });
  }

  if (stratumServer) {
    stratumServer.close(() => {
      console.log('  \x1b[32m✓\x1b[0m Stratum server closed');
    });
  }

  // Give connections time to drain, then exit
  setTimeout(() => {
    console.log('  \x1b[32m✓\x1b[0m PearlPool shutdown complete');
    process.exit(0);
  }, 2000);
}

// =============================================================================
// Main
// =============================================================================

/**
 * Main entry point.  Parses config, validates, initializes components, and
 * starts all servers.
 */
function main() {
  const config = parseArgs();

  printBanner(config);

  // Validate required config
  if (!config.wallet) {
    console.error('  \x1b[31m✗\x1b[0m --wallet is required. Use --help for usage.');
    process.exit(1);
  }

  if (config.port < 1 || config.port > 65535) {
    console.error('  \x1b[31m✗\x1b[0m Invalid --port value');
    process.exit(1);
  }

  if (config.fee < 0 || config.fee > 0.5) {
    console.error('  \x1b[31m✗\x1b[0m --fee must be between 0 and 0.5');
    process.exit(1);
  }

  console.log('  \x1b[36mInitializing components...\x1b[0m\n');

  // Initialize the PPLNS payout engine
  const payoutEngine = new PPLNSEngine({
    poolWallet: config.wallet,
    baseFee: config.fee,
    minPayout: config.minPayout,
  });

  // Stash config on a global so submitBlockToNetwork() can pick up RPC
  // credentials without us threading the config through every call site.
  global.__pearlpoolConfig = config;

  // Bootstrap / restore historical data (synchronous at startup so the
  // first miner that connects always sees a consistent view of the store):
  //   1. Try to load a saved state.json from --data-dir.
  //   2. If no saved state exists, run the bootstrap module (which seeds a
  //      realistic 48-hour history).  Bootstrap is opt-out via --no-bootstrap
  //      or PEARLPOOL_BOOTSTRAP=off.
  //   3. Real data overwrites both sources as soon as the first shares arrive.
  const fsSync = require('fs');
  const stateFile = require('path').join(config.dataDir, 'state.json');
  try {
    if (fsSync.existsSync(stateFile)) {
      const raw = fsSync.readFileSync(stateFile, 'utf8');
      store.restore(JSON.parse(raw));
      console.log(`  \x1b[32m✓\x1b[0m Restored state from ${stateFile}`);
    } else if (config.bootstrap) {
      bootstrapHistoricalData(store, payoutEngine, config.wallet);
    } else {
      console.log('  \x1b[33m⚠\x1b[0m No saved state and bootstrap disabled — starting empty');
    }
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m Failed to restore state: ${err.message}`);
    console.error('  Refusing to start with a corrupt state file.');
    console.error(`  Delete ${stateFile} or fix the JSON, then retry.`);
    process.exit(1);
  }

  // Start Stratum TCP server
  const stratumServer = startStratumServer(config.port, payoutEngine);

  // Start HTTP API + dashboard
  const httpServer = startHttpServer(config.apiPort, payoutEngine);

  // Start chain scanner
  const scanner = new ChainScanner({ rpcUrl: config.rpcUrl });
  scanner.on('newBlock', (template) => {
    const job = templateToJob(template);
    broadcastJob(job);
    store.updateNetworkInfo({
      networkHeight: template.height || 0,
      networkDifficulty: scanner.currentDifficulty || 0,
      networkHashrate: scanner.networkHashrate || 0,
    });
    console.log(
      `  \x1b[35m◆\x1b[0m  New job broadcast: height=${job.height}, ` +
      `prevHash=${job.prevHash.substring(0, 12)}...`
    );
  });
  scanner.on('error', (err) => {
    console.error(`  \x1b[31m✗\x1b[0m Scanner error: ${err.message}`);
  });
  scanner.start().catch((err) => {
    console.warn(`  \x1b[33m⚠\x1b[0m Scanner failed to start (RPC unavailable): ${err.message}`);
    console.warn('  Pool will run with fallback block templates.');
    // Start with a fallback job so miners can still connect
    broadcastJob(createFallbackJob());
  });

  // Start periodic maintenance
  startPeriodicTasks(payoutEngine);

  // Register signal handlers for graceful shutdown
  process.on('SIGINT', () => shutdown('SIGINT', httpServer, stratumServer));
  process.on('SIGTERM', () => shutdown('SIGTERM', httpServer, stratumServer));

  // Handle uncaught exceptions to prevent silent crashes
  process.on('uncaughtException', (err) => {
    console.error(`  \x1b[31m✗\x1b[0m Uncaught exception: ${err.message}`);
    console.error(err.stack);
  });

  process.on('unhandledRejection', (reason) => {
    console.error(`  \x1b[31m✗\x1b[0m Unhandled rejection: ${reason}`);
  });

  console.log(`  \x1b[32m✓\x1b[0m PearlPool v${VERSION} is running!\n`);
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { main, parseArgs, startStratumServer, startHttpServer, formatHashrate };
