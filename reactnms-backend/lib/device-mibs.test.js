import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENTITY_TABLE,
  ROUTE_COLUMNS,
  VTP_VLAN_TABLE,
  isRouter,
  parseCidrRoutes,
  parseInetRoutes,
  parseInventory,
  parseJuniperLegacyVlans,
  parseJuniperVlans,
  parseQbridgeVlans,
  parseRoutes,
  parseVtpVlans,
} from './device-mibs.js';

test('a router is ipForwarding or the sysServices network bit', () => {
  assert.equal(isRouter(1, 0), true);
  assert.equal(isRouter(2, 4), true);
  assert.equal(isRouter(2, 72), false);
  assert.equal(isRouter(null, null), false);
});

test('route, VLAN, and inventory tables keep the useful columns', () => {
  const routes = parseRoutes({
    '10.1.0.0': { 1: Buffer.from([10, 1, 0, 0]), 2: 4, 7: Buffer.from([10, 0, 0, 1]), 8: 4, 9: 13, 11: Buffer.from([255, 255, 255, 0]) },
  });
  assert.equal(routes[0].dest, '10.1.0.0');
  assert.equal(routes[0].nextHop, '10.0.0.1');
  assert.equal(routes[0].proto, 'ospf');
  assert.equal(routes[0].mask, '255.255.255.0');
  const qbridge = parseQbridgeVlans({ 20: { 1: 'users' } });
  assert.deepEqual(qbridge[0], { id: '20', name: 'users', source: 'qbridge' });
  const vtp = parseVtpVlans({ '1.30': { 3: 1, 4: 'voice' } });
  assert.equal(vtp[0].id, '30');
  assert.equal(vtp[0].name, 'voice');
  const inventory = parseInventory({
    1: { 2: 'chassis', 5: 3, 7: 'Chassis', 11: 'ABC123', 12: 'Cisco', 13: 'C9300' },
    2: { 2: 'port', 5: 10, 7: 'Gi1/0/1', 11: '', 12: '', 13: '' },
  });
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].serial, 'ABC123');
  assert.equal(VTP_VLAN_TABLE, '1.3.6.1.4.1.9.9.46.1.3.1');
  assert.equal(ENTITY_TABLE, '1.3.6.1.2.1.47.1.1.1');
  assert.equal(ROUTE_COLUMNS.includes(1), false);
});

test('cidr and inet route indexes carry destination, mask, and next hop', () => {
  const cidr = parseCidrRoutes({
    '10.1.0.0.255.255.255.0.0.10.0.0.1': { 5: 4, 7: 14 },
  });
  assert.equal(cidr[0].dest, '10.1.0.0');
  assert.equal(cidr[0].mask, '255.255.255.0');
  assert.equal(cidr[0].nextHop, '10.0.0.1');
  assert.equal(cidr[0].ifIndex, '4');
  assert.equal(cidr[0].proto, 'bgp');
  const inet = parseInetRoutes({
    '1.4.10.1.0.0.24.2.0.0.1.4.192.0.2.1': { 7: 8, 9: 13 },
  });
  assert.equal(inet[0].dest, '10.1.0.0');
  assert.equal(inet[0].mask, '255.255.255.0');
  assert.equal(inet[0].nextHop, '192.0.2.1');
  assert.equal(inet[0].ifIndex, '8');
  assert.equal(inet[0].proto, 'ospf');
  assert.equal(parseInetRoutes({ '1.4.10.1.0.0': {} }).length, 0);
});

test('juniper vlan tag is the vlan id', () => {
  const rows = parseJuniperVlans({ 7: { 2: 'users', 5: 20 } });
  assert.deepEqual(rows[0], { id: '20', name: 'users', source: 'juniper' });
  const legacy = parseJuniperLegacyVlans({ 3: { 1: 'voice', 2: 30 } });
  assert.equal(legacy[0].id, '30');
  assert.equal(legacy[0].name, 'voice');
});
