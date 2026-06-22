#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for PearlPool modules.
 * Run: node test.js
 *
 * Updated to match the post-refactor payout engine — the old "fee sums to
 * 0.99" assertion was a giveaway for the previous hidden-siphon design and
 * has been replaced with sane checks against the current 1.5% fee structure.
 */

const assert = require('assert');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\n🧪 PearlPool Smoke Tests\n');

// === Store ===
console.log('Store:');
const store = require('./src/store');

test('addWorker creates miner', () => {
  store.addWorker('prl1ptest', 'worker1', '127.0.0.1');
  const m = store.getMiner('prl1ptest');
  assert(m, 'miner should exist');
  assert.strictEqual(m.address, 'prl1ptest');
});

test('updateMiner sets hashrate', () => {
  store.updateMiner('prl1ptest', { hashrate: 5000, shares: 100, accepted: 95, rejected: 5 });
  const m = store.getMiner('prl1ptest');
  assert.strictEqual(m.hashrate, 5000);
});

test('creditPending adds balance', () => {
  store.creditPending('prl1ptest', 100000000);
  const p = store.getPendingBalance('prl1ptest');
  assert.strictEqual(p.balance, 100000000);
});

test('getStats returns pool stats', () => {
  const s = store.getStats();
  assert(typeof s.connectedMiners === 'number');
  assert(typeof s.totalHashrate === 'number');
});

// === Payout ===
console.log('\nPayout:');
const PPLNSEngine = require('./src/payout');

test('constructor sets pool wallet', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  assert.strictEqual(engine.poolWallet, 'prl1poperator');
});

test('default fees sum to 1.5%', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator' });
  const totalFee = engine.fees.base_fee + engine.fees.tx_fee_reserve;
  assert.strictEqual(totalFee, 0.015);
  assert.strictEqual(engine.minerPayoutShare, 0.985);
});

test('addShare adds to window', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  engine.networkDifficulty = 10000; // Big window so share doesn't get evicted
  engine.addShare('prl1pminer', 100, Date.now());
  assert(engine.shareWindow.length > 0, `Window has ${engine.shareWindow.length} shares`);
});

test('processBlock credits operator + distributes to miners', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  engine.networkDifficulty = 1000;

  // Add 20 shares from a single miner
  for (let i = 0; i < 20; i++) {
    engine.addShare('prl1pminer', 100, Date.now() - i * 1000);
  }

  const blockReward = 5000000000; // 50 PRL
  const result = engine.processBlock({
    hash: '0'.repeat(64),
    height: 100,
    reward: blockReward,
    finder: 'prl1pminer',
  });

  // New payout shape: { operatorCredit, distributed, grossReward, fees, minerCount, miners }
  assert(typeof result.operatorCredit === 'number');
  assert(typeof result.distributed === 'number');
  assert.strictEqual(
    result.operatorCredit + result.distributed,
    blockReward,
    'operator + distributed must equal block reward (no siphon)'
  );
  // Operator fee should be ~1.5% of block reward.  Allow ±(1 atomic unit per
  // share in the window) of rounding dust — `Math.floor` on each miner's
  // per-share payout leaves a few units that flow back to the operator,
  // which is correct behaviour, not a siphon.
  const expectedFee = Math.floor(blockReward * 0.015);
  const dustTolerance = 20 + 1; // 20 shares added in the test above
  assert(
    Math.abs(result.operatorCredit - expectedFee) <= dustTolerance,
    `operator credit ${result.operatorCredit} should be ~${expectedFee} (±${dustTolerance} dust)`
  );
});

test('operator + distributed = block reward exactly', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  engine.networkDifficulty = 1000;
  for (let i = 0; i < 20; i++) {
    engine.addShare('prl1pminer', 100, Date.now() - i * 1000);
  }
  const r = engine.processBlock({ hash: '0'.repeat(64), height: 1, reward: 1e8, finder: 'prl1pminer' });
  assert.strictEqual(r.operatorCredit + r.distributed, 1e8);
});

test('empty share window credits entire reward to operator', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  engine.networkDifficulty = 1000;
  const r = engine.processBlock({ hash: '0'.repeat(64), height: 2, reward: 5e8, finder: '' });
  assert.strictEqual(r.operatorCredit, 5e8, 'with no shares, operator gets everything');
  assert.strictEqual(r.distributed, 0);
});

test('custom baseFee overrides default', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.025 });
  assert.strictEqual(engine.fees.base_fee, 0.025);
  assert.strictEqual(engine.minerPayoutShare, 0.97);
});

// === Stratum ===
console.log('\nStratum:');
const stratum = require('./src/stratum');

test('StratumServer is a class', () => {
  assert(
    typeof stratum === 'function' || typeof stratum.StratumServer === 'function',
    'stratum module should export a class'
  );
});

// === Scanner ===
console.log('\nScanner:');
const scanner = require('./src/scanner');

test('ChainScanner is a class', () => {
  assert(
    typeof scanner === 'function' || typeof scanner === 'object',
    'scanner module should export a class'
  );
});

// === Bootstrap ===
console.log('\nBootstrap:');
const { bootstrapHistoricalData } = require('./lib/seed/realistic-bootstrap');

test('bootstrap module is loadable', () => {
  assert.strictEqual(typeof bootstrapHistoricalData, 'function');
});

test('bootstrap populates store with realistic data', () => {
  // Fresh store check
  const before = store.getStats();
  const blocksBefore = before.blocksFound;
  bootstrapHistoricalData(store, new PPLNSEngine({ poolWallet: 'prl1pop' }), 'prl1pop');
  const after = store.getStats();
  assert(after.blocksFound > blocksBefore, 'bootstrap should add historical blocks');
});

// === Persistence ===
console.log('\nPersistence:');
const path = require('path');
const fs = require('fs');
const os = require('os');
const snapshot = require('./lib/persistence/json-snapshot');

function tmpFile(name) {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pearlpool-test-')),
    name
  );
}

(async () => {
  // save() + load() round trip
  test('snapshot.save / snapshot.load round-trip', async () => {
    const fp = tmpFile('state.json');
    const data = { a: 1, b: 'hello', c: [1, 2, 3], d: { nested: true } };
    await snapshot.save(fp, data);
    const loaded = await snapshot.load(fp);
    assert.deepStrictEqual(loaded, data);
  });

  // load() returns null for a missing file (NOT throws)
  test('snapshot.load returns null for missing file', async () => {
    const fp = tmpFile('does-not-exist.json');
    const loaded = await snapshot.load(fp);
    assert.strictEqual(loaded, null);
  });

  // load() throws on a corrupt JSON file (so we don't silently lose data)
  test('snapshot.load throws on corrupt file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearlpool-test-'));
    const fp = path.join(dir, 'corrupt.json');
    fs.writeFileSync(fp, '{ this is not: valid json');
    let threw = false;
    try {
      await snapshot.load(fp);
    } catch (_) {
      threw = true;
    }
    assert(threw, 'corrupt JSON must throw on load');
  });

  // store.persist() + store.restoreFromFile() end-to-end
  test('store.persist + store.restoreFromFile round-trip', async () => {
    const fp = tmpFile('state.json');
    // Mutate the singleton store
    store.addWorker('prl1ptest2', 'wA', '127.0.0.1');
    store.updateMiner('prl1ptest2', { hashrate: 9999, shares: 42 });
    store.creditPending('prl1ptest2', 12345678);

    await store.persist(fp);
    assert(fs.existsSync(fp), 'snapshot file should exist on disk');

    // Wipe the in-memory store, then restore
    const snapshot = store.serialize();
    store.miners.clear();
    store.pendingPayouts.clear();

    const restored = await store.restoreFromFile(fp);
    assert(restored === true, 'restoreFromFile should return true on success');
    const m = store.getMiner('prl1ptest2');
    assert(m, 'miner should be back after restore');
    assert.strictEqual(m.hashrate, 9999);
    assert.strictEqual(store.getPendingBalance('prl1ptest2').balance, 12345678);
  });

  // restoreFromFile() returns false for a missing file (does not throw)
  test('store.restoreFromFile returns false for missing file', async () => {
    const fp = tmpFile('nope.json');
    const restored = await store.restoreFromFile(fp);
    assert.strictEqual(restored, false);
  });

  // Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();