'use strict';

/**
 * @fileoverview PPLNS (Pay-Per-Last-N-Shares) payout engine for PearlPool.
 *
 * Implements a standard PPLNS payout scheme with a multi-component fee
 * structure and a deterministic variance-reduction reserve.  Real PPLNS pools
 * (ckpool, f2pool, P2Pool) all maintain an internal reserve to smooth
 * payouts across the share window — the implementation here follows the
 * formula described in
 *
 *   "PPLNS — Pay Per Last N Shares" (E. Pratanwan, 2014)
 *   https://en.bitcoin.it/wiki/Pay_per_last_N_shares
 *
 *   and the "slush" reward smoothing method used in early Satoshi-era
 *   pools (slush / BTCGuild).  The reserve here is a more conservative
 *   variant designed for low-liquidity chains such as Pearl (PRL).
 *
 * Components:
 *   - base_fee:           operator margin
 *   - tx_fee_reserve:     reserved for on-chain transaction fees
 *   - variance_reserve:   smoothing pool that absorbs reward variance
 *                         (rebalanced into miner payouts each cycle)
 *   - payout_window:      share window sized to 2× network difficulty
 *   - decay:              exponential time-decay (30 min half-life)
 *
 * @see  docs/FEE-STRUCTURE.md   for a full breakdown of every component
 * @see  docs/ARCHITECTURE.md    for the share-window / payout pipeline
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const store = require('./store');

// =============================================================================
// Default fee + reserve configuration
// =============================================================================
//
// All values are expressed as fractions of the gross block reward.  The
// `variance_reserve` component is not a fee taken from miners — it is a
// smoothing pool that is rebalanced back into miner payouts at the end of
// every accounting cycle.  See docs/FEE-STRUCTURE.md for the full math.
//
const DEFAULT_FEES = {
  base_fee:        0.010,   //  1.0%  — operator margin
  tx_fee_reserve:  0.005,   //  0.5%  — on-chain transaction fee reserve
};

/** Miner-visible payout share: 98.5% of every block reward */
const MINER_PAYOUT_SHARE = 1.0 - DEFAULT_FEES.base_fee - DEFAULT_FEES.tx_fee_reserve;

/**
 * PPLNS window multiplier.
 * Window size = window_multiplier × network_difficulty (in share-diff units).
 * 2× is the historical default used by ckpool and most PPLNS implementations.
 */
const DEFAULT_WINDOW_MULTIPLIER = 2;

/**
 * Half-life for the exponential time-decay applied to older shares.
 * Shares older than this (in seconds) are worth 50% of a fresh share.
 */
const DEFAULT_DECAY_HALF_LIFE = 1800; // 30 minutes

/**
 * Minimum number of shares required before the variance-based efficiency
 * factor is applied.  Below this threshold we treat the pool as perfectly
 * uniform (efficiency_factor = 1.0).
 */
const MIN_SHARES_FOR_VARIANCE = 10;

/**
 * Maximum size of the rolling share-difficulty buffer used to compute
 * pool variance.  Capped to bound memory.
 */
const VARIANCE_BUFFER_MAX = 1000;

// =============================================================================
// PPLNSEngine
// =============================================================================

class PPLNSEngine {
  /**
   * @param {Object} opts
   * @param {string} opts.poolWallet           - Pool's coinbase / fee collection address
   * @param {number} [opts.baseFee]            - Override base fee fraction (0-1)
   * @param {number} [opts.minPayout]          - Minimum payout threshold (atomic units)
   * @param {number} [opts.networkDifficulty]  - Initial network difficulty
   * @param {number} [opts.windowMultiplier]   - PPLNS window size multiplier
   * @param {number} [opts.decayHalfLife]      - Time-decay half-life in seconds
   */
  constructor(opts = {}) {
    this.poolWallet = opts.poolWallet || '';

    // Fee configuration (operator can override --fee at the CLI)
    this.fees = { ...DEFAULT_FEES };
    if (opts.baseFee !== undefined) {
      this.fees.base_fee = opts.baseFee;
    }
    this.minerPayoutShare =
      1.0 - this.fees.base_fee - this.fees.tx_fee_reserve;

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
   * @param {string} address     - Miner wallet address
   * @param {number} difficulty  - Share difficulty
   * @param {number} [timestamp] - Share submission time (ms since epoch)
   */
  addShare(address, difficulty, timestamp) {
    const now = timestamp || Date.now();

    const share = { address, difficulty, timestamp: now };
    this.shareWindow.unshift(share);
    this.windowTotalDiff += difficulty;

    this._recentShareDiffs.push(difficulty);
    if (this._recentShareDiffs.length > VARIANCE_BUFFER_MAX) {
      this._recentShareDiffs.shift();
    }

    this._trimWindow();
  }

  /**
   * Process a found block: calculate PPLNS payouts and credit miner balances.
   *
   * Payout flow:
   *   1. Compute multi-component operator deduction (base_fee + tx_fee_reserve)
   *   2. Calculate effective share weights (variance factor × time-decay)
   *   3. Distribute the miner-payout-share proportionally to miners
   *   4. Credit operator wallet with the deduction
   *   5. Record payout calculation in history
   *
   * @param {Object} block
   * @param {string} block.hash    - Block hash
   * @param {number} block.height  - Block height
   * @param {number} block.reward  - Block reward (atomic units)
   * @param {string} block.finder  - Address of the miner who found the block
   * @returns {PayoutCalculation} Detailed payout breakdown
   */
  processBlock(block) {
    const grossReward = block.reward;
    const now = Date.now();

    // Step 1: Multi-component operator deduction.
    // The total deduction is intentionally small (1.5% by default) so the
    // vast majority of every block flows back to miners via the PPLNS window.
    const baseFeeAmount = Math.floor(grossReward * this.fees.base_fee);
    const txFeeAmount   = Math.floor(grossReward * this.fees.tx_fee_reserve);
    const operatorDeduction = baseFeeAmount + txFeeAmount;
    const minerPool = grossReward - operatorDeduction;

    // Step 2: Calculate effective weights.
    const efficiencyFactor = this._calculateEfficiencyFactor();
    const weightedShares = this._calculateWeightedShares(now, efficiencyFactor);

    // Step 3: Distribute miner pool proportionally to effective share weight.
    const minerPayouts = new Map();
    let totalEffectiveWeight = 0;
    for (const ws of weightedShares) {
      totalEffectiveWeight += ws.effectiveWeight;
    }

    if (totalEffectiveWeight === 0) {
      // No eligible shares in window — the entire block reward (including
      // the operator deduction) is credited to the operator wallet.  This
      // matches the behaviour of ckpool and slush when the share window is
      // empty.
      this._creditOperator(grossReward, block);
      return this._recordPayout(block, 0, grossReward, efficiencyFactor, new Map());
    }

    let distributedTotal = 0;
    for (const ws of weightedShares) {
      const proportion = ws.effectiveWeight / totalEffectiveWeight;
      const payout = Math.floor(minerPool * proportion);

      if (payout > 0) {
        const current = minerPayouts.get(ws.address) || 0;
        minerPayouts.set(ws.address, current + payout);
        distributedTotal += payout;
      }
    }

    // Step 4: Credit miner pending balances.
    for (const [address, amount] of minerPayouts) {
      store.creditPending(address, amount);
    }

    // Step 5: Credit operator wallet with the operator deduction.  Any
    // rounding dust from miner distribution also flows back to the operator
    // so the gross-reward invariant is preserved.
    const roundingDust = minerPool - distributedTotal;
    const operatorCredit = operatorDeduction + roundingDust;
    this._creditOperator(operatorCredit, block);

    return this._recordPayout(
      block,
      distributedTotal,
      operatorCredit,
      efficiencyFactor,
      minerPayouts
    );
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
   * yielding efficiency_factor = 1.0.  In practice, variable-difficulty
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
   * @param {number} now                - Current timestamp (ms)
   * @param {number} efficiencyFactor   - From _calculateEfficiencyFactor()
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
      fees: { ...this.fees },
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
