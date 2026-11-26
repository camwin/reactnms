import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceBook, DEFAULT_INTERFACE_IGNORE, deviceKey, interfaceIgnored, pruneIgnoredInterfaces, syncInterfaceSelection, visibleDuringScan } from './discovery-sync.js';

test('deviceKey uses the hostname and falls back to the address', () => {
  assert.equal(deviceKey({ ip: '10.0.0.1', sysName: 'Core-RTR' }), 'name:core-rtr');
  assert.equal(deviceKey({ ip: '10.0.0.1', sysName: '10.0.0.1' }), 'ip:10.0.0.1');
  assert.equal(deviceKey({ ip: '10.0.0.1', sysName: '  ' }), 'ip:10.0.0.1');
});

test('the first gateway wins when the device was not tracked before', () => {
  const book = createDeviceBook([]);
  const first = book.add({ ip: '10.1.1.1', sysName: 'edge' });
  const second = book.add({ ip: '10.2.2.1', sysName: 'Edge' });
  assert.equal(first.type, 'added');
  assert.equal(second.type, 'duplicate');
  assert.equal(second.of, '10.1.1.1');
  assert.deepEqual(book.devices()[0].addresses, ['10.1.1.1', '10.2.2.1']);
  assert.equal(book.devices().length, 1);
});

test('a later scan keeps the address that was already tracked', () => {
  const book = createDeviceBook([{ ip: '10.1.1.1', sysName: 'edge' }]);
  const early = book.add({ ip: '10.2.2.1', sysName: 'edge', subnet: '10.2.2.0/24' });
  assert.equal(early.type, 'deferred');
  assert.equal(early.preferred, '10.1.1.1');
  assert.equal(book.devices().length, 0);
  const kept = book.add({ ip: '10.1.1.1', sysName: 'edge', subnet: '10.1.1.0/24' });
  assert.equal(kept.type, 'added');
  assert.equal(kept.device.ip, '10.1.1.1');
  assert.deepEqual(kept.device.addresses, ['10.1.1.1', '10.2.2.1']);
  assert.deepEqual(book.finish(), []);
});

test('a missing tracked address is replaced by another gateway of the same device', () => {
  const book = createDeviceBook([{ ip: '10.1.1.1', sysName: 'edge' }]);
  book.add({ ip: '10.2.2.1', sysName: 'edge' });
  book.add({ ip: '10.3.3.1', sysName: 'edge' });
  const events = book.finish();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'promoted');
  assert.equal(events[0].fromIp, '10.1.1.1');
  assert.equal(events[0].device.ip, '10.2.2.1');
  assert.deepEqual(events[0].device.addresses, ['10.2.2.1', '10.3.3.1']);
});

test('different hostnames and address-only replies stay separate', () => {
  const book = createDeviceBook([]);
  book.add({ ip: '10.0.0.1', sysName: 'a' });
  book.add({ ip: '10.0.0.2', sysName: 'b' });
  book.add({ ip: '10.0.0.3', sysName: '' });
  book.add({ ip: '10.0.0.4', sysName: '10.0.0.4' });
  assert.equal(book.devices().length, 4);
});

test('an in-progress scan keeps devices that have not been visited yet', () => {
  const previous = [
    { ip: '10.1.1.1', sysName: 'edge' },
    { ip: '10.9.9.9', sysName: 'core' },
  ];
  const found = [{ ip: '10.1.1.1', sysName: 'edge', addresses: ['10.1.1.1'] }];
  const visible = visibleDuringScan(found, previous);
  assert.deepEqual(visible.map((device) => device.ip), ['10.1.1.1', '10.9.9.9']);
});

test('an in-progress scan hides a second gateway once the device is already listed', () => {
  const previous = [
    { ip: '10.1.1.1', sysName: 'edge' },
    { ip: '10.2.2.1', sysName: 'edge' },
  ];
  const found = [{ ip: '10.1.1.1', sysName: 'edge', addresses: ['10.1.1.1', '10.2.2.1'] }];
  const visible = visibleDuringScan(found, previous);
  assert.deepEqual(visible.map((device) => device.ip), ['10.1.1.1']);
});

test('sync adds oper-up interfaces and drops administratively down ones', () => {
  const result = syncInterfaceSelection(['1', '4', '9'], [
    { index: 1, adminStatus: 1, operStatus: 1 },
    { index: 2, adminStatus: 1, operStatus: 1 },
    { index: 3, adminStatus: 1, operStatus: 2 },
    { index: 4, adminStatus: 2, operStatus: 2 },
    { index: 5, adminStatus: 2, operStatus: 1 },
  ]);
  assert.deepEqual(result.indexes, ['1', '2']);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 2);
  assert.equal(result.changed, true);
});

test('an oper-down interface that is still enabled stays tracked', () => {
  const result = syncInterfaceSelection(['3'], [
    { index: '3', adminStatus: 1, operStatus: 2 },
    { index: '8', adminStatus: 1, operStatus: 1 },
  ]);
  assert.deepEqual(result.indexes, ['3', '8']);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
});

test('ignored names are not selected and are removed when they were tracked', () => {
  const patterns = ['^loopback', '^vlan', '^null'];
  const result = syncInterfaceSelection(['1', '2'], [
    { index: '1', name: 'Loopback0', adminStatus: 1, operStatus: 1 },
    { index: '2', name: 'GigabitEthernet1/0/1', adminStatus: 1, operStatus: 1 },
    { index: '3', name: 'Vlan10', adminStatus: 1, operStatus: 1 },
    { index: '4', name: 'GigabitEthernet1/0/2', adminStatus: 1, operStatus: 1 },
  ], patterns);
  assert.deepEqual(result.indexes, ['2', '4']);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 1);
});

test('default ignore patterns cover virtual interfaces and leave physical ports', () => {
  const ignored = ['Null0', 'Loopback0', 'Lo0', 'Vlan100', 'unrouted VLAN 4', 'AppGigabitEthernet1/0/1', 'Tunnel1', 'Tu0', 'StackPort1', 'Bluetooth0'];
  const kept = ['GigabitEthernet1/0/1', 'Port-channel1', 'TenGigabitEthernet1/1/1', 'Management0'];
  for (const name of ignored) assert.equal(interfaceIgnored(name, DEFAULT_INTERFACE_IGNORE), true, name);
  for (const name of kept) assert.equal(interfaceIgnored(name, DEFAULT_INTERFACE_IGNORE), false, name);
  assert.equal(interfaceIgnored('GigabitEthernet1/0/1', ['[']), false);
  assert.equal(interfaceIgnored('foo[bar', ['[']), true);
});

test('inline flags such as (?i) compile and can turn case sensitivity back on', () => {
  const numbered = ['(?i)^unrouted\\d+$'];
  assert.equal(interfaceIgnored('Unrouted12', numbered), true);
  assert.equal(interfaceIgnored('unrouted VLAN', numbered), false);
  assert.equal(interfaceIgnored('Port-channel1', numbered), false);
  assert.equal(interfaceIgnored('Management0', numbered), false);
  assert.equal(interfaceIgnored('Lo0', ['(?-i)^Lo0']), true);
  assert.equal(interfaceIgnored('lo0', ['(?-i)^Lo0']), false);
  assert.equal(interfaceIgnored('Unrouted3', ['(?i:^unrouted\\d+$)']), true);
  assert.equal(interfaceIgnored('NULL0', ['^null']), true);
});

test('saving ignore patterns drops stored interfaces that match', () => {
  const drop = pruneIgnoredInterfaces([
    { ip: '10.0.0.1', index: '1', name: 'Loopback0' },
    { ip: '10.0.0.1', index: '2', name: 'GigabitEthernet1/0/1' },
    { ip: '10.0.0.1', index: '3', name: 'Unrouted12' },
    { ip: '10.0.0.2', index: '4', name: 'Port-channel1' },
  ], ['^loopback', '(?i)^unrouted\\d+$']);
  assert.deepEqual(drop.map((row) => row.index), ['1', '3']);
});

test('a complete walk drops selections for indexes that no longer exist', () => {
  const result = syncInterfaceSelection(['1', '7'], [{ index: '1', adminStatus: 1, operStatus: 2 }]);
  assert.deepEqual(result.indexes, ['1']);
  assert.equal(result.removed, 1);
});
