import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createAlertStore } from './alerts.js';

function memoryStore(sent = []) {
  const db = new Database(':memory:');
  const store = createAlertStore(db, {
    deliver: async (transport, payload) => {
      sent.push({ type: transport.type, target: transport.target, text: payload.text, kind: payload.kind });
      return { delivered: true, detail: 'posted' };
    },
  });
  return { db, store, sent };
}

function downRule(extra = {}) {
  return {
    name: 'Device down',
    severity: 'critical',
    enabled: true,
    procedureUrl: 'https://example.test/runbook',
    notifyRecovery: true,
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.device_down', op: '=', value: '' }] },
    ...extra,
  };
}

test('evaluation opens, delays, acknowledges, and recovers', async () => {
  const sent = [];
  const { db, store } = memoryStore(sent);
  db.prepare('INSERT INTO devices (ip, hostname, location, icmp_up) VALUES (?, ?, ?, ?)').run('10.0.0.5', 'edge', 'Main', 0);
  const operation = store.saveOperation({
    name: 'Immediate',
    delaySec: 0,
    repeatSec: 300,
    steps: [{ afterSec: 0, transportIds: [] }],
  });
  const transport = store.saveTransport({ name: 'Hook', type: 'webhook', target: 'https://example.test/hook' });
  operation.steps[0].transportIds = [transport.id];
  store.saveOperation(operation);
  const rule = store.saveRule(downRule({ operationId: operation.id }));

  await store.evaluate(1_000);
  assert.equal(store.listActive().length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /edge/);

  sent.length = 0;
  await store.evaluate(2_000);
  assert.equal(sent.length, 0);

  const active = store.listActive()[0];
  assert.equal(active.procedureUrl, 'https://example.test/runbook');
  const acked = await store.acknowledge(active.id, 'clear', 3_000);
  assert.equal(acked.ackMode, 'clear');
  await store.evaluate(20_000);
  assert.equal(sent.length, 0);
  assert.equal(store.listActive()[0].ackMode, 'clear');

  db.prepare('UPDATE devices SET icmp_up = 1 WHERE ip = ?').run('10.0.0.5');
  await store.evaluate(30_000);
  assert.equal(store.listActive().length, 0);
  assert.equal(sent.at(-1).kind, 'recovery');
  assert.equal(rule.enabled, true);
});

test('mute logs the alert and does not call a transport', async () => {
  const sent = [];
  const { db, store } = memoryStore(sent);
  db.prepare('INSERT INTO devices (ip, hostname, icmp_up) VALUES (?, ?, ?)').run('10.0.0.6', 'muted', 0);
  const transport = store.saveTransport({ name: 'Hook', type: 'webhook', target: 'https://example.test/hook' });
  const operation = store.saveOperation({ name: 'Now', delaySec: 0, repeatSec: 0, steps: [{ afterSec: 0, transportIds: [transport.id] }] });
  store.saveRule(downRule({ mute: true, operationId: operation.id }));
  await store.evaluate(1_000);
  assert.equal(sent.length, 0);
  assert.equal(store.listActive().length, 1);
  assert.ok(store.listLog().some((line) => line.kind === 'mute'));
});

test('acknowledge until the metric worsens reopens a higher rate', async () => {
  const sent = [];
  const { db, store } = memoryStore(sent);
  db.prepare(`INSERT INTO devices (ip, hostname, icmp_up) VALUES ('10.0.0.7', 'core', 1)`).run();
  db.prepare(`INSERT INTO interfaces (ip, if_index, name, admin_status, oper_status, in_bps, out_bps, ignored) VALUES ('10.0.0.7', '1', 'Gi1', 1, 1, 150, 0, 0)`).run();
  const transport = store.saveTransport({ name: 'Slack', type: 'slack', target: 'https://example.test/slack' });
  const operation = store.saveOperation({ name: 'Now', delaySec: 0, repeatSec: 0, steps: [{ afterSec: 0, transportIds: [transport.id] }] });
  store.saveRule({
    name: 'High in',
    severity: 'warning',
    operationId: operation.id,
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'interfaces.in_bps', op: '>', value: '100' }] },
  });
  await store.evaluate(1_000);
  const active = store.listActive()[0];
  sent.length = 0;
  await store.acknowledge(active.id, 'worsens', 2_000);
  db.prepare('UPDATE interfaces SET in_bps = 120 WHERE ip = ?').run('10.0.0.7');
  await store.evaluate(3_000);
  assert.equal(store.listActive()[0].ackMode, 'worsens');
  assert.equal(sent.length, 0);
  db.prepare('UPDATE interfaces SET in_bps = 400 WHERE ip = ?').run('10.0.0.7');
  await store.evaluate(4_000);
  assert.equal(store.listActive()[0].ackMode, null);
  assert.equal(sent.at(-1).kind, 'alert');
});

test('a rule tester returns the SQL and the matching rows', () => {
  const { db, store } = memoryStore();
  db.prepare('INSERT INTO devices (ip, hostname, icmp_up) VALUES (?, ?, ?)').run('10.1.1.1', 'r1', 0);
  db.prepare('INSERT INTO devices (ip, hostname, icmp_up) VALUES (?, ?, ?)').run('10.1.1.2', 'r2', 1);
  const result = store.test(downRule(), '10.1.1.1');
  assert.equal(result.status, 200);
  assert.equal(result.body.match, true);
  assert.match(result.body.sql, /devices\.icmp_up = 0/);
  assert.equal(result.body.rows.length, 1);
  const blocked = store.test({ advanced: true, sql: 'DELETE FROM devices' }, '10.1.1.1');
  assert.equal(blocked.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM devices').get().c, 2);
});

test('an interface alert title includes a non-empty alias', async () => {
  const { db, store } = memoryStore();
  db.prepare('INSERT INTO devices (ip, hostname, icmp_up) VALUES (?, ?, ?)').run('10.0.0.7', 'edge', 1);
  db.prepare(`INSERT INTO interfaces (ip, if_index, name, alias, admin_status, oper_status, in_bps, out_bps, speed, ignored)
    VALUES ('10.0.0.7', '4', 'Gi1/0/4', 'Uplink to core', 1, 2, 0, 0, 1000, 0)`).run();
  store.saveRule({
    name: 'Port down',
    severity: 'warning',
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.port_down', op: '=', value: '' }] },
  });
  await store.evaluate(1_000);
  const alert = store.listActive()[0];
  assert.equal(alert.ifAlias, 'Uplink to core');
  assert.match(alert.message, /Port down: edge Gi1\/0\/4 — Uplink to core/);
  assert.equal(store.listLog(20, 'Uplink').length, 1);
  assert.equal(store.listLog(20, 'missing-host').length, 0);
});

test('alert history for one address does not include a longer address', () => {
  const { db, store } = memoryStore();
  const insert = db.prepare('INSERT INTO alert_log (at, rule_id, device_ip, kind, detail) VALUES (?, ?, ?, ?, ?)');
  insert.run(1, 'rule-a', '10.0.0.1', 'alert', 'edge down');
  insert.run(2, 'rule-b', '10.0.0.10', 'alert', 'other down');
  const exact = store.listLog(20, '', '10.0.0.1');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].deviceIp, '10.0.0.1');
  assert.equal(store.listLog(20, 'other', '10.0.0.10').length, 1);
  assert.equal(store.listLog(20, 'edge', '10.0.0.10').length, 0);
});
