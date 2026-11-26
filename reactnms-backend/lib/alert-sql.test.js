import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from './alert-sql.js';
import { migrateLegacyRule as migrate } from './alerts.js';

test('a nested builder compiles to parameterized SQL', () => {
  const compiled = compileRule({
    invert: true,
    builder: {
      join: 'AND',
      items: [
        { kind: 'cond', entity: 'macros.device_down', op: '=', value: '' },
        {
          kind: 'group',
          join: 'OR',
          items: [
            { kind: 'cond', entity: 'devices.hostname', op: 'LIKE', value: 'core%' },
            { kind: 'cond', entity: 'devices.location', op: '=', value: 'HQ' },
          ],
        },
      ],
    },
    scope: { devices: ['10.0.0.1'], locations: ['HQ'], exclude: true, groupMembers: ['10.0.0.2'] },
  });
  assert.equal(compiled.error, undefined);
  assert.match(compiled.sql, /NOT \(devices\.icmp_up = 0 AND \(devices\.hostname LIKE \? OR devices\.location = \?\)\)/);
  assert.match(compiled.sql, /NOT \(devices\.ip IN \(\?, \?\) OR devices\.location IN \(\?\)\)/);
  assert.equal(compiled.sql.includes('JOIN interfaces'), false);
  assert.deepEqual(compiled.params, ['core%', 'HQ', '10.0.0.1', '10.0.0.2', 'HQ']);
});

test('interface rules join interfaces and keep backtick references', () => {
  const compiled = compileRule({
    builder: {
      join: 'AND',
      items: [
        { kind: 'cond', entity: 'interfaces.in_bps', op: '>', value: '100000000' },
        { kind: 'cond', entity: 'interfaces.name', op: 'REGEXP', value: '^Gi' },
        { kind: 'cond', entity: 'interfaces.alias', op: 'IN', value: 'uplink, `interfaces.name`' },
      ],
    },
  });
  assert.match(compiled.sql, /INNER JOIN interfaces ON interfaces\.ip = devices\.ip/);
  assert.match(compiled.sql, /interfaces\.alias AS if_alias/);
  assert.match(compiled.sql, /interfaces\.in_bps > \?/);
  assert.match(compiled.sql, /regexp\(\?, interfaces\.name\)/);
  assert.match(compiled.sql, /interfaces\.alias IN \(\?, interfaces\.name\)/);
  assert.deepEqual(compiled.params, [100000000, '^Gi', 'uplink']);
  assert.equal(compiled.worse, 'higher');
});

test('an empty builder does not match every device', () => {
  const compiled = compileRule({ builder: { join: 'AND', items: [] } });
  assert.match(compiled.error, /no conditions/);
});

test('raw SQL must be one read-only statement', () => {
  assert.match(compileRule({ advanced: true, sql: 'DELETE FROM devices' }).error, /SELECT or WITH|read-only/);
  assert.match(compileRule({ advanced: true, sql: 'SELECT ip AS device_ip FROM devices; DROP TABLE devices' }).error, /one SQL/);
  const ok = compileRule({ advanced: true, sql: 'SELECT ip AS device_ip FROM devices' }, { device: '10.0.0.8' });
  assert.equal(ok.error, undefined);
  assert.match(ok.sql, /alert_rows/);
  assert.deepEqual(ok.params, ['10.0.0.8']);
});

test('a per-device test adds the host filter without dropping scope', () => {
  const compiled = compileRule({
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.port_down', op: '=', value: '' }] },
    scope: { devices: ['10.0.0.1'], groupMembers: [] },
  }, { device: '10.0.0.1' });
  assert.match(compiled.sql, /devices\.ip = \?/);
  assert.deepEqual(compiled.params, ['10.0.0.1', '10.0.0.1']);
});

test('legacy traffic rules become a bits-per-second comparison', () => {
  const rule = migrate({
    id: 'old',
    name: 'Core in',
    device: '10.1.1.1',
    type: 'traffic',
    interface: '5',
    metric: 'in',
    op: 'gt',
    threshold: 100,
    unit: 'Mbps',
    enabled: true,
  });
  assert.equal(rule.severity, 'warning');
  assert.deepEqual(rule.scope.devices, ['10.1.1.1']);
  assert.equal(rule.builder.items[0].value, '100000000');
  assert.equal(rule.builder.items[1].entity, 'interfaces.if_index');
  const icmp = migrate({ id: 'down', name: 'Down', device: '10.9.9.9', type: 'icmp-down', enabled: false });
  assert.equal(icmp.enabled, false);
  assert.equal(icmp.builder.items[0].entity, 'macros.device_down');
});
