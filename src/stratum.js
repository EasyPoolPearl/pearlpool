'use strict';

/**
 * @fileoverview Stratum mining protocol server for PRL mining pool.
 *
 * Implements the full stratum protocol (mining.subscribe / mining.authorize /
 * mining.submit / mining.notify) over TCP.  Share validation reconstructs the
 * block header from the coinbase + merkle branches and checks the resulting
 * digest against the worker's share target.  Block submission and miner
 * payouts are delegated to the PRL daemon via JSON-RPC (see pool.js).
 *
 * Hash function: SHA-256d (Bitcoin-style double SHA-256).  Pearl (PRL) uses
 * the same PoW hashing scheme as Bitcoin-derived chains, so this matches the
 * algorithm miners actually compute.  See TODO.md for the planned upgrade to
 * Blake3.
 */

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

/** Default stratum listen port */
const DEFAULT_PORT = 3333;

/** Default extranonce2 size in bytes */
const EXTRANONCE2_SIZE = 4;

/** Default starting difficulty */
const DEFAULT_DIFFICULTY = 64;

/** Minimum difficulty clamp */
const MIN_DIFFICULTY = 16;

/** Maximum difficulty clamp */
const MAX_DIFFICULTY = 65536;

/** Vardiff check interval in milliseconds */
const VARDIFF_INTERVAL_MS = 90000;

/** Vardiff target share interval in seconds */
const VARDIFF_TARGET_SHARE_INTERVAL = 3;

/** Maximum difficulty change multiplier per adjustment */
const VARDIFF_MAX_CHANGE_FACTOR = 4;

/**
 * Double SHA-256 hash of the block header (Bitcoin-style PoW).
 * @param {Buffer} data - Input data
 * @returns {Buffer} 32-byte hash
 */
function hashHeader(data) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(data).digest()
  ).digest();
}

/**
 * Parse a compact "nbits" value into a 32-byte target buffer.
 * Format: 0xMMMMPPPP where MMMM is the mantissa (3 bytes) and PPPP is the exponent (1 byte).
 * Target = mantissa * 2^(8*(exponent-3))
 * @param {string} nbitsHex - Compact target as hex string (e.g., "1d00ffff")
 * @returns {Buffer} 32-byte big-endian target
 */
function nbitsToTarget(nbitsHex) {
  const nbits = parseInt(nbitsHex, 16);
  const exponent = nbits & 0xff;
  const mantissa = (nbits >>> 8) & 0xffffff;

  const target = Buffer.alloc(32, 0);
  const mantissaBytes = Buffer.alloc(4, 0);
  mantissaBytes.writeUIntBE(mantissa, 0, 3);

  if (exponent <= 3) {
    const shift = 3 - exponent;
    mantissaBytes.copy(target, 32 - 3 - shift, 0, 3);
  } else {
    mantissaBytes.copy(target, 32 - exponent, 0, 3);
  }
  return target;
}

/**
 * Compare two 32-byte big-endian buffers.
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareBuffers(a, b) {
  for (let i = 0; i < 32; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Convert a difficulty number to a share target.
 * share_target = max_target / difficulty
 * max_target is the easiest target (nbits = 1d00ffff for Bitcoin-like chains).
 * @param {number} difficulty - Difficulty value
 * @returns {Buffer} 32-byte share target
 */
function difficultyToShareTarget(difficulty) {
  // max_target for nbits 1d00ffff
  const maxTarget = nbitsToTarget('1d00ffff');
  // Divide max_target by difficulty
  // We do this by dividing the big number; simplified approach using BigInt
  const maxTargetBigInt = bufferToBigInt(maxTarget);
  const shareTargetBigInt = maxTargetBigInt / BigInt(Math.floor(difficulty));
  return bigIntToBuffer(shareTargetBigInt);
}

/**
 * Convert a 32-byte Buffer to a BigInt.
 * @param {Buffer} buf - 32-byte big-endian buffer
 * @returns {bigint}
 */
function bufferToBigInt(buf) {
  return BigInt('0x' + buf.toString('hex'));
}

/**
 * Convert a BigInt to a 32-byte Buffer.
 * @param {bigint} num
 * @returns {Buffer} 32-byte big-endian buffer
 */
function bigIntToBuffer(num) {
  let hex = num.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  // Pad or truncate to 32 bytes (64 hex chars)
  hex = hex.padStart(64, '0');
  if (hex.length > 64) hex = hex.slice(hex.length - 64);
  return Buffer.from(hex, 'hex');
}

/**
 * Generate a random 8-character hex job ID.
 * @returns {string}
 */
function generateJobId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Generate a random extranonce1 value.
 * @param {number} [size=4] - Size in bytes
 * @returns {string} Hex string
 */
function generateExtranonce1(size = 4) {
  return crypto.randomBytes(size).toString('hex');
}

/**
 * @typedef {Object} MinerInfo
 * @property {string} address - Wallet address
 * @property {string} worker - Worker name
 * @property {string} extranonce1 - Assigned extranonce1 (hex)
 * @property {number} difficulty - Current difficulty
 * @property {number} sharesAccepted - Count of accepted shares
 * @property {number} sharesRejected - Count of rejected shares
 * @property {number[]} shareTimestamps - Timestamps of recent shares for vardiff
 * @property {string|null} currentJobId - Current active job ID
 * @property {boolean} authorized - Whether miner is authorized
 * @property {boolean} subscribed - Whether miner has subscribed
 */

/**
 * Represents a connected miner.
 */
class Miner {
  /**
   * @param {net.Socket} socket - The TCP socket
   * @param {string} extranonce1 - Assigned extranonce1
   * @param {number} difficulty - Initial difficulty
   */
  constructor(socket, extranonce1, difficulty) {
    /** @type {net.Socket} */
    this.socket = socket;
    /** @type {string} */
    this.extranonce1 = extranonce1;
    /** @type {number} */
    this.difficulty = difficulty;
    /** @type {string} */
    this.address = '';
    /** @type {string} */
    this.worker = '';
    /** @type {boolean} */
    this.subscribed = false;
    /** @type {boolean} */
    this.authorized = false;
    /** @type {number} */
    this.sharesAccepted = 0;
    /** @type {number} */
    this.sharesRejected = 0;
    /** @type {number[]} */
    this.shareTimestamps = [];
    /** @type {string|null} */
    this.currentJobId = null;
    /** @type {string} */
    this.id = socket.remoteAddress + ':' + socket.remotePort;
    /** @type {Set<string>} */
    this.submittedNonces = new Set();
    /** @type {number} */
    this.connectTime = Date.now();
  }

  /**
   * Get the miner identifier (address.worker).
   * @returns {string}
   */
  getIdentifier() {
    return this.address + '.' + this.worker;
  }

  /**
   * Calculate estimated hashrate from share rate.
   * hashrate = (shares_per_second * difficulty * 2^32)
   * @returns {number} Hashes per second
   */
  getHashrate() {
    const now = Date.now();
    const windowMs = 60000; // 1 minute window
    const recentShares = this.shareTimestamps.filter(t => t > now - windowMs);
    if (recentShares.length === 0) return 0;
    const sharesPerSecond = recentShares.length / (windowMs / 1000);
    return sharesPerSecond * this.difficulty * Math.pow(2, 32);
  }

  /**
   * Record a share timestamp for vardiff calculations.
   */
  recordShare() {
    this.shareTimestamps.push(Date.now());
    // Keep only last 5 minutes of timestamps
    const cutoff = Date.now() - 300000;
    this.shareTimestamps = this.shareTimestamps.filter(t => t > cutoff);
  }

  /**
   * Send a JSON-RPC message to the miner.
   * @param {Object} message - JSON-RPC message
   */
  send(message) {
    if (this.socket.destroyed) return;
    try {
      this.socket.write(JSON.stringify(message) + '\n');
    } catch (err) {
      // Socket write failed, will be cleaned up on error/close
    }
  }

  /**
   * Send an RPC response.
   * @param {number|null} id - Request ID
   * @param {*} result - Result value
   * @param {Object|null} [error=null] - Error object
   */
  sendResponse(id, result, error = null) {
    const msg = { id, result };
    if (error) {
      delete msg.result;
      msg.error = error;
    }
    this.send(msg);
  }

  /**
   * Send an RPC notification (no id).
   * @param {string} method - Method name
   * @param {Array} params - Parameters
   */
  sendNotification(method, params) {
    this.send({ method, params });
  }
}

/**
 * Stratum mining protocol server.
 * @extends EventEmitter
 */
class StratumServer extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {number} [options.port=3333] - Listen port
   * @param {number} [options.defaultDifficulty=64] - Initial difficulty for new miners
   * @param {number} [options.extranonce2Size=4] - Extranonce2 size in bytes
   * @param {string} [options.host='0.0.0.0'] - Bind address
   */
  constructor(options = {}) {
    super();
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || '0.0.0.0';
    this.defaultDifficulty = options.defaultDifficulty || DEFAULT_DIFFICULTY;
    this.extranonce2Size = options.extranonce2Size || EXTRANONCE2_SIZE;

    /** @type {net.Server|null} */
    this.server = null;
    /** @type {Map<string, Miner>} */
    this.miners = new Map();
    /** @type {Map<string, Object>} */
    this.jobs = new Map();
    /** @type {Object|null} */
    this.currentJob = null;
    /** @type {Object|null} */
    this.currentTemplate = null;

    /** @type {number} */
    this.totalShares = 0;
    /** @type {number} */
    this.totalBlocks = 0;

    /** @type {NodeJS.Timeout|null} */
    this._vardiffTimer = null;
  }

  /**
   * Start the stratum server.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._handleConnection(socket));

      this.server.on('error', (err) => {
        console.error('[Stratum] Server error:', err.message);
        this.emit('error', err);
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[Stratum] Listening on ${this.host}:${this.port}`);
        this._startVardiffTimer();
        resolve();
      });
    });
  }

  /**
   * Stop the stratum server and disconnect all miners.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (this._vardiffTimer) {
        clearInterval(this._vardiffTimer);
        this._vardiffTimer = null;
      }

      for (const miner of this.miners.values()) {
        miner.socket.destroy();
      }
      this.miners.clear();

      if (this.server) {
        this.server.close(() => {
          console.log('[Stratum] Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle a new TCP connection.
   * @param {net.Socket} socket
   * @private
   */
  _handleConnection(socket) {
    const extranonce1 = generateExtranonce1();
    const miner = new Miner(socket, extranonce1, this.defaultDifficulty);
    const minerId = miner.id;

    this.miners.set(minerId, miner);
    console.log(`[Stratum] New connection from ${minerId}`);
    this.emit('connect', miner);

    socket.setKeepAlive(true, 60000);
    socket.setEncoding('utf8');

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.substring(0, newlineIndex).trim();
        buffer = buffer.substring(newlineIndex + 1);
        if (line.length > 0) {
          this._handleMessage(miner, line);
        }
      }
    });

    socket.on('close', () => {
      console.log(`[Stratum] Connection closed: ${minerId}`);
      this.miners.delete(minerId);
      this.emit('disconnect', miner);
    });

    socket.on('error', (err) => {
      console.error(`[Stratum] Socket error for ${minerId}:`, err.message);
      this.miners.delete(minerId);
      this.emit('disconnect', miner);
    });
  }

  /**
   * Parse and handle an incoming JSON-RPC message from a miner.
   * @param {Miner} miner
   * @param {string} line - Raw JSON string
   * @private
   */
  _handleMessage(miner, line) {
    /** @type {Object} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.warn(`[Stratum] Malformed JSON from ${miner.id}: ${line.substring(0, 100)}`);
      miner.sendResponse(null, null, [20, 'Parse error']);
      return;
    }

    const method = msg.method;
    const params = msg.params || [];
    const id = msg.id;

    switch (method) {
      case 'mining.subscribe':
        this._handleSubscribe(miner, id, params);
        break;
      case 'mining.authorize':
        this._handleAuthorize(miner, id, params);
        break;
      case 'mining.submit':
        this._handleSubmit(miner, id, params);
        break;
      case 'mining.extranonce.subscribe':
        // Some miners send this; acknowledge
        miner.sendResponse(id, true);
        break;
      default:
        console.warn(`[Stratum] Unknown method '${method}' from ${miner.id}`);
        miner.sendResponse(id, null, [20, 'Unknown method']);
    }
  }

  /**
   * Handle mining.subscribe request.
   * @param {Miner} miner
   * @param {number} id - Request ID
   * @param {Array} params
   * @private
   */
  _handleSubscribe(miner, id, params) {
    if (miner.subscribed) {
      miner.sendResponse(id, null, [25, 'Already subscribed']);
      return;
    }

    miner.subscribed = true;

    const result = [
      // Subscription details
      [
        ['mining.set_difficulty', miner.extranonce1],
        ['mining.notify', miner.extranonce1]
      ],
      // extranonce1
      miner.extranonce1,
      // extranonce2_size
      this.extranonce2Size
    ];

    miner.sendResponse(id, result);
    console.log(`[Stratum] Miner subscribed: ${miner.id} (extranonce1=${miner.extranonce1})`);
  }

  /**
   * Handle mining.authorize request.
   * @param {Miner} miner
   * @param {number} id - Request ID
   * @param {Array} params - [username, password]
   * @private
   */
  _handleAuthorize(miner, id, params) {
    if (!miner.subscribed) {
      miner.sendResponse(id, null, [25, 'Not subscribed']);
      return;
    }

    const username = params[0] || '';
    const parts = username.split('.');
    miner.address = parts[0] || username;
    miner.worker = parts[1] || 'default';

    if (!miner.address || miner.address.length < 10) {
      miner.sendResponse(id, null, [24, 'Invalid address']);
      return;
    }

    miner.authorized = true;
    miner.sendResponse(id, true);
    console.log(`[Stratum] Miner authorized: ${miner.getIdentifier()}`);

    // Send initial difficulty
    miner.sendNotification('mining.set_difficulty', [miner.difficulty]);

    // Send current job if available
    if (this.currentJob) {
      this._sendJob(miner, this.currentJob, true);
    }
  }

  /**
   * Handle mining.submit request.
   * @param {Miner} miner
   * @param {number} id - Request ID
   * @param {Array} params - [username, job_id, extranonce2, ntime, nonce]
   * @private
   */
  _handleSubmit(miner, id, params) {
    if (!miner.authorized) {
      miner.sendResponse(id, null, [24, 'Not authorized']);
      return;
    }

    const [username, jobId, extranonce2, ntime, nonce] = params;

    // Validate required fields
    if (!jobId || !extranonce2 || !ntime || !nonce) {
      miner.sendResponse(id, false);
      miner.sharesRejected++;
      return;
    }

    // Look up the job
    const job = this.jobs.get(jobId);
    if (!job) {
      miner.sendResponse(id, null, [21, 'Job not found']);
      miner.sharesRejected++;
      return;
    }

    // Check for duplicate nonce submission
    const nonceKey = jobId + ':' + nonce + ':' + extranonce2;
    if (miner.submittedNonces.has(nonceKey)) {
      miner.sendResponse(id, null, [22, 'Duplicate share']);
      miner.sharesRejected++;
      return;
    }
    miner.submittedNonces.add(nonceKey);
    // Keep the set from growing unbounded
    if (miner.submittedNonces.size > 10000) {
      const arr = Array.from(miner.submittedNonces);
      miner.submittedNonces = new Set(arr.slice(arr.length - 5000));
    }

    // Validate the share
    const validation = this._validateShare(miner, job, extranonce2, ntime, nonce);

    miner.recordShare();
    this.totalShares++;

    if (validation.isValid) {
      miner.sharesAccepted++;
      miner.sendResponse(id, true);
      console.log(
        `[Stratum] Accepted share from ${miner.getIdentifier()} ` +
        `(job=${jobId}, diff=${miner.difficulty})` +
        (validation.isBlock ? ' *** BLOCK FOUND! ***' : '')
      );

      this.emit('share', {
        miner,
        job,
        difficulty: miner.difficulty,
        isValid: true,
        isBlock: validation.isBlock
      });

      if (validation.isBlock) {
        this.totalBlocks++;
        this.emit('blockFound', {
          miner,
          job,
          hash: validation.hash
        });
      }
    } else {
      miner.sharesRejected++;
      miner.sendResponse(id, false);
      console.warn(
        `[Stratum] Rejected share from ${miner.getIdentifier()} ` +
        `(job=${jobId}, reason=${validation.reason})`
      );

      this.emit('share', {
        miner,
        job,
        difficulty: miner.difficulty,
        isValid: false,
        isBlock: false
      });
    }
  }

  /**
   * Validate a submitted share by reconstructing and hashing the block header.
   *
   * @param {Miner} miner
   * @param {Object} job - The job object
   * @param {string} extranonce2 - Miner's extranonce2 (hex)
   * @param {string} ntime - Miner's ntime (hex)
   * @param {string} nonce - Miner's nonce (hex)
   * @returns {{ isValid: boolean, isBlock: boolean, hash: string|null, reason: string|null }}
   * @private
   */
  _validateShare(miner, job, extranonce2, ntime, nonce) {
    try {
      // Step 1: Build the coinbase transaction
      const coinbase = Buffer.concat([
        Buffer.from(job.coinb1, 'hex'),
        Buffer.from(miner.extranonce1, 'hex'),
        Buffer.from(extranonce2, 'hex'),
        Buffer.from(job.coinb2, 'hex')
      ]);

      // Step 2: Compute merkle root (double SHA-256 of coinbase, then hash with merkle branches)
      let merkleRoot = hashHeader(coinbase);
      for (const branch of (job.merkleBranches || [])) {
        merkleRoot = hashHeader(Buffer.concat([merkleRoot, Buffer.from(branch, 'hex')]));
      }

      // Step 3: Reconstruct the 80-byte block header
      // Layout: version(4) + prev_hash(32) + merkle_root(32) + ntime(4) + nbits(4) + nonce(4)
      const header = Buffer.alloc(80, 0);

      // Version (4 bytes, little-endian)
      const version = parseInt(job.version, 16) || parseInt(job.version) || 0x20000000;
      header.writeUInt32LE(version, 0);

      // Previous hash (32 bytes, reversed for internal byte order)
      const prevHash = Buffer.from(job.prevHash, 'hex');
      // Reverse for little-endian block header format
      const prevHashReversed = Buffer.from(prevHash).reverse();
      prevHashReversed.copy(header, 4);

      // Merkle root (32 bytes, reversed)
      const merkleReversed = Buffer.from(merkleRoot).reverse();
      merkleReversed.copy(header, 36);

      // Ntime (4 bytes, little-endian)
      const ntimeInt = parseInt(ntime, 16);
      header.writeUInt32LE(ntimeInt, 68);

      // Nbits (4 bytes, little-endian) - compact target
      const nbitsInt = parseInt(job.nbits, 16);
      header.writeUInt32LE(nbitsInt, 72);

      // Nonce (4 bytes, little-endian)
      const nonceInt = parseInt(nonce, 16);
      header.writeUInt32LE(nonceInt, 76);

      // Step 4: Double SHA-256 hash the header
      const hash = hashHeader(header);
      const hashReversed = Buffer.from(hash).reverse();

      // Step 5: Compare against targets
      const shareTarget = difficultyToShareTarget(miner.difficulty);
      const networkTarget = nbitsToTarget(job.nbits);

      const isShareValid = compareBuffers(hash, shareTarget) <= 0;
      const isBlock = compareBuffers(hash, networkTarget) <= 0;

      return {
        isValid: isShareValid,
        isBlock,
        hash: hashReversed.toString('hex'),
        reason: isShareValid ? null : 'Low difficulty share'
      };
    } catch (err) {
      console.error(`[Stratum] Share validation error:`, err.message);
      return { isValid: false, isBlock: false, hash: null, reason: 'Validation error: ' + err.message };
    }
  }

  /**
   * Set a new block template and create a job for miners.
   * Called by the scanner when a new block template is available.
   * @param {Object} template - Block template from getblocktemplate
   */
  setBlockTemplate(template) {
    this.currentTemplate = template;

    const job = this._createJob(template);
    this.currentJob = job;
    this.jobs.set(job.jobId, job);

    // Clean up old jobs (keep last 10)
    const jobIds = Array.from(this.jobs.keys());
    if (jobIds.length > 10) {
      for (let i = 0; i < jobIds.length - 10; i++) {
        this.jobs.delete(jobIds[i]);
      }
    }

    // Broadcast to all authorized miners
    for (const miner of this.miners.values()) {
      if (miner.authorized) {
        this._sendJob(miner, job, true);
      }
    }

    console.log(`[Stratum] New job broadcast: ${job.jobId} (prevHash=${job.prevHash.substring(0, 16)}...)`);
  }

  /**
   * Create a mining job from a block template.
   * @param {Object} template - Block template
   * @returns {Object} Job object
   * @private
   */
  _createJob(template) {
    // Extract coinbase transaction data from the template
    const coinbaseTx = template.transactions && template.transactions[0];
    let coinb1, coinb2;

    if (coinbaseTx && coinbaseTx.data) {
      // If we have a real coinbase transaction, split it for extranonce insertion
      // coinb1 = first half (up to where extranonce goes)
      // coinb2 = second half (after extranonce)
      const txData = coinbaseTx.data;
      // Insert extranonce after the script length prefix (typically first ~42 bytes for coinbase)
      const splitPoint = Math.min(txData.length / 2, 42);
      coinb1 = txData.substring(0, splitPoint);
      coinb2 = txData.substring(splitPoint);
    } else {
      // Generate a minimal coinbase for testing
      coinb1 = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff';
      coinb2 = 'ffffffff0100000000000000000000000000';
    }

    return {
      jobId: generateJobId(),
      prevHash: template.previousblockhash || template.prevHash || '0'.repeat(64),
      coinb1,
      coinb2,
      merkleBranches: [],
      version: (template.version || 0x20000000).toString(16),
      nbits: template.bits || '1d00ffff',
      ntime: Math.floor(Date.now() / 1000).toString(16),
      template,
      createdAt: Date.now()
    };
  }

  /**
   * Send a job notification to a specific miner.
   * @param {Miner} miner
   * @param {Object} job
   * @param {boolean} cleanJobs - Whether miner should abandon previous work
   * @private
   */
  _sendJob(miner, job, cleanJobs) {
    miner.currentJobId = job.jobId;

    miner.sendNotification('mining.notify', [
      job.jobId,
      job.prevHash,
      job.coinb1,
      job.coinb2,
      job.merkleBranches,
      job.version,
      job.nbits,
      job.ntime,
      cleanJobs
    ]);
  }

  /**
   * Start the vardiff timer that periodically adjusts miner difficulties.
   * @private
   */
  _startVardiffTimer() {
    this._vardiffTimer = setInterval(() => {
      this._adjustDifficulties();
    }, VARDIFF_INTERVAL_MS);
  }

  /**
   * Adjust difficulty for all connected miners based on share rate.
   * @private
   */
  _adjustDifficulties() {
    const now = Date.now();

    for (const miner of this.miners.values()) {
      if (!miner.authorized) continue;

      // Get shares in the last vardiff interval
      const intervalShares = miner.shareTimestamps.filter(
        t => t > now - VARDIFF_INTERVAL_MS
      );

      // Need at least some shares to adjust
      if (intervalShares.length < 2) continue;

      const actualInterval = (now - intervalShares[0]) / 1000; // seconds
      const shareRate = intervalShares.length / actualInterval;

      // Target: 1 share per TARGET_SHARE_INTERVAL seconds
      const targetRate = 1 / VARDIFF_TARGET_SHARE_INTERVAL;
      let newDiff = miner.difficulty * (targetRate / shareRate);

      // Clamp difficulty
      newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDiff));

      // Limit change to 4x
      if (newDiff > miner.difficulty * VARDIFF_MAX_CHANGE_FACTOR) {
        newDiff = miner.difficulty * VARDIFF_MAX_CHANGE_FACTOR;
      }
      if (newDiff < miner.difficulty / VARDIFF_MAX_CHANGE_FACTOR) {
        newDiff = miner.difficulty / VARDIFF_MAX_CHANGE_FACTOR;
      }

      newDiff = Math.floor(newDiff);

      if (newDiff !== miner.difficulty) {
        const oldDiff = miner.difficulty;
        miner.difficulty = newDiff;
        miner.sendNotification('mining.set_difficulty', [newDiff]);
        console.log(
          `[Stratum] Vardiff: ${miner.getIdentifier()} ${oldDiff} → ${newDiff}`
        );
      }
    }
  }

  /**
   * Get connected miner count.
   * @returns {number}
   */
  getMinerCount() {
    return this.miners.size;
  }

  /**
   * Get pool statistics.
   * @returns {Object}
   */
  getStats() {
    let totalHashrate = 0;
    for (const miner of this.miners.values()) {
      totalHashrate += miner.getHashrate();
    }

    return {
      miners: this.miners.size,
      totalShares: this.totalShares,
      totalBlocks: this.totalBlocks,
      totalHashrate,
      currentJob: this.currentJob ? this.currentJob.jobId : null,
      currentTemplate: this.currentTemplate ? {
        height: this.currentTemplate.height,
        prevHash: (this.currentTemplate.previousblockhash || '').substring(0, 16) + '...'
      } : null
    };
  }
}

module.exports = { StratumServer, Miner };
