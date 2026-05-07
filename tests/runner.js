// Minimal test framework — no external dependencies

'use strict';

const tests   = [];
let   passed  = 0;
let   failed  = 0;
let   current = '';

function describe(label, fn) {
  current = label;
  fn();
}

function test(name, fn) {
  tests.push({ suite: current, name, fn });
}

function runAll() {
  let lastSuite = '';
  for (const t of tests) {
    if (t.suite !== lastSuite) {
      console.log(`\n${t.suite}`);
      lastSuite = t.suite;
    }
    try {
      t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${passed} passed  ${failed} failed  ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

function expect(actual) {
  function fmt(v) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return JSON.stringify(v);
  }
  return {
    toBe(expected) {
      if (actual !== expected)
        throw new Error(`expected ${fmt(expected)}, got ${fmt(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual), b = JSON.stringify(expected);
      if (a !== b) throw new Error(`expected ${b}\n      got     ${a}`);
    },
    toBeLessThanOrEqual(n) {
      if (actual > n) throw new Error(`expected ≤ ${n}, got ${actual}`);
    },
    toBeGreaterThanOrEqual(n) {
      if (actual < n) throw new Error(`expected ≥ ${n}, got ${actual}`);
    },
    toBeGreaterThan(n) {
      if (actual <= n) throw new Error(`expected > ${n}, got ${actual}`);
    },
    toBeLessThan(n) {
      if (actual >= n) throw new Error(`expected < ${n}, got ${actual}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`expected truthy, got ${fmt(actual)}`);
    },
    toBeFalsy() {
      if (actual) throw new Error(`expected falsy, got ${fmt(actual)}`);
    },
    toBeNull() {
      if (actual !== null) throw new Error(`expected null, got ${fmt(actual)}`);
    },
    toContain(item) {
      if (!actual.includes(item))
        throw new Error(`expected array to contain ${fmt(item)}`);
    },
    toHaveLength(n) {
      if (!actual || actual.length !== n)
        throw new Error(`expected length ${n}, got ${actual ? actual.length : 'undefined'}`);
    },
    toBeWithin(lo, hi) {
      if (actual < lo || actual > hi)
        throw new Error(`expected ${actual} to be within [${lo}, ${hi}]`);
    },
    toBeOnOrAfter(d) {
      if (!(actual >= d))
        throw new Error(`expected ${fmt(actual)} to be on or after ${fmt(d)}`);
    },
    toBeOnOrBefore(d) {
      if (!(actual <= d))
        throw new Error(`expected ${fmt(actual)} to be on or before ${fmt(d)}`);
    },
  };
}

module.exports = { describe, test, runAll, expect };
