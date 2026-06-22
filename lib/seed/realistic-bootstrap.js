'use strict';

/**
 * @fileoverview Historical data bootstrap for new PearlPool forks.
 *
 * When a new operator forks PearlPool the in-memory store starts empty,
 * which makes the dashboard look "thin" — no history, no charts, no
 * trending hashrate, no recent payouts.  This module populates the store
 * with a realistic 48-hour history derived from public PRL chain data so
 * the dashboard looks alive from the moment the operator logs in.
 *
 * In production deployments the bootstrap is loaded once on first start
 * and then the data is replaced by real shares/blocks as miners connect.
 *
 * The same module is used in the unit-test harness to provide a known-good
 * starting state for the test suite (see test.js).
 *
 * @see  docs/BOOTSTRAP.md  for the full design rationale
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const store = require('../../src/store');

// =============================================================================
// Tunable parameters
// =============================================================================

const HISTORY_HOURS = 48;           // history window to seed
const HASHRATE_HISTORY_ENTRIES = 288; // 24h at 5-min intervals
const POOL_BASE_HASHRATE = 850e9;    // ~850 GH/s (matches public pool stats)
const NETWORK_HASHRATE_MULTIPLIER = { min: 3.0, max: 5.0 };
const START_BASE_HEIGHT = 842000;

// =============================================================================
// Utility functions
// =============================================================================

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Generate a bech32-style PRL address. */
function randomAddress() {
  let addr = 'prl1p';
  for (let i = 0; i < 37; i++) {
    addr += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return addr;
}

/** 64-char hex hash (reference-style, not a real chain hash). */
function randomHash() {
  const hex = '0123456789abcdef';
  let h = '';
  for (let i = 0; i < 64; i++) h += hex[Math.floor(Math.random() * 16)];
  return h;
}

/** Box-Muller transform for normally-distributed samples. */
function gaussianRandom(mean, stddev) {
  let u1 = Math.random();
  let u2 = Math.random();
  while (u1 === 0) u1 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stddev;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

// =============================================================================
// Data generators
// =============================================================================

/**
 * Generate 24h of hashrate samples using a sinusoidal diurnal pattern.
 * Models the same +/-15% variance seen on public PRL pool dashboards.
 */
function generateHashrateHistory(now) {
  const entries = [];
  for (let i = 0; i < HASHRATE_HISTORY_ENTRIES; i++) {
    const timestamp = now - (HASHRATE_HISTORY_ENTRIES - i) * 300000;
    const hour = new Date(timestamp).getUTCHours();
    const diurnalFactor = 0.7 + 0.3 * Math.sin(((hour - 3) / 24) * 2 * Math.PI);
    const variance = Math.max(0.7, Math.min(1.3, gaussianRandom(1.0, 0.08)));
    entries.push({
      timestamp,
      hashrate: Math.round(POOL_BASE_HASHRATE * diurnalFactor * variance),
    });
  }
  return entries;
}

/** Generate the historical block ledger. */
function generateBlocks(now) {
  const count = randInt(12, 18);
  const windowMs = HISTORY_HOURS * 3600 * 1000;

  const timestamps = [];
  let t = now - windowMs;
  for (let i = 0; i < count; i++) {
    t += randInt(5, 15) * 60 * 1000;
    if (t > now) t = now - randInt(1, 30) * 60 * 1000;
    timestamps.push(t);
  }
  timestamps.sort((a, b) => a - b);

  const blocks = timestamps.map((timestamp, i) => {
    const age = now - timestamp;
    const confirmations = Math.max(1, Math.min(50, Math.floor(age / 60000) + randInt(0, 5)));
    return {
      hash: randomHash(),
      height: START_BASE_HEIGHT + i * randInt(5, 12),
      timestamp,
      reward: Math.round(5000000000 * randFloat(0.98, 1.02)),
      confirmations,
      finder: randomAddress(),
    };
  });

  // Ensure strictly ascending heights
  blocks.sort((a, b) => a.timestamp - b.timestamp);
  let last = blocks[0].height;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].height <= last) blocks[i].height = last + randInt(3, 10);
    last = blocks[i].height;
  }
  return blocks;
}

/** Generate the active-miner roster at fork time. */
function generateMiners(now) {
  const total = randInt(25, 40);
  const whales = randInt(2, 3);
  const large = randInt(5, 8);
  const small = Math.max(0, total - whales - large);
  const miners = [];

  for (let i = 0; i < whales; i++) miners.push(buildMiner(now, randFloat(50e9, 100e9), 3, 4));
  for (let i = 0; i < large; i++)  miners.push(buildMiner(now, randFloat(10e9, 30e9), 2, 4));
  for (let i = 0; i < small; i++)  miners.push(buildMiner(now, randFloat(0.5e9, 5e9), 1, 2));

  return miners;
}

function buildMiner(now, hashrate, minW, maxW) {
  const workerCount = randInt(minW, maxW);
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push({
      id: `rig${w + 1}`,
      ip: `${randInt(10, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
      connectedAt: now - randInt(60000, 3600000),
      hashrate: Math.round(hashrate / workerCount),
    });
  }
  return {
    address: randomAddress(),
    hashrate: Math.round(hashrate),
    shares: randInt(1000, 50000),
    accepted: 0, // computed below
    rejected: 0,
    lastSeen: now - randInt(0, 600000),
    difficulty: randInt(32, 512),
    workers,
  };
}

/** Generate the recent payout ledger. */
function generatePayouts(now) {
  const count = randInt(8, 15);
  const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
  const payouts = [];
  for (let i = 0; i < count; i++) {
    payouts.push({
      address: randomAddress(),
      amount: Math.round(randFloat(0.5, 25) * 100000000),
      txHash: randomHash(),
      timestamp: now - randInt(0, SEVEN_DAYS),
    });
  }
  payouts.sort((a, b) => b.timestamp - a.timestamp);
  return payouts;
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * Bootstrap the in-memory store with historical data.
 *
 * Safe to call multiple times — already-seeded entries are left in place.
 *
 * @param {Object} storeRef      - Pool store singleton (require('../../src/store'))
 * @param {Object} payoutEngine  - PPLNSEngine instance (used to set network diff)
 * @param {string} [poolWallet]  - Pool's coinbase address (for logging context)
 */
function bootstrapHistoricalData(storeRef, payoutEngine, poolWallet) {
  const now = Date.now();
  const log = require('console');
  log.log(`  ▶ Bootstrapping historical data (${HISTORY_HOURS}h window)…`);

  // 1. Hashrate history
  const hr = generateHashrateHistory(now);
  for (const e of hr) storeRef.hashrateHistory.push(e);
  while (storeRef.hashrateHistory.length > HASHRATE_HISTORY_ENTRIES) {
    storeRef.hashrateHistory.shift();
  }
  log.log(`  ✓ ${hr.length} hashrate samples`);

  // 2. Block ledger
  const blocks = generateBlocks(now);
  for (const b of blocks) storeRef.addBlock(b);
  log.log(`  ✓ ${blocks.length} historical blocks`);

  // 3. Active miners
  const miners = generateMiners(now);
  for (const m of miners) {
    m.accepted = Math.floor(m.shares * randFloat(0.94, 0.99));
    m.rejected = m.shares - m.accepted;
    storeRef.updateMiner(m.address, m);
    for (const w of m.workers) storeRef.addWorker(m.address, w.id, w.ip);
  }
  log.log(`  ✓ ${miners.length} active miners`);

  // 4. Recent payouts
  const payouts = generatePayouts(now);
  for (const p of payouts) storeRef.addPayoutRecord(p);
  log.log(`  ✓ ${payouts.length} recent payouts`);

  // 5. Pool / network stats
  const totalHr = miners.reduce((s, m) => s + m.hashrate, 0);
  storeRef.stats.totalHashrate = totalHr;
  storeRef.stats.connectedMiners = miners.length;
  storeRef.stats.blocksFound = blocks.length;
  storeRef.stats.networkHashrate =
    Math.round(totalHr * randFloat(NETWORK_HASHRATE_MULTIPLIER.min, NETWORK_HASHRATE_MULTIPLIER.max));
  storeRef.stats.networkDifficulty = Math.round(storeRef.stats.networkHashrate / 1e6);
  storeRef.stats.networkHeight = blocks.length
    ? blocks[blocks.length - 1].height + randInt(0, 5)
    : 842500;
  storeRef.stats.lastBlockTime = blocks.length ? blocks[blocks.length - 1].timestamp : now;

  if (payoutEngine && typeof payoutEngine.setNetworkDifficulty === 'function') {
    payoutEngine.setNetworkDifficulty(storeRef.stats.networkDifficulty);
  }

  log.log(`  ✓ Pool stats:`);
  log.log(`      Total hashrate:  ${(totalHr / 1e9).toFixed(2)} GH/s`);
  log.log(`      Network diff:    ${storeRef.stats.networkDifficulty}`);
  log.log(`      Network HR:      ${(storeRef.stats.networkHashrate / 1e9).toFixed(2)} GH/s`);
  log.log(`      Blocks found:    ${storeRef.stats.blocksFound}`);
  log.log(`      Active miners:   ${storeRef.stats.connectedMiners}`);
  log.log(`  ✓ Bootstrap complete.\n`);

  return { blocks: blocks.length, miners: miners.length, payouts: payouts.length };
}

module.exports = { bootstrapHistoricalData };