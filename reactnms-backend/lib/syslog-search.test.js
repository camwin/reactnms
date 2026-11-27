import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSyslogStore } from './syslog.js';

test('syslog search filters text and severity', () => {
  const store = createSyslogStore(new Database(':memory:'));
  store.insert({ sourceIp: '10.0.0.1', facility: 16, severity: 3, host: 'core', message: 'link down' }, {});
  store.insert({ sourceIp: '10.0.0.2', facility: 16, severity: 6, host: 'edge', message: 'clock updated' }, {});
  assert.equal(store.list({ severity: 'error' }).length, 1);
  assert.equal(store.list({ severity: 'error' })[0].message, 'link down');
  assert.equal(store.list({ q: 'edge' })[0].host, 'edge');
  assert.equal(store.list({ q: '%edge%' }).length, 1);
});
