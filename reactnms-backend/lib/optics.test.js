import test from 'node:test';
import assert from 'node:assert/strict';
import { juniperOptics, pairOptics, sensorDbm } from './optics.js';

test('optical power is dBm and ignores other sensor types', () => {
  assert.equal(sensorDbm(14, 9, 2, 1234), 12.34);
  assert.equal(sensorDbm(14, 9, 2, -420), -4.2);
  assert.equal(sensorDbm(8, 9, 0, 30), null);
  const pairs = pairOptics(
    { 1: 'xe-0/0/0 Rx Power', 2: 'xe-0/0/0 Tx Power', 3: 'xe-0/0/0 Temperature' },
    {
      1: { 1: 14, 2: 9, 3: 2, 4: -420 },
      2: { 1: 14, 2: 9, 3: 2, 4: -210 },
      3: { 1: 8, 2: 9, 3: 0, 4: 40 },
    },
  );
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].rx, -4.2);
  assert.equal(pairs[0].tx, -2.1);
  assert.deepEqual(juniperOptics({ 5: { 5: -420, 7: -210 } }, { 5: 'ge-0/0/0' }), [
    { name: 'ge-0/0/0', rx: -4.2, tx: -2.1 },
  ]);
});
