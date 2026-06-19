'use strict';

/**
 * @fileoverview Demo data seeder and background simulated miners for PearlPool.
 *
 * Pre-seeds the pool store with realistic historical data on startup so the
 * dashboard looks like a production pool that's been running for days.
 * Also starts background simulated miners that continuously submit shares,
 * fluctuate hashrate, and rotate in/out — making the dashboard appear alive.
 *
 * @author PearlPool Contributors
 * @license MIT
 */

// =============================================================================
// Utility functions (no external dependencies)
// =============================================================================

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a random bech32-like PRL address: 'prl1p' + 37 lowercase alphanumeric chars.
 * @returns {string}
 */
function randomAddress() {
  let addr = 'prl1p';
  for (let i = 0; i < 37; i++) {
    addr += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return addr;
}

/**
 * Generate a 64-char hex string (simulated block hash).
 * @returns {string}
 */
function randomHash() {
  const hex = '0123456789abcdef';
  let h = '';
  for (let i = 0; i < 64; i++) {
    h += hex[Math.floor(Math.random() * 16)];
  }
  return h;
}

/**
 * Box-Muller transform for normally-distributed random numbers.
 * @param {number} mean
 * @param {number} stddev
 * @returns {number}
 */
function gaussianRandom(mean, stddev) {
  let u1 = Math.random();
  let u2 = Math.random();
  // Avoid log(0)
  while (u1 === 0) u1 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stddev;
}

/**
 * Random integer in [min, max] inclusive.
 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Random float in [min, max).
 */
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

// =============================================================================
// Data generators
// =============================================================================

/**
 * Generate 24 hours of hashrate history (288 entries at 5-minute intervals).
 *
 * Incorporates a diurnal pattern: lower hashrate at night (UTC hours 0-6),
 * peak during the day (hours 10-18), with ±15% natural variance on top.
 *
 * @param {number} now - Current timestamp (ms)
 * @returns {Array<{timestamp: number, hashrate: number}>}
 */
function generateHashrateHistory(now) {
  const entries = [];
  const BASE_HASHRATE = 850e9; // 850 GH/s
  const count = 288; // 24 hours at 5-min intervals

  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - i) * 300000;
    const hour = new Date(timestamp).getUTCHours();

    // Diurnal pattern: sinusoidal with peak around hour 14 (UTC)
    // Maps hour 0-23 to a multiplier: ~0.6 at hour 3, ~1.0 at hour 14
    const diurnalFactor = 0.7 + 0.3 * Math.sin(((hour - 3) / 24) * 2 * Math.PI);

    // Natural variance: ±15% using Box-Muller
    const variance = gaussianRandom(1.0, 0.08);
    const clampedVariance = Math.max(0.7, Math.min(1.3, variance));

    const hashrate = BASE_HASHRATE * diurnalFactor * clampedVariance;

    entries.push({
      timestamp,
      hashrate: Math.round(hashrate),
    });
  }

  return entries;
}

/**
 * Generate 12-18 found blocks over the last 48 hours.
 *
 * @param {number} now - Current timestamp (ms)
 * @returns {Array<Object>} Block records suitable for store.addBlock()
 */
function generateBlocks(now) {
  const blocks = [];
  const count = randInt(12, 18);
  const FORTY_EIGHT_HOURS = 48 * 3600 * 1000;
  const startBaseHeight = 842000; // Realistic starting block height

  // Generate timestamps spread over 48 hours with ascending order
  // Each block is 5-15 minutes after the previous
  let currentTime = now - FORTY_EIGHT_HOURS;
  const timestamps = [];

  for (let i = 0; i < count; i++) {
    currentTime += randInt(5, 15) * 60 * 1000; // 5-15 min gap
    // Ensure last block is within the 48h window
    if (currentTime > now) currentTime = now - randInt(1, 30) * 60 * 1000;
    timestamps.push(currentTime);
  }

  // Sort timestamps ascending
  timestamps.sort((a, b) => a - b);

  for (let i = 0; i < count; i++) {
    const age = now - timestamps[i];
    // Older blocks have more confirmations
    const confirmations = Math.max(1, Math.min(50, Math.floor(age / 60000) + randInt(0, 5)));

    // Reward: ~50 PRL with small variance (±2%)
    const reward = Math.round(5000000000 * randFloat(0.98, 1.02));

    blocks.push({
      hash: randomHash(),
      height: startBaseHeight + i * randInt(5, 12),
      timestamp: timestamps[i],
      reward,
      confirmations,
      finder: randomAddress(),
    });
  }

  // Ensure heights are strictly ascending
  blocks.sort((a, b) => a.timestamp - b.timestamp);
  let lastHeight = blocks[0].height;
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].height <= lastHeight) {
      blocks[i].height = lastHeight + randInt(3, 10);
    }
    lastHeight = blocks[i].height;
  }

  return blocks;
}

/**
 * Generate 25-40 fake active miners with power-law hashrate distribution.
 *
 * Distribution:
 *   - 2-3 whales: 50-100 GH/s
 *   - 5-8 large: 10-30 GH/s
 *   - Remainder: 0.5-5 GH/s
 *
 * @param {number} now - Current timestamp (ms)
 * @returns {Array<Object>} Miner state objects
 */
function generateMiners(now) {
  const miners = [];
  const totalCount = randInt(25, 40);
  const whaleCount = randInt(2, 3);
  const largeCount = randInt(5, 8);
  const smallCount = totalCount - whaleCount - largeCount;

  // Whales
  for (let i = 0; i < whaleCount; i++) {
    miners.push(createMiner(now, randFloat(50e9, 100e9), 3, 4));
  }

  // Large miners
  for (let i = 0; i < largeCount; i++) {
    miners.push(createMiner(now, randFloat(10e9, 30e9), 2, 4));
  }

  // Small miners
  for (let i = 0; i < Math.max(0, smallCount); i++) {
    miners.push(createMiner(now, randFloat(0.5e9, 5e9), 1, 2));
  }

  return miners;
}

/**
 * Create a single fake miner record.
 *
 * @param {number} now
 * @param {number} hashrate - Hash rate in H/s
 * @param {number} minWorkers
 * @param {number} maxWorkers
 * @returns {Object} Miner state
 */
function createMiner(now, hashrate, minWorkers, maxWorkers) {
  const address = randomAddress();
  const workerCount = randInt(minWorkers, maxWorkers);
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
    address,
    hashrate: Math.round(hashrate),
    shares: randInt(1000, 50000),
    accepted: 0, // will be computed
    rejected: 0,
    lastSeen: now - randInt(0, 600000), // within last 10 minutes
    difficulty: randInt(32, 512),
    workers,
  };
}

/**
 * Generate 8-15 payout records spread over the last 7 days.
 *
 * @param {number} now - Current timestamp (ms)
 * @returns {Array<Object>} Payout records suitable for store.addPayoutRecord()
 */
function generatePayouts(now) {
  const payouts = [];
  const count = randInt(8, 15);
  const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

  for (let i = 0; i < count; i++) {
    const timestamp = now - randInt(0, SEVEN_DAYS);
    // Amounts: 0.5-25 PRL in atomic units
    const amount = Math.round(randFloat(0.5, 25) * 100000000);

    payouts.push({
      address: randomAddress(),
      amount,
      txHash: randomHash(),
      timestamp,
    });
  }

  // Sort newest first (as stored in payoutHistory)
  payouts.sort((a, b) => b.timestamp - a.timestamp);

  return payouts;
}

// =============================================================================
// Background simulated miners
// =============================================================================

/**
 * Create and start background simulated miners that make the dashboard
 * appear alive with continuously changing data.
 *
 * @param {Object} store - Pool store singleton
 * @param {Object} payoutEngine - PPLNS payout engine instance
 * @returns {Array<Object>} Array of active simulated miner descriptors
 */
function startBackgroundMiners(store, payoutEngine) {
  const minerCount = randInt(3, 5);
  const miners = [];

  for (let i = 0; i < minerCount; i++) {
    const miner = {
      address: randomAddress(),
      hashrate: randFloat(2e9, 40e9),
      baseDifficulty: randInt(32, 192),
      workers: [`sim${i + 1}`],
      connectedAt: Date.now(),
      intervals: [],
    };
    miners.push(miner);
  }

  // Register each simulated miner in the store
  for (const miner of miners) {
    registerSimMiner(store, miner);
  }

  // Start share submission loop for each miner
  for (const miner of miners) {
    startShareLoop(store, payoutEngine, miner);
  }

  // Periodic hashrate fluctuation (every 5-15 minutes, a random miner drifts)
  const driftInterval = setInterval(() => {
    if (miners.length === 0) return;
    const idx = randInt(0, miners.length - 1);
    const miner = miners[idx];
    const drift = gaussianRandom(1.0, 0.05);
    miner.hashrate = Math.max(0.5e9, miner.hashrate * Math.max(0.9, Math.min(1.1, drift)));
    store.updateMiner(miner.address, { hashrate: Math.round(miner.hashrate) });
  }, randInt(5, 15) * 60 * 1000);

  // Miner rotation: every 2-4 hours, disconnect one miner and connect a new one
  const rotateInterval = setInterval(() => {
    if (miners.length < 2) return;

    // Pick a random miner to disconnect
    const removeIdx = randInt(0, miners.length - 1);
    const removed = miners[removeIdx];

    // Clear all intervals for the removed miner
    for (const iv of removed.intervals) {
      clearInterval(iv);
    }
    store.removeMiner(removed.address);
    console.log(`  \x1b[33m↕\x1b[0m  Sim miner disconnected: ${removed.address.slice(0, 16)}...`);

    // Create a new miner to replace it
    const newMiner = {
      address: randomAddress(),
      hashrate: randFloat(2e9, 40e9),
      baseDifficulty: randInt(32, 192),
      workers: [`sim${randInt(1, 99)}`],
      connectedAt: Date.now(),
      intervals: [],
    };
    miners[removeIdx] = newMiner;
    registerSimMiner(store, newMiner);
    startShareLoop(store, payoutEngine, newMiner);
    console.log(`  \x1b[32m+\x1b[0m  Sim miner connected: ${newMiner.address.slice(0, 16)}...`);
  }, randInt(2, 4) * 3600 * 1000);

  // Store cleanup references (so intervals can be cleared on shutdown)
  miners._driftInterval = driftInterval;
  miners._rotateInterval = rotateInterval;

  return miners;
}

/**
 * Register a simulated miner in the store.
 */
function registerSimMiner(store, miner) {
  const now = Date.now();
  const workers = miner.workers.map((id) => ({
    id,
    ip: `${randInt(10, 223)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
    connectedAt: now,
    hashrate: Math.round(miner.hashrate),
  }));

  store.updateMiner(miner.address, {
    hashrate: Math.round(miner.hashrate),
    shares: 0,
    accepted: 0,
    rejected: 0,
    lastSeen: now,
    difficulty: miner.baseDifficulty,
    workers,
  });
}

/**
 * Start the share submission loop for a single simulated miner.
 * Shares are submitted every 3-8 seconds with random jitter.
 */
function startShareLoop(store, payoutEngine, miner) {
  function scheduleNext() {
    const delay = randInt(3000, 8000);
    const iv = setTimeout(() => {
      if (!store.getMiner(miner.address)) return; // Miner was removed

      const difficulty = randInt(16, 256);
      payoutEngine.addShare(miner.address, difficulty);
      store.recordShare(miner.address, true, difficulty);

      scheduleNext();
    }, delay);
    miner.intervals.push(iv);
  }

  scheduleNext();
}

// =============================================================================
// Main init function
// =============================================================================

/**
 * Initialize demo data: pre-seed the store with realistic historical data
 * and start background simulated miners.
 *
 * @param {Object} store - Pool store singleton (require('./store'))
 * @param {Object} payoutEngine - PPLNSEngine instance
 * @param {string} poolWallet - Pool wallet address (for context/logging)
 */
function initDemoData(store, payoutEngine, poolWallet) {
  const now = Date.now();
  console.log('  \x1b[36m▶\x1b[0m Demo mode: seeding pool with realistic data...\n');

  // --- 1. Hashrate history (24h) ---
  const hashrateHistory = generateHashrateHistory(now);
  // Push entries directly into store's hashrateHistory array
  for (const entry of hashrateHistory) {
    store.hashrateHistory.push(entry);
  }
  // Trim to max capacity
  while (store.hashrateHistory.length > 288) {
    store.hashrateHistory.shift();
  }
  console.log(`  \x1b[32m✓\x1b[0m Seeded ${hashrateHistory.length} hashrate snapshots (24h)`);

  // --- 2. Found blocks ---
  const blocks = generateBlocks(now);
  for (const block of blocks) {
    store.addBlock(block);
  }
  console.log(`  \x1b[32m✓\x1b[0m Seeded ${blocks.length} found blocks`);

  // --- 3. Active miners ---
  const fakeMiners = generateMiners(now);
  for (const miner of fakeMiners) {
    // Set accepted/rejected as a fraction of total shares
    miner.accepted = Math.floor(miner.shares * randFloat(0.94, 0.99));
    miner.rejected = miner.shares - miner.accepted;
    store.updateMiner(miner.address, miner);
    // Register workers
    for (const worker of miner.workers) {
      store.addWorker(miner.address, worker.id, worker.ip);
    }
  }
  console.log(`  \x1b[32m✓\x1b[0m Seeded ${fakeMiners.length} active miners`);

  // --- 4. Payout history ---
  const payouts = generatePayouts(now);
  for (const payout of payouts) {
    store.addPayoutRecord(payout);
  }
  console.log(`  \x1b[32m✓\x1b[0m Seeded ${payouts.length} payout records`);

  // --- 5. Pool stats ---
  const totalMinerHashrate = fakeMiners.reduce((sum, m) => sum + m.hashrate, 0);
  store.stats.totalHashrate = totalMinerHashrate;
  store.stats.connectedMiners = fakeMiners.length + 4; // Include upcoming sim miners
  store.stats.blocksFound = blocks.length;
  // Network hashrate is ~3-5x pool hashrate (pool is ~20-30% of network)
  store.stats.networkHashrate = Math.round(totalMinerHashrate * randFloat(3.0, 5.0));
  store.stats.networkDifficulty = Math.round(store.stats.networkHashrate / 1e6);
  store.stats.networkHeight = blocks.length > 0 ? blocks[blocks.length - 1].height + randInt(0, 5) : 842500;
  store.stats.lastBlockTime = blocks.length > 0 ? blocks[blocks.length - 1].timestamp : now;

  // Set payout engine network difficulty for share window sizing
  if (payoutEngine && typeof payoutEngine.setNetworkDifficulty === 'function') {
    payoutEngine.setNetworkDifficulty(store.stats.networkDifficulty);
  }

  console.log(`  \x1b[32m✓\x1b[0m Pool stats configured:`);
  console.log(`      Total hashrate:  ${(totalMinerHashrate / 1e9).toFixed(2)} GH/s`);
  console.log(`      Network diff:    ${store.stats.networkDifficulty}`);
  console.log(`      Network HR:      ${(store.stats.networkHashrate / 1e9).toFixed(2)} GH/s`);
  console.log(`      Blocks found:    ${store.stats.blocksFound}`);
  console.log(`      Active miners:   ${store.stats.connectedMiners}`);

  // --- 6. Start background simulated miners ---
  console.log('');
  const simMiners = startBackgroundMiners(store, payoutEngine);
  console.log(`  \x1b[32m✓\x1b[0m Started ${simMiners.length} background simulated miners`);
  console.log('  \x1b[36m✓\x1b[0m Demo data seeding complete.\n');

  return simMiners;
}

module.exports = { initDemoData };
