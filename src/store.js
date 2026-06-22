'use strict';

/**
 * @fileoverview In-memory state store for PearlPool.
 *
 * Centralizes all runtime pool state: connected miners, found blocks,
 * pending payouts, pool statistics, and hashrate history.
 * EventEmitter-based so other components can subscribe to state changes.
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const { EventEmitter } = require('events');

/**
 * Maximum number of hashrate history snapshots to retain.
 * At one snapshot every 5 minutes, 288 entries = 24 hours.
 */
const MAX_HASHRATE_HISTORY = 288;

/**
 * Maximum number of blocks to keep in the recent-blocks ring buffer.
 */
const MAX_BLOCK_HISTORY = 500;

/**
 * Maximum number of payout records to retain in history.
 */
const MAX_PAYOUT_HISTORY = 1000;

class PoolStore extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, MinerState>} Connected miners keyed by wallet address */
    this.miners = new Map();

    /** @type {BlockRecord[]} Ring buffer of recently found blocks */
    this.blocks = [];

    /** @type {Map<string, PendingBalance>} Pending payout balances keyed by address */
    this.pendingPayouts = new Map();

    /** @type {PoolStats} Aggregate pool statistics */
    this.stats = {
      totalHashrate: 0,
      connectedMiners: 0,
      blocksFound: 0,
      uptime: Date.now(),
      networkDifficulty: 0,
      networkHashrate: 0,
      networkHeight: 0,
      lastBlockTime: null,
    };

    /** @type {HashrateSnapshot[]} 24h rolling hashrate history */
    this.hashrateHistory = [];

    /** @type {PayoutRecord[]} History of completed payouts */
    this.payoutHistory = [];
  }

  // ---------------------------------------------------------------------------
  // Miner management
  // ---------------------------------------------------------------------------

  /**
   * Get the state object for a single miner.
   * @param {string} address - Miner wallet address
   * @returns {MinerState|null}
   */
  getMiner(address) {
    return this.miners.get(address) || null;
  }

  /**
   * Return an array of every connected miner and their stats.
   * @returns {MinerState[]}
   */
  getAllMiners() {
    return Array.from(this.miners.values());
  }

  /**
   * Upsert a miner's state.  Merges partial updates into the existing record
   * so callers can send only the fields that changed.
   *
   * @param {string} address - Wallet address (primary key)
   * @param {Partial<MinerState>} data - Fields to merge
   * @returns {MinerState} The merged miner record
   */
  updateMiner(address, data) {
    const existing = this.miners.get(address) || {
      address,
      hashrate: 0,
      shares: 0,
      accepted: 0,
      rejected: 0,
      lastSeen: Date.now(),
      difficulty: 0,
      workers: [],
    };

    const updated = { ...existing, ...data, address, lastSeen: Date.now() };
    this.miners.set(address, updated);

    this.emit('minerUpdated', updated);
    this._recalcPoolHashrate();

    return updated;
  }

  /**
   * Register a new worker (rig) under a miner address.
   * If the miner doesn't exist yet, creates a blank record first.
   *
   * @param {string} address
   * @param {string} workerId
   * @param {string} [ip]
   * @returns {MinerState}
   */
  addWorker(address, workerId, ip) {
    const miner = this.miners.get(address) || {
      address,
      hashrate: 0,
      shares: 0,
      accepted: 0,
      rejected: 0,
      lastSeen: Date.now(),
      difficulty: 0,
      workers: [],
    };

    const existingIdx = miner.workers.findIndex((w) => w.id === workerId);
    if (existingIdx === -1) {
      miner.workers.push({ id: workerId, ip: ip || 'unknown', connectedAt: Date.now(), hashrate: 0 });
    } else {
      miner.workers[existingIdx].lastSeen = Date.now();
      if (ip) miner.workers[existingIdx].ip = ip;
    }

    miner.lastSeen = Date.now();
    this.miners.set(address, miner);
    this.emit('workerAdded', { address, workerId });
    return miner;
  }

  /**
   * Remove a miner entirely (e.g. on disconnect with no remaining workers).
   * @param {string} address
   * @returns {boolean} true if the miner existed and was removed
   */
  removeMiner(address) {
    const existed = this.miners.delete(address);
    if (existed) {
      this.emit('minerRemoved', address);
      this._recalcPoolHashrate();
    }
    return existed;
  }

  /**
   * Recalculate the pool-wide aggregate hashrate from all connected miners.
   * Called internally whenever a miner is added, updated, or removed.
   * @private
   */
  _recalcPoolHashrate() {
    let total = 0;
    for (const miner of this.miners.values()) {
      total += miner.hashrate || 0;
    }
    this.stats.totalHashrate = total;
    this.stats.connectedMiners = this.miners.size;
  }

  // ---------------------------------------------------------------------------
  // Block management
  // ---------------------------------------------------------------------------

  /**
   * Record a newly found block.
   * @param {BlockRecord} block
   * @returns {BlockRecord}
   */
  addBlock(block) {
    const record = {
      hash: block.hash,
      height: block.height,
      timestamp: block.timestamp || Date.now(),
      reward: block.reward || 0,
      confirmations: block.confirmations || 0,
      finder: block.finder || 'unknown',
      orphaned: false,
    };

    this.blocks.unshift(record);

    // Trim to max history
    if (this.blocks.length > MAX_BLOCK_HISTORY) {
      this.blocks.length = MAX_BLOCK_HISTORY;
    }

    this.stats.blocksFound++;
    this.stats.lastBlockTime = record.timestamp;

    this.emit('blockFound', record);
    return record;
  }

  /**
   * Update confirmation count for a previously found block.
   * @param {string} hash - Block hash
   * @param {number} confirmations
   */
  updateBlockConfirmations(hash, confirmations) {
    const block = this.blocks.find((b) => b.hash === hash);
    if (block) {
      block.confirmations = confirmations;
      this.emit('blockConfirmations', { hash, confirmations });
    }
  }

  /**
   * Mark a block as orphaned.
   * @param {string} hash
   */
  markBlockOrphaned(hash) {
    const block = this.blocks.find((b) => b.hash === hash);
    if (block) {
      block.orphaned = true;
      this.emit('blockOrphaned', { hash });
    }
  }

  /**
   * Get the N most recent blocks.
   * @param {number} [limit=20]
   * @returns {BlockRecord[]}
   */
  getRecentBlocks(limit = 20) {
    return this.blocks.slice(0, limit);
  }

  /**
   * Get all blocks.
   * @returns {BlockRecord[]}
   */
  getAllBlocks() {
    return this.blocks;
  }

  // ---------------------------------------------------------------------------
  // Pending payouts & balances
  // ---------------------------------------------------------------------------

  /**
   * Get pending balance info for a miner.
   * @param {string} address
   * @returns {PendingBalance}
   */
  getPendingBalance(address) {
    return this.pendingPayouts.get(address) || { balance: 0, totalPaid: 0, lastPayout: null };
  }

  /**
   * Credit a miner's pending balance (called after block reward distribution).
   * @param {string} address
   * @param {number} amount - Amount to add to pending balance (in PRL atomic units)
   */
  creditPending(address, amount) {
    const pending = this.pendingPayouts.get(address) || { balance: 0, totalPaid: 0, lastPayout: null };
    pending.balance += amount;
    this.pendingPayouts.set(address, pending);
    this.emit('balanceCredited', { address, amount, newBalance: pending.balance });
  }

  /**
   * Debit a miner's pending balance (called when a payout is sent).
   * @param {string} address
   * @param {number} amount
   */
  debitPending(address, amount) {
    const pending = this.pendingPayouts.get(address);
    if (!pending) return;

    pending.balance -= amount;
    if (pending.balance < 0) pending.balance = 0;
    pending.totalPaid += amount;
    pending.lastPayout = Date.now();

    this.pendingPayouts.set(address, pending);
    this.emit('balanceDebited', { address, amount, newBalance: pending.balance });
  }

  /**
   * Return all miners with a non-zero pending balance.
   * @returns {Array<{address: string} & PendingBalance>}
   */
  getAllPendingBalances() {
    const result = [];
    for (const [address, data] of this.pendingPayouts) {
      if (data.balance > 0 || data.totalPaid > 0) {
        result.push({ address, ...data });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Payout history
  // ---------------------------------------------------------------------------

  /**
   * Append a completed payout record to the history.
   * @param {PayoutRecord} record
   */
  addPayoutRecord(record) {
    this.payoutHistory.unshift({
      address: record.address,
      amount: record.amount,
      txHash: record.txHash || null,
      timestamp: record.timestamp || Date.now(),
      blockHeight: record.blockHeight || null,
    });

    if (this.payoutHistory.length > MAX_PAYOUT_HISTORY) {
      this.payoutHistory.length = MAX_PAYOUT_HISTORY;
    }

    this.emit('payoutSent', record);
  }

  /**
   * Get recent payout records.
   * @param {number} [limit=50]
   * @returns {PayoutRecord[]}
   */
  getPayoutHistory(limit = 50) {
    return this.payoutHistory.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Pool stats & network info
  // ---------------------------------------------------------------------------

  /**
   * Get the current pool statistics snapshot.
   * @returns {PoolStats}
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.uptime,
      connectedMiners: this.miners.size,
      totalHashrate: this.stats.totalHashrate,
    };
  }

  /**
   * Get the current block reward (from network info or default PRL schedule).
   * @returns {number} Block reward in satoshis
   */
  getNetworkBlockReward() {
    return this.stats.blockReward || 50_00000000; // 50 PRL default
  }

  /**
   * Update network-level information (from chain scanner / RPC).
   * @param {Partial<PoolStats>} networkData
   */
  updateNetworkInfo(networkData) {
    if (networkData.networkDifficulty !== undefined) {
      this.stats.networkDifficulty = networkData.networkDifficulty;
    }
    if (networkData.networkHashrate !== undefined) {
      this.stats.networkHashrate = networkData.networkHashrate;
    }
    if (networkData.networkHeight !== undefined) {
      this.stats.networkHeight = networkData.networkHeight;
    }
    this.emit('networkUpdated', networkData);
  }

  // ---------------------------------------------------------------------------
  // Hashrate history (24h chart data)
  // ---------------------------------------------------------------------------

  /**
   * Record a hashrate snapshot. Called periodically (every 5 min) by pool.js.
   * Automatically trims to MAX_HASHRATE_HISTORY entries (24h window).
   */
  snapshotHashrate() {
    const entry = {
      timestamp: Date.now(),
      hashrate: this.stats.totalHashrate,
      miners: this.miners.size,
    };

    this.hashrateHistory.push(entry);

    // Trim old entries beyond the 24h window
    while (this.hashrateHistory.length > MAX_HASHRATE_HISTORY) {
      this.hashrateHistory.shift();
    }

    this.emit('hashrateSnapshot', entry);
  }

  /**
   * Get the full 24h hashrate history array.
   * @returns {HashrateSnapshot[]}
   */
  getHashrateHistory() {
    return this.hashrateHistory;
  }

  // ---------------------------------------------------------------------------
  // Share accounting helpers
  // ---------------------------------------------------------------------------

  /**
   * Record a share submission for a miner.
   * @param {string} address
   * @param {boolean} accepted
   * @param {number} difficulty
   */
  recordShare(address, accepted, difficulty) {
    const miner = this.miners.get(address);
    if (!miner) return;

    miner.shares++;
    if (accepted) {
      miner.accepted++;
    } else {
      miner.rejected++;
    }
    miner.difficulty = difficulty;
    miner.lastSeen = Date.now();

    this.emit('share', { address, accepted, difficulty });
  }

  // ---------------------------------------------------------------------------
  // Snapshot / persistence (JSON file, atomic write, zero deps)
  // ---------------------------------------------------------------------------

  /**
   * Serialise the entire store state to a plain JSON-safe object.
   * EventEmitter internals are not included (they live on the prototype).
   *
   * @returns {object} snapshot
   */
  serialize() {
    return {
      version: 1,
      savedAt: Date.now(),
      miners: Array.from(this.miners.entries()),
      blocks: this.blocks,
      pendingPayouts: Array.from(this.pendingPayouts.entries()),
      stats: { ...this.stats },
      hashrateHistory: this.hashrateHistory,
      payoutHistory: this.payoutHistory,
    };
  }

  /**
   * Replace store state from a previously-serialised snapshot.
   * Resets `uptime` to `Date.now()` so a restored pool reports zero
   * elapsed time (avoids negative / stale uptime from the snapshot).
   *
   * @param {object} snapshot - The object previously returned by serialize()
   * @returns {boolean} true if state was replaced, false if snapshot was null
   * @throws {Error} on version mismatch or invalid shape
   */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (snapshot.version !== 1) {
      throw new Error(
        `Unsupported snapshot version: ${snapshot.version}. ` +
        `This build of PearlPool understands version 1.`
      );
    }

    this.miners = new Map(Array.isArray(snapshot.miners) ? snapshot.miners : []);
    this.blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : [];
    this.pendingPayouts = new Map(
      Array.isArray(snapshot.pendingPayouts) ? snapshot.pendingPayouts : []
    );
    if (snapshot.stats && typeof snapshot.stats === 'object') {
      this.stats = { ...this.stats, ...snapshot.stats, uptime: Date.now() };
    }
    this.hashrateHistory = Array.isArray(snapshot.hashrateHistory)
      ? snapshot.hashrateHistory
      : [];
    this.payoutHistory = Array.isArray(snapshot.payoutHistory)
      ? snapshot.payoutHistory
      : [];

    this._recalcPoolHashrate();
    this.emit('restored', { savedAt: snapshot.savedAt });
    return true;
  }

  /**
   * Atomically write the current store state to a JSON file.
   * See `lib/persistence/json-snapshot.js` for the write semantics
   * (write to `.tmp`, fsync, rename).
   *
   * @param {string} filepath - Target file (e.g. `./data/state.json`)
   * @returns {Promise<void>}
   */
  async persist(filepath) {
    const { save } = require('../lib/persistence/json-snapshot');
    return save(filepath, this.serialize());
  }

  /**
   * Load and apply a snapshot from disk.  Returns `false` if the file
   * does not exist (first start).  Throws on parse / version errors so
   * the caller can log + refuse to start, or fall back to a fresh store.
   *
   * @param {string} filepath
   * @returns {Promise<boolean>} true if state was restored, false on first start
   */
  async restoreFromFile(filepath) {
    const { load } = require('../lib/persistence/json-snapshot');
    const snapshot = await load(filepath);
    if (snapshot === null) return false;
    return this.restore(snapshot);
  }
}

// Create and export a singleton instance
const store = new PoolStore();

module.exports = store;

// ---------------------------------------------------------------------------
// JSDoc type definitions (for editor IntelliSense)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MinerState
 * @property {string} address - Wallet address
 * @property {number} hashrate - Current hashrate in H/s
 * @property {number} shares - Total shares submitted
 * @property {number} accepted - Accepted shares
 * @property {number} rejected - Rejected/stale shares
 * @property {number} lastSeen - Unix timestamp of last activity
 * @property {number} difficulty - Current share difficulty
 * @property {WorkerInfo[]} workers - Connected worker rigs
 */

/**
 * @typedef {Object} WorkerInfo
 * @property {string} id - Worker identifier
 * @property {string} ip - Worker IP address
 * @property {number} connectedAt - Connection timestamp
 * @property {number} hashrate - Worker hashrate in H/s
 * @property {number} [lastSeen] - Last activity timestamp
 */

/**
 * @typedef {Object} BlockRecord
 * @property {string} hash - Block hash
 * @property {number} height - Block height
 * @property {number} timestamp - When block was found
 * @property {number} reward - Block reward in atomic units
 * @property {number} confirmations - Current confirmation count
 * @property {string} finder - Address of the miner who found it
 * @property {boolean} orphaned - Whether block was orphaned
 */

/**
 * @typedef {Object} PendingBalance
 * @property {number} balance - Pending (unpaid) balance
 * @property {number} totalPaid - Cumulative amount paid out
 * @property {number|null} lastPayout - Timestamp of last payout, or null
 */

/**
 * @typedef {Object} PoolStats
 * @property {number} totalHashrate - Pool-wide hashrate in H/s
 * @property {number} connectedMiners - Number of connected miners
 * @property {number} blocksFound - Total blocks found by pool
 * @property {number} uptime - Milliseconds since pool started
 * @property {number} networkDifficulty - Current network difficulty
 * @property {number} networkHashrate - Estimated network hashrate
 * @property {number} networkHeight - Current blockchain height
 * @property {number|null} lastBlockTime - Timestamp of last pool block
 */

/**
 * @typedef {Object} HashrateSnapshot
 * @property {number} timestamp - Snapshot time
 * @property {number} hashrate - Pool hashrate at snapshot
 * @property {number} miners - Connected miner count at snapshot
 */

/**
 * @typedef {Object} PayoutRecord
 * @property {string} address - Recipient address
 * @property {number} amount - Payout amount
 * @property {string|null} txHash - Transaction hash
 * @property {number} timestamp - When payout was sent
 * @property {number|null} [blockHeight] - Associated block height
 */
