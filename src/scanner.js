'use strict';

/**
 * @fileoverview Chain scanner / block monitor for PRL mining pool.
 * Connects to a PRL node via JSON-RPC HTTP and polls for new block templates.
 *
 * Communicates with the PRL daemon using standard Bitcoin-like JSON-RPC:
 *   - getblocktemplate: Get mining block template
 *   - getblockcount: Get current block height
 *   - getblockhash: Get block hash by height
 *   - getblock: Get block details
 *   - getnetworkinfo: Get network info (hashrate, difficulty)
 */

const http = require('http');
const { URL } = require('url');
const EventEmitter = require('events');

/** Default RPC endpoint URL (matches the port documented in README.md). */
const DEFAULT_RPC_URL = 'http://127.0.0.1:9933';

/** Default poll interval in milliseconds */
const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Default RPC request timeout in milliseconds */
const DEFAULT_RPC_TIMEOUT_MS = 5000;

/**
 * ChainScanner connects to a PRL node and monitors for new block templates.
 * Emits 'newBlock' when a new block template is available.
 * @extends EventEmitter
 */
class ChainScanner extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.rpcUrl='http://127.0.0.1:9933'] - PRL RPC endpoint URL
   * @param {string} [options.rpcUser=''] - RPC username (for basic auth)
   * @param {string} [options.rpcPassword=''] - RPC password (for basic auth)
   * @param {number} [options.pollIntervalMs=1000] - Polling interval in milliseconds
   * @param {number} [options.rpcTimeoutMs=5000] - RPC request timeout in milliseconds
   */
  constructor(options = {}) {
    super();

    /** @type {string} Full RPC URL */
    this.rpcUrl = options.rpcUrl || DEFAULT_RPC_URL;
    /** @type {string} RPC username */
    this.rpcUser = options.rpcUser || '';
    /** @type {string} RPC password */
    this.rpcPassword = options.rpcPassword || '';
    /** @type {number} Poll interval in ms */
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    /** @type {number} RPC timeout in ms */
    this.rpcTimeoutMs = options.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;

    /** @type {number} Current block height */
    this.currentHeight = 0;
    /** @type {number} Current network difficulty */
    this.currentDifficulty = 0;
    /** @type {number} Estimated network hashrate */
    this.networkHashrate = 0;
    /** @type {Object|null} Current block template */
    this.blockTemplate = null;
    /** @type {string} Current prev hash for change detection */
    this._currentPrevHash = '';
    /** @type {boolean} Whether the scanner is running */
    this.running = false;
    /** @type {NodeJS.Timeout|null} */
    this._pollTimer = null;
    /** @type {number} RPC call ID counter */
    this._rpcId = 0;
    /** @type {number} Error count for backoff */
    this._consecutiveErrors = 0;
  }

  /**
   * Start the chain scanner polling loop.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.running) {
      console.log('[Scanner] Already running');
      return;
    }

    this.running = true;
    this._consecutiveErrors = 0;
    console.log(`[Scanner] Starting chain scanner (RPC: ${this.rpcUrl})`);

    // Initial fetch
    await this._poll();

    // Start polling loop
    this._scheduleNextPoll();
  }

  /**
   * Stop the chain scanner.
   */
  stop() {
    this.running = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    console.log('[Scanner] Stopped');
  }

  /**
   * Get the current block template.
   * @returns {Object|null}
   */
  getCurrentTemplate() {
    return this.blockTemplate;
  }

  /**
   * Get network information (cached values from last poll).
   * @returns {{ height: number, difficulty: number, hashrate: number }}
   */
  getNetworkInfo() {
    return {
      height: this.currentHeight,
      difficulty: this.currentDifficulty,
      hashrate: this.networkHashrate
    };
  }

  /**
   * Schedule the next poll with optional backoff on errors.
   * @private
   */
  _scheduleNextPoll() {
    if (!this.running) return;

    // Exponential backoff on consecutive errors: 1s, 2s, 4s, 8s, max 30s
    const backoffMs = Math.min(
      this.pollIntervalMs * Math.pow(2, this._consecutiveErrors),
      30000
    );

    this._pollTimer = setTimeout(async () => {
      await this._poll();
      this._scheduleNextPoll();
    }, backoffMs);
  }

  /**
   * Execute one poll cycle: fetch block template and check for changes.
   * @private
   */
  async _poll() {
    try {
      // Fetch new block template
      const template = await this.rpcCall('getblocktemplate', [
        { rules: ['segwit'] }
      ]);

      if (!template || !template.previousblockhash) {
        console.warn('[Scanner] Received invalid block template (missing previousblockhash)');
        return;
      }

      this._consecutiveErrors = 0;

      // Check if template changed
      const prevHash = template.previousblockhash;
      const height = template.height || 0;

      if (prevHash !== this._currentPrevHash || height !== this.currentHeight) {
        const isFirstTemplate = this._currentPrevHash === '';

        this._currentPrevHash = prevHash;
        this.currentHeight = height;
        this.blockTemplate = template;

        console.log(
          `[Scanner] New block template: height=${height}, ` +
          `prevHash=${prevHash.substring(0, 16)}...`
        );

        // Emit new block event
        this.emit('newBlock', template);

        // If it's the first template, also try to fetch network info
        if (isFirstTemplate) {
          await this._fetchNetworkInfo();
        }
      }
    } catch (err) {
      this._consecutiveErrors++;
      console.error(
        `[Scanner] Poll error (consecutive: ${this._consecutiveErrors}): ${err.message}`
      );
      this.emit('error', err);
    }
  }

  /**
   * Fetch network information (difficulty, hashrate) from the node.
   * @private
   */
  async _fetchNetworkInfo() {
    try {
      const info = await this.rpcCall('getnetworkinfo', []);

      if (info) {
        this.currentDifficulty = info.difficulty || 0;
        this.networkHashrate = info.networkhashps || info.hashrate || 0;

        console.log(
          `[Scanner] Network info: difficulty=${this.currentDifficulty}, ` +
          `hashrate=${this.networkHashrate}`
        );
      }
    } catch (err) {
      console.warn(`[Scanner] Failed to fetch network info: ${err.message}`);
    }
  }

  /**
   * Make a JSON-RPC call to the PRL node.
   *
   * @param {string} method - RPC method name
   * @param {Array} params - RPC parameters
   * @returns {Promise<*>} The RPC result
   * @throws {Error} On RPC errors or connection failures
   */
  rpcCall(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this._rpcId;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      });

      const parsed = new URL(this.rpcUrl);

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname || '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: this.rpcTimeoutMs
      };

      // Add basic auth if credentials provided
      if (this.rpcUser && this.rpcPassword) {
        const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString('base64');
        options.headers['Authorization'] = `Basic ${auth}`;
      }

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`RPC HTTP error: ${res.statusCode} ${data.substring(0, 200)}`));
            return;
          }

          try {
            const response = JSON.parse(data);

            if (response.error) {
              const err = response.error;
              reject(new Error(`RPC error ${err.code}: ${err.message}`));
              return;
            }

            resolve(response.result);
          } catch (parseErr) {
            reject(new Error(`RPC parse error: ${parseErr.message}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`RPC connection error: ${err.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('RPC request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Get block hash by height.
   * @param {number} height - Block height
   * @returns {Promise<string>} Block hash
   */
  async getBlockHash(height) {
    return this.rpcCall('getblockhash', [height]);
  }

  /**
   * Get block details by hash.
   * @param {string} hash - Block hash
   * @param {number} [verbosity=1] - Verbosity level (0=hex, 1=json, 2=json+txdecoded)
   * @returns {Promise<Object>} Block data
   */
  async getBlock(hash, verbosity = 1) {
    return this.rpcCall('getblock', [hash, verbosity]);
  }

  /**
   * Get current block count (height).
   * @returns {Promise<number>}
   */
  async getBlockCount() {
    return this.rpcCall('getblockcount', []);
  }

  /**
   * Get detailed network info.
   * @returns {Promise<Object>}
   */
  async getNetworkInfo() {
    return this.rpcCall('getnetworkinfo', []);
  }
}

module.exports = { ChainScanner };
