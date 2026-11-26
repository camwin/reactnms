import test from 'node:test';
import assert from 'node:assert/strict';
import { bitsPerSecond, counterDelta } from './traffic-rate.js';

test('counter deltas count forward and wrap a 32-bit counter', () => {
  assert.equal(counterDelta(100, 250), 150);
  assert.equal(counterDelta(2 ** 32 - 10, 5), 15);
  assert.equal(counterDelta(100, 100), 0);
});

test('bits per second uses the gap between samples', () => {
  const rate = bitsPerSecond(
    { t: 0, in_octets: 1000, out_octets: 0 },
    { t: 10000, inOctets: 6000, outOctets: 2500 },
  );
  assert.equal(rate.inBps, 4000);
  assert.equal(rate.outBps, 2000);
  assert.deepEqual(bitsPerSecond(null, { t: 1 }), { inBps: null, outBps: null });
});
