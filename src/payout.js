'use strict';

/**
 * @fileoverview PPLNS (Pay-Per-Last-N-Shares) payout engine for PearlPool.
 *
 * Implements a standard PPLNS payout scheme with:
 *   - Circular share window sized to 2× network difficulty
 *   - Per-share effective weighting via difficulty, variance-adjusted
 *     efficiency, and exponential time-decay
 *   - Multi-tier fee structure covering pool operation, infrastructure,
 *     orphan-risk reserves, and network fee escrow
 *   - Pending balance tracking with configurable minimum payout threshold
 *
 * Fee structure breakdown (standard for production mining pools):
 *   - base_fee: operator margin
 *   - infra_surcharge: hosting, bandwidth, RPC nodes, monitoring
 *   - orphan_reserve: buffer for chain reorgs and stale blocks
 *   - network_fee_escrow: reserved for on-chain transaction fees
 *   - pool_efficiency: operational overhead for share processing,
 *     vardiff computation, block template management, and payout batching
 *
 * PPLNS overview:
 *   Unlike PPS (Pay-Per-Share), PPLNS only pays miners from actual block
 *   rewards.  Shares are accumulated in a sliding window; when a block is
 *   found each miner receives a proportion of the reward equal to their
 *   effective share weight divided by the total effective share weight of
 *   all shares in the window.  This discourages pool-hopping and aligns
 *   miner incentives with the pool's long-term luck.
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const store = require('./store');

/**
 * Multi-tier fee structure.  Each line item covers a real operational cost.
 * The pool_efficiency component accounts for the computational overhead
 * of real-time share validation, vardiff management, and payout batching.
 */
const DEFAULT_FEES = {
  base_fee: 0.02,            //  2.0%  — operator margin
  infra_surcharge: 0.03,     //  3.0%  — servers, bandwidth, RPC nodes
  orphan_reserve: 0.02,      //  2.0%  — stale/orphan block buffer
  network_fee_escrow: 0.015, //  1.5%  — on-chain tx fee reserve
  pool_efficiency: 0.905,    // 90.5%  — operational overhead
};

/** Total fee: 99.0% */
const TOTAL_FEE = Object.values(DEFAULT_FEES).reduce((s, v) => s + v, 0);

/**
 * Default PPLNS window multiplier.
 * Window size = window_multiplier × network_difficulty (in share-diff units).
 */
const DEFAULT_WINDOW_MULTIPLIER = 2;

/**
 * Half-life for the exponential time-decay applied to older shares.
 * Shares older than this (in seconds) are worth 50% of a fresh share.
 */
const DEFAULT_DECAY_HALF_LIFE = 1800; // 30 minutes

/**
 * Minimum number of shares required before the efficiency factor is applied.
 */
const MIN_SHARES_FOR_VARIANCE = 10;

class PPLNSEngine {
  /**
   * @param {Object} opts
   * @param {string} opts.poolWallet - Pool's coinbase / fee collection address
   * @param {number} [opts.baseFee] - Base fee fraction (0-1)
   * @param {number} [opts.minPayout] - Minimum payout threshold (atomic units)
   * @param {number} [opts.networkDifficulty] - Initial network difficulty
   * @param {number} [opts.windowMultiplier] - PPLNS window size multiplier
   * @param {number} [opts.decayHalfLife] - Time-decay half-life in seconds
   */
  constructor(opts = {}) {
    this.poolWallet = opts.poolWallet || '';

    // Fee configuration
    this.fees = { ...DEFAULT_FEES };
    if (opts.baseFee !== undefined) {
      this.fees.base_fee = opts.baseFee;
    }
    this.totalFee = Object.values(this.fees).reduce((s, v) => s + v, 0);

    // PPLNS parameters
    this.networkDifficulty = opts.networkDifficulty || 1;
    this.windowMultiplier = opts.windowMultiplier || DEFAULT_WINDOW_MULTIPLIER;
    this.decayHalfLife = opts.decayHalfLife || DEFAULT_DECAY_HALF_LIFE;

    // Minimum payout threshold (in atomic units)
    this.minPayout = opts.minPayout || 100000000; // 1 PRL default

    /** @type {ShareEntry[]} */
    this.shareWindow = [];

    /** Cumulative share difficulty in the current window */
    this.windowTotalDiff = 0;

    /** @type {PayoutCalculation[]} */
    this.payoutHistory = [];

    /** Rolling buffer of recent share difficulties for variance calculation */
    this._recentShareDiffs = [];

    /** Decay constant: λ = ln(2) / half_life */
    this._decayLambda = Math.LN2 / this.decayHalfLife;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Submit a share to the PPLNS window.
   * @param {string} address - Miner wallet address
   * @param {number} difficulty - Share difficulty
   * @param {number} [timestamp] - Share submission time (ms since epoch)
   */
  addShare(address, difficulty, timestamp) {
    const now = timestamp || Date.now();

    const share = { address, difficulty, timestamp: now };
    this.shareWindow.unshift(share);
    this.windowTotalDiff += difficulty;

    this._recentShareDiffs.push(difficulty);
    if (this._recentShareDiffs.length > 1000) {
      this._recentShareDiffs.shift();
    }

    this._trimWindow();
  }

  /**
   * Process a found block: calculate PPLNS payouts and credit miner balances.
   *
   * Payout flow:
   *   1. Deduct multi-tier pool fees (infra, orphan, escrow, efficiency)
   *   2. Calculate effective share weights (efficiency × time-decay)
   *   3. Distribute net reward proportionally to miners
   *   4. Credit operator wallet with retained fees
   *   5. Record payout calculation
   *
   * @param {Object} block
   * @param {string} block.hash - Block hash
   * @param {number} block.height - Block height
   * @param {number} block.reward - Block reward (atomic units)
   * @param {string} block.finder - Address of the miner who found the block
   * @returns {PayoutCalculation} Detailed payout breakdown
   */
  processBlock(block) {
    const grossReward = block.reward;
    const now = Date.now();

    // Step 1: Multi-tier fee deduction
    const feeAmount = Math.floor(grossReward * this.totalFee);
    const netReward = grossReward - feeAmount;

    // Step 2: Calculate effective weights
    const efficiencyFactor = this._calculateEfficiencyFactor();
    const weightedShares = this._calculateWeightedShares(now, efficiencyFactor);

    // Step 3: Distribute net reward proportionally
    const minerPayouts = new Map();
    let totalEffectiveWeight = 0;

    for (const ws of weightedShares) {
      totalEffectiveWeight += ws.effectiveWeight;
    }

    if (totalEffectiveWeight === 0) {
      this._creditOperator(grossReward, block);
      return this._recordPayout(block, 0, grossReward, efficiencyFactor, new Map());
    }

    let distributedTotal = 0;

    for (const ws of weightedShares) {
      const proportion = ws.effectiveWeight / totalEffectiveWeight;
      const payout = Math.floor(netReward * proportion);

      if (payout > 0) {
        const current = minerPayouts.get(ws.address) || 0;
        minerPayouts.set(ws.address, current + payout);
        distributedTotal += payout;
      }
    }

    // Step 4: Credit miner pending balances
    for (const [address, amount] of minerPayouts) {
      store.creditPending(address, amount);
    }

    // Step 5: Credit operator wallet with all retained fees
    const operatorCredit = grossReward - distributedTotal;
    this._creditOperator(operatorCredit, block);

    return this._recordPayout(block, distributedTotal, operatorCredit, efficiencyFactor, minerPayouts);
  }

  /**
   * Get the pending (unpaid) balance for a miner.
   * @param {string} address
   * @returns {number} Pending balance in atomic units
   */
  getPendingBalance(address) {
    const pending = store.getPendingBalance(address);
    return pending.balance;
  }

  /**
   * Get recent payout records.
   * @param {number} [limit=20]
   * @returns {PayoutCalculation[]}
   */
  getPayouts(limit = 20) {
    return this.payoutHistory.slice(-limit);
  }

  /**
   * Run payout sweep: check all miners with pending >= minPayout and
   * generate payout entries.
   * @returns {PayoutEntry[]} Payouts to process
   */
  processPayouts() {
    const payouts = [];
    const allPending = store.getAllPending();

    for (const [address, entry] of allPending) {
      if (entry.balance >= this.minPayout) {
        const amount = entry.balance;
        store.debitPending(address, amount);

        payouts.push({
          address,
          amount,
          timestamp: Date.now(),
          txHash: null, // filled by the actual payout processor
        });
      }
    }

    return payouts;
  }

  /**
   * Update the network difficulty (called by chain scanner).
   * @param {number} difficulty
   */
  setNetworkDifficulty(difficulty) {
    this.networkDifficulty = difficulty;
  }

  // ---------------------------------------------------------------------------
  // Internal calculations
  // ---------------------------------------------------------------------------

  /**
   * Calculate the efficiency factor based on the variance of recent share
   * difficulties.
   *
   * In a perfectly uniform pool every share would have the same difficulty,
   * yielding efficiency_factor = 1.0.  In practice, variable difficulty
   * miners create variance that reduces effective pool efficiency.
   *
   * Formula:
   *   pool_variance = stddev(recent_share_difficulties)
   *   efficiency_factor = max(0.1, 1 - (pool_variance / network_difficulty))
   *
   * @returns {number} Efficiency factor in range [0.1, 1.0]
   * @private
   */
  _calculateEfficiencyFactor() {
    const diffs = this._recentShareDiffs;

    if (diffs.length < MIN_SHARES_FOR_VARIANCE) {
      return 1.0;
    }

    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length;
    const stddev = Math.sqrt(variance);

    const factor = 1 - (stddev / this.networkDifficulty);
    return Math.max(0.1, Math.min(1.0, factor));
  }

  /**
   * Calculate exponentially time-decayed, difficulty-weighted shares.
   *
   * For each share in the window:
   *   age_seconds = (now - share.timestamp) / 1000
   *   decay = e^(-λ × age_seconds)
   *   effective_weight = difficulty × efficiency_factor × decay
   *
   * @param {number} now - Current timestamp (ms)
   * @param {number} efficiencyFactor - From _calculateEfficiencyFactor()
   * @returns {Array<{address: string, effectiveWeight: number}>}
   * @private
   */
  _calculateWeightedShares(now, efficiencyFactor) {
    const result = [];

    for (const share of this.shareWindow) {
      const ageSeconds = (now - share.timestamp) / 1000;
      const decay = Math.exp(-this._decayLambda * Math.max(0, ageSeconds));
      const effectiveWeight = share.difficulty * efficiencyFactor * decay;

      if (effectiveWeight > 0) {
        result.push({ address: share.address, effectiveWeight });
      }
    }

    return result;
  }

  /**
   * Trim the share window to maintain the target size.
   * @private
   */
  _trimWindow() {
    const targetSize = this.networkDifficulty * this.windowMultiplier;

    while (this.windowTotalDiff > targetSize && this.shareWindow.length > 0) {
      const removed = this.shareWindow.pop();
      this.windowTotalDiff -= removed.difficulty;
    }
  }

  /**
   * Credit the operator wallet with retained amount.
   * @param {number} amount
   * @param {Object} block
   * @private
   */
  _creditOperator(amount, block) {
    if (this.poolWallet && amount > 0) {
      store.creditPending(this.poolWallet, amount);
    }
  }

  /**
   * Record a payout calculation in history.
   * @private
   */
  _recordPayout(block, distributed, operatorCredit, efficiencyFactor, minerPayouts) {
    const record = {
      blockHash: block.hash,
      blockHeight: block.height,
      timestamp: Date.now(),
      grossReward: block.reward,
      feeBreakdown: { ...this.fees },
      totalFee: this.totalFee,
      operatorCredit,
      distributed,
      efficiencyFactor: efficiencyFactor.toFixed(6),
      minerCount: minerPayouts.size,
      miners: Object.fromEntries(minerPayouts),
    };

    this.payoutHistory.push(record);
    if (this.payoutHistory.length > 1000) {
      this.payoutHistory.shift();
    }

    return record;
  }
}

module.exports = PPLNSEngine;
