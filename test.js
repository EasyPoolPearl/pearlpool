#!/usr/bin/env node
'use strict';

/**
 * Basic smoke tests for PearlPool modules.
 * Run: node test.js
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
  assert(m);
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

test('addShare adds to window', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  engine.networkDifficulty = 10000; // Large window so share doesn't get evicted
  engine.addShare('prl1pminer', 100, Date.now());
  assert(engine.shareWindow.length > 0, `Window has ${engine.shareWindow.length} shares`);
});

test('processBlock credits operator', () => {
  // Reset store pending
  store.creditPending('prl1poperator', -999999999);
  
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator', baseFee: 0.01 });
  engine.networkDifficulty = 1000;
  
  // Add shares
  for (let i = 0; i < 20; i++) {
    engine.addShare('prl1pminer', 100, Date.now() - i * 1000);
  }
  
  const result = engine.processBlock({
    hash: '0'.repeat(64),
    height: 100,
    reward: 5000000000, // 50 PRL
    finder: 'prl1pminer',
  });
  
  assert(result.operatorCredit > 0, 'Operator should get credit');
  assert(result.distributed >= 0, 'Distributed should be non-negative');
  assert(result.operatorCredit + result.distributed <= 5000000000, 'Total should not exceed reward');
});

test('fee structure sums to ~0.99', () => {
  const engine = new PPLNSEngine({ poolWallet: 'prl1poperator' });
  assert(engine.totalFee > 0.9, `Total fee ${engine.totalFee} should be > 0.9`);
  assert(engine.totalFee <= 1.0, `Total fee ${engine.totalFee} should be <= 1.0`);
});

// === Stratum ===
console.log('\nStratum:');
const stratum = require('./src/stratum');

test('StratumServer is a class', () => {
  assert(typeof stratum === 'function' || typeof stratum.StratumServer === 'function');
});

// === Scanner ===
console.log('\nScanner:');
const scanner = require('./src/scanner');

test('ChainScanner is a class', () => {
  assert(typeof scanner === 'function' || typeof scanner === 'object');
});

// === Summary ===
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
