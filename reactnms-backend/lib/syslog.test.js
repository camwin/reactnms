import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSyslogStore, normalizeSyslogConfig, parseSyslog } from './syslog.js';

test('syslog messages parse BSD and RFC5424 priorities', () => {
  const bsd = parseSyslog("<34>Oct 11 22:14:15 mymachine su: 'su root' failed");
  assert.equal(bsd.facility, 4);
  assert.equal(bsd.severityName, 'crit');
  assert.equal(bsd.host, 'mymachine');
  assert.match(bsd.message, /su root/);
  const rfc = parseSyslog('<34>1 2003-10-11T22:14:15.003Z mymachine su - ID47 - boom');
  assert.equal(rfc.host, 'mymachine');
  assert.equal(rfc.message, 'boom');
  assert.equal(parseSyslog('   '), null);
  const cfg = normalizeSyslogConfig({ enabled: true, port: 0, retainDays: 3, maxRows: 50 });
  assert.equal(cfg.port, 5514);
  assert.equal(cfg.retainDays, 3);
  assert.equal(cfg.maxRows, 100000);
});

test('syslog retention drops old rows and rows past the cap', () => {
  const db = new Database(':memory:');
  const store = createSyslogStore(db);
  const config = { enabled: true, port: 5514, retainDays: 1, maxRows: 100 };
  store.insert({ at: Date.now() - 3 * 86400000, sourceIp: '10.0.0.1', facility: 16, severity: 6, host: 'edge', message: 'old' }, config);
  store.insert({ at: Date.now(), sourceIp: '10.0.0.1', facility: 16, severity: 6, host: 'edge', message: 'one' }, config);
  store.insert({ at: Date.now(), sourceIp: '10.1.1.1', facility: 16, severity: 3, host: 'core.example.net', message: 'two' }, config);
  assert.equal(store.forDevice({ ips: ['10.0.0.1'] }).some((row) => row.message === 'old'), false);
  const filtered = store.forDevice({ ips: ['10.0.0.9'], hostname: 'core.example.net', q: 'two' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].severityName, 'err');
  for (let i = 0; i < 99; i += 1) {
    store.insert({ at: Date.now(), sourceIp: '10.2.2.2', facility: 16, severity: 5, host: 'other', message: `extra ${i}` }, config);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM syslog').get().n, 100);
});
