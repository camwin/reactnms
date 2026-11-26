import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createEventStore, diffIdentity, diffInterfaces, diffNeighbors, diffReachability, diffStp } from './device-events.js';

test('the first interface snapshot is a baseline', () => {
  assert.deepEqual(diffInterfaces([], [{ index: '1', name: 'Gi1', operStatus: 2, adminStatus: 1 }]), []);
});

test('interface transitions include the alias and both oper and admin changes', () => {
  const events = diffInterfaces(
    [{ if_index: '1', name: 'Gi1/0/1', alias: 'uplink', oper_status: 1, admin_status: 1 }],
    [{ index: '1', name: 'Gi1/0/1', alias: 'uplink', operStatus: 2, adminStatus: 2 }],
  );
  assert.equal(events.length, 2);
  assert.match(events[0].summary, /Gi1\/0\/1 — uplink operational up → down/);
  assert.match(events[1].summary, /admin up → down/);
  assert.equal(events[0].kind, 'interface');
});

test('reachability waits for a previous ICMP sample and ignores unknown results', () => {
  assert.deepEqual(diffReachability({ icmp_up: null, icmp_at: null }, { icmp_up: 0 }), []);
  assert.deepEqual(diffReachability({ icmp_up: 1, icmp_at: 10 }, { icmp_up: null }), []);
  assert.deepEqual(diffReachability({ icmp_up: 1, icmp_at: 10 }, { icmp_up: 1 }), []);
  assert.equal(diffReachability({ icmp_up: 1, icmp_at: 10 }, { icmp_up: 0 })[0].summary, 'ICMP down');
});

test('identity changes record hostname and location', () => {
  const events = diffIdentity(
    { sysName: 'edge', sysLocation: 'Main' },
    { sysName: 'edge-2', sysLocation: '' },
  );
  assert.deepEqual(events.map((event) => event.summary), ['Hostname edge → edge-2', 'Location Main → blank']);
});

test('spanning-tree ignores the first sight of a port', () => {
  assert.deepEqual(diffStp([], [{ bridgePort: '5', state: 5, name: 'Gi1/0/5' }]), []);
  const events = diffStp(
    [{ bridge_port: '5', state: 2, name: 'Gi1/0/5' }],
    [{ bridgePort: '5', state: 5, name: 'Gi1/0/5' }, { bridgePort: '6', state: 5, name: 'Gi1/0/6' }],
  );
  assert.equal(events.length, 1);
  assert.match(events[0].summary, /Gi1\/0\/5 spanning-tree blocking → forwarding/);
});

test('neighbor changes wait for a previous set', () => {
  const first = [{ protocol: 'cdp', localIf: '1', remoteName: 'core', remotePort: 'Gi0/1' }];
  assert.deepEqual(diffNeighbors([], first), []);
  const events = diffNeighbors(first, [{ protocol: 'cdp', localIf: '1', remoteName: 'core', remotePort: 'Gi0/2' }]);
  assert.equal(events.length, 2);
  assert.match(events.map((event) => event.summary).join('\n'), /Gi0\/2/);
  assert.match(events.map((event) => event.summary).join('\n'), /disappeared/);
});

test('stored neighbors and search skip the baseline and then list the change', () => {
  const db = new Database(':memory:');
  const store = createEventStore(db);
  store.noteNeighbors('10.0.0.1', [{ protocol: 'cdp', localIf: '1', remoteName: 'edge', remotePort: 'Gi0/1' }], 'core');
  assert.equal(store.list({}).length, 0);
  store.noteNeighbors('10.0.0.1', [{ protocol: 'lldp', localIf: '2', remoteName: 'access', remotePort: 'Te1/1' }], 'core');
  const rows = store.list({ q: 'access' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deviceIp, '10.0.0.1');
  assert.equal(rows[0].kind, 'neighbor');
  assert.equal(store.list({ device: '10.9.9.9' }).length, 0);
  assert.equal(store.list({ q: 'edge' }).some((row) => row.summary.includes('disappeared')), true);
  store.forgetDevice('10.0.0.1');
  assert.equal(store.list({}).length, 0);
});
