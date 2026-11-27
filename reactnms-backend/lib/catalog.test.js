import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCatalog } from './catalog.js';

test('catalog searches serials and vlan ids and samples optics slowly', () => {
  const catalog = createCatalog(new Database(':memory:'));
  catalog.saveSerials('10.0.0.1', [
    { serial: 'ABC123', name: 'chassis', model: 'C9300' },
    { serial: 'ABC123', name: 'again', model: 'C9300' },
  ]);
  catalog.saveSerials('10.0.0.2', [{ serial: 'ZZZ', name: 'line', model: 'SFP' }]);
  assert.equal(catalog.searchSerial('abc123').length, 1);
  assert.equal(catalog.searchSerial('%').length, 2);
  catalog.saveVlans('10.0.0.1', [{ id: '20', name: 'users', source: 'vtp' }]);
  catalog.saveVlans('10.0.0.2', [{ id: '30', name: 'voice', source: 'qbridge' }]);
  assert.deepEqual(catalog.searchVlan('20').map((row) => row.ip), ['10.0.0.1']);
  assert.equal(catalog.counts().vlans, 2);
  catalog.recordOptics('10.0.0.1', [{ name: 'xe-0/0/0', rx: -4.2, tx: -2 }]);
  catalog.recordOptics('10.0.0.1', [{ name: 'xe-0/0/0', rx: -9, tx: -9 }]);
  assert.equal(catalog.opticHistory('10.0.0.1').length, 1);
  assert.equal(catalog.opticHistory('10.0.0.1')[0].rx, -4.2);
});
