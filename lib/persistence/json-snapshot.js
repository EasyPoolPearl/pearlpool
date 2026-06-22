'use strict';

/**
 * @fileoverview Atomic JSON snapshot persistence.
 *
 * Provides a tiny wrapper around `fs.promises` that:
 *   - Writes JSON to `<target>.tmp`, fsyncs, then renames over the target.
 *     This guarantees readers never see a half-written file.
 *   - Reads + JSON.parses, returning `null` (not throwing) if the file
 *     does not yet exist.
 *   - Surfaces parse / IO errors so callers can log + fall back.
 *
 * Used by `src/store.js` to durably persist pool state across restarts.
 * No external dependencies — pure Node.js built-ins, consistent with the
 * "zero dependencies" claim in the README.
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const fs = require('fs');
const path = require('path');

/**
 * Atomically write a JSON file.
 *
 * Sequence:
 *   1. Ensure the parent directory exists (mkdir -p).
 *   2. Write JSON to `<filepath>.tmp`.
 *   3. `fsync` the file handle so bytes are on disk before the rename.
 *   4. `rename(.tmp, target)` — POSIX rename is atomic.
 *
 * @param {string} filepath - Absolute or relative path to the target file
 * @param {*} data - Any JSON-serialisable value
 * @returns {Promise<void>}
 * @throws {Error} if the write, sync, or rename fails
 */
async function save(filepath, data) {
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new TypeError('save(filepath, data): filepath must be a non-empty string');
  }

  const dir = path.dirname(filepath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmp = filepath + '.tmp';
  const json = JSON.stringify(data, null, 2);

  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(json, 'utf8');
    // Force the OS to flush the data to disk before we rename.  Without
    // this, a power loss between the write and the rename could leave
    // the tmp file on disk but the target file untouched — and on the
    // next boot the operator would see stale state.  fsync closes that
    // window.
    await fh.sync();
  } finally {
    await fh.close();
  }

  // POSIX rename(2) is atomic — readers see either the old file or the
  // new file, never a half-written one.  This is the standard "write
  // and rename" pattern used by SQLite, git, and any production tool
  // that needs crash-safe config files.
  await fs.promises.rename(tmp, filepath);
}

/**
 * Read a JSON file and parse it.  Returns `null` if the file does not
 * exist (which is a normal "first start" condition, not an error).
 *
 * Parse errors and other I/O errors are re-thrown so the caller can
 * log them and decide whether to fall back to a fresh state, a
 * backup, or to refuse to start.
 *
 * @param {string} filepath
 * @returns {Promise<*|null>}
 */
async function load(filepath) {
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new TypeError('load(filepath): filepath must be a non-empty string');
  }

  let raw;
  try {
    raw = await fs.promises.readFile(filepath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }

  return JSON.parse(raw);
}

/**
 * Cheap existence check.  Returns `true` if the file is present and
 * readable.  Does NOT validate the JSON content — use `load()` for that.
 *
 * @param {string} filepath
 * @returns {Promise<boolean>}
 */
async function exists(filepath) {
  try {
    await fs.promises.access(filepath, fs.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { save, load, exists };
