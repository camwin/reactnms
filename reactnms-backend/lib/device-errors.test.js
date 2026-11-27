import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvents, interfaceErrorRows } from './device-errors.js';

test('errors keep only non-zero counters and the down transitions', () => {
  const rows = interfaceErrorRows({
    1: { 2: 'Gi1', 13: 0, 14: 3, 19: 1, 20: 0 },
    2: { 2: 'Gi2', 13: 0, 14: 0, 19: 0, 20: 0 },
  });
  assert.deepEqual(rows.map((row) => row.name), ['Gi1']);
  const grouped = classifyEvents([
    { kind: 'reachability', summary: 'ICMP down' },
    { kind: 'reachability', summary: 'ICMP up' },
    { kind: 'interface', summary: 'Gi1 operational up → down' },
    { kind: 'interface', summary: 'Gi1 operational down → up' },
    { kind: 'spanning-tree', summary: 'Gi1 spanning-tree forwarding → blocking' },
    { kind: 'spanning-tree', summary: 'Gi1 spanning-tree blocking → forwarding' },
    { kind: 'neighbor', summary: 'Gi1 neighbor added' },
  ]);
  assert.equal(grouped.reachability.length, 1);
  assert.equal(grouped.link.length, 1);
  assert.equal(grouped.switching.length, 1);
});
