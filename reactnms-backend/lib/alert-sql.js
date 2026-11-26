export const ENTITIES = [
  { id: 'devices.hostname', label: 'Device hostname', column: 'devices.hostname' },
  { id: 'devices.ip', label: 'Device IP', column: 'devices.ip' },
  { id: 'devices.location', label: 'Device location', column: 'devices.location' },
  { id: 'devices.sys_descr', label: 'Device software', column: 'devices.sys_descr' },
  { id: 'devices.icmp_up', label: 'ICMP up (1 or 0)', column: 'devices.icmp_up', numeric: true },
  { id: 'interfaces.if_index', label: 'Interface index', column: 'interfaces.if_index' },
  { id: 'interfaces.name', label: 'Interface name', column: 'interfaces.name' },
  { id: 'interfaces.alias', label: 'Interface alias', column: 'interfaces.alias' },
  { id: 'interfaces.oper_status', label: 'Oper status (1 up)', column: 'interfaces.oper_status', numeric: true },
  { id: 'interfaces.admin_status', label: 'Admin status (1 up, 2 down)', column: 'interfaces.admin_status', numeric: true },
  { id: 'interfaces.in_bps', label: 'Inbound bits/s', column: 'interfaces.in_bps', numeric: true },
  { id: 'interfaces.out_bps', label: 'Outbound bits/s', column: 'interfaces.out_bps', numeric: true },
  { id: 'interfaces.speed', label: 'Interface speed', column: 'interfaces.speed', numeric: true },
  { id: 'interfaces.ignored', label: 'Ignored interface (1 or 0)', column: 'interfaces.ignored', numeric: true },
  { id: 'macros.device_down', label: 'Macro: device down (ICMP)', macro: 'devices.icmp_up = 0', metric: 'devices.icmp_up' },
  {
    id: 'macros.port_down',
    label: 'Macro: port down',
    macro: '(interfaces.oper_status != 1 AND interfaces.admin_status = 1 AND interfaces.ignored = 0)',
    metric: 'interfaces.oper_status',
  },
];

export const OPERATORS = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'REGEXP', 'IN'];

const BY_ID = new Map(ENTITIES.map((entity) => [entity.id, entity]));

export const TEMPLATES = [
  {
    id: 'device-down',
    name: 'Device down (ICMP)',
    severity: 'critical',
    notes: 'The device did not answer ICMP.',
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.device_down', op: '=', value: '' }] },
  },
  {
    id: 'port-down',
    name: 'Interface down',
    severity: 'warning',
    notes: 'An enabled interface is operationally down. Only interfaces selected for polling are checked.',
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.port_down', op: '=', value: '' }] },
  },
  {
    id: 'high-in',
    name: 'High inbound traffic',
    severity: 'warning',
    notes: 'Inbound rate is above 100 Mbps. The value is bits per second.',
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'interfaces.in_bps', op: '>', value: '100000000' }] },
  },
  {
    id: 'high-out',
    name: 'High outbound traffic',
    severity: 'warning',
    notes: 'Outbound rate is above 100 Mbps. The value is bits per second.',
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'interfaces.out_bps', op: '>', value: '100000000' }] },
  },
];

const FORBIDDEN = /\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|reindex|create|load_extension|replace\s+into)\b/i;

export function assertReadOnly(sql) {
  const text = String(sql || '').trim().replace(/;+\s*$/g, '');
  if (!text) throw new Error('SQL is empty');
  if (text.includes(';')) throw new Error('Only one SQL statement is allowed');
  if (!/^(select|with)\b/i.test(text)) throw new Error('SQL must start with SELECT or WITH');
  if (FORBIDDEN.test(text)) throw new Error('Only read-only SELECT queries are allowed');
  return text;
}

function bindScalar(raw, params) {
  const text = String(raw ?? '').trim();
  const ref = text.match(/^`([a-z0-9_.]+)`$/i);
  if (ref) {
    const entity = BY_ID.get(ref[1]);
    if (!entity?.column) throw new Error(`Unknown column reference ${text}`);
    return entity.column;
  }
  if (!text) throw new Error('Condition value is empty');
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    params.push(Number(text));
    return '?';
  }
  params.push(text);
  return '?';
}

function compileCond(cond, params) {
  const entity = BY_ID.get(cond.entity);
  if (!entity) throw new Error(`Unknown entity ${cond.entity || ''}`.trim());
  if (entity.macro) return entity.macro;
  const op = String(cond.op || '=').toUpperCase();
  if (!OPERATORS.includes(op)) throw new Error(`Unknown operator ${op}`);
  if (op === 'REGEXP') return `regexp(${bindScalar(cond.value, params)}, ${entity.column})`;
  if (op === 'IN') {
    const list = String(cond.value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    if (!list.length) throw new Error('IN needs at least one value');
    return `${entity.column} IN (${list.map((part) => bindScalar(part, params)).join(', ')})`;
  }
  return `${entity.column} ${op} ${bindScalar(cond.value, params)}`;
}

function compileGroup(group, params) {
  const join = group?.join === 'OR' ? 'OR' : 'AND';
  const parts = [];
  for (const item of group?.items || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'group') {
      const inner = compileGroup(item, params);
      if (inner) parts.push(`(${inner})`);
    } else if (item.entity) {
      parts.push(compileCond(item, params));
    }
  }
  return parts.join(` ${join} `);
}

function walkConds(group, visit) {
  for (const item of group?.items || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'group') walkConds(item, visit);
    else visit(item);
  }
}

function metricSql(builder) {
  let metric = 'NULL';
  walkConds(builder, (cond) => {
    if (metric !== 'NULL') return;
    const entity = BY_ID.get(cond.entity);
    if (!entity) return;
    if (entity.metric) metric = entity.metric;
    else if (entity.numeric) metric = entity.column;
  });
  return metric;
}

function worseDirection(builder) {
  let higher = false;
  let lower = false;
  walkConds(builder, (cond) => {
    const entity = BY_ID.get(cond.entity);
    if (!entity || entity.macro) return;
    const op = String(cond.op || '').toUpperCase();
    if (op === '>' || op === '>=') higher = true;
    if (op === '<' || op === '<=') lower = true;
  });
  if (higher) return 'higher';
  if (lower) return 'lower';
  return 'none';
}

function scopeSql(scope, params) {
  const devices = [...(scope?.devices || []), ...(scope?.groupMembers || [])].map((item) => String(item)).filter(Boolean);
  const locations = (scope?.locations || []).map((item) => String(item)).filter(Boolean);
  if (!devices.length && !locations.length) return '';
  const parts = [];
  if (devices.length) {
    parts.push(`devices.ip IN (${devices.map(() => '?').join(', ')})`);
    params.push(...devices);
  }
  if (locations.length) {
    parts.push(`devices.location IN (${locations.map(() => '?').join(', ')})`);
    params.push(...locations);
  }
  const union = parts.join(' OR ');
  return scope?.exclude ? `NOT (${union})` : `(${union})`;
}

export function compileRule(rule, options = {}) {
  try {
    if (rule?.advanced) {
      const inner = assertReadOnly(rule.sql);
      const params = [];
      const scope = scopeSql(rule.scope, params);
      const filters = [];
      if (scope) filters.push(scope);
      if (options.device) {
        filters.push('devices.ip = ?');
        params.push(String(options.device));
      }
      if (rule.invert) {
        return {
          sql: [
            'SELECT devices.ip AS device_ip, devices.hostname AS hostname, NULL AS if_index, NULL AS if_name, NULL AS if_alias, NULL AS metric_value',
            'FROM devices',
            `WHERE NOT EXISTS (SELECT 1 FROM (\n${inner}\n) AS alert_rows WHERE alert_rows.device_ip = devices.ip)`,
            ...filters.map((filter) => `  AND ${filter}`),
          ].join('\n'),
          params,
          worse: 'none',
        };
      }
      if (!filters.length) return { sql: inner, params, worse: 'none' };
      return {
        sql: `SELECT alert_rows.* FROM (\n${inner}\n) AS alert_rows\nJOIN devices ON devices.ip = alert_rows.device_ip\nWHERE ${filters.join('\n  AND ')}`,
        params,
        worse: 'none',
      };
    }
    const params = [];
    let condition = compileGroup(rule?.builder, params);
    if (!condition) throw new Error('Rule has no conditions');
    if (rule?.invert) condition = `NOT (${condition})`;
    const scope = scopeSql(rule?.scope, params);
    const where = [condition];
    if (scope) where.push(scope);
    if (options.device) {
      where.push('devices.ip = ?');
      params.push(String(options.device));
    }
    const metric = metricSql(rule?.builder);
    const body = `${condition}\n${scope}`;
    const needsIf = body.includes('interfaces.') || metric.startsWith('interfaces.');
    const sql = [
      'SELECT',
      '  devices.ip AS device_ip,',
      '  devices.hostname AS hostname,',
      `  ${needsIf ? 'interfaces.if_index' : 'NULL'} AS if_index,`,
      `  ${needsIf ? 'interfaces.name' : 'NULL'} AS if_name,`,
      `  ${needsIf ? 'interfaces.alias' : 'NULL'} AS if_alias,`,
      `  ${metric} AS metric_value`,
      'FROM devices',
      needsIf ? 'INNER JOIN interfaces ON interfaces.ip = devices.ip' : '',
      `WHERE ${where.join('\n  AND ')}`,
    ].filter(Boolean).join('\n');
    return { sql, params, worse: worseDirection(rule?.builder) };
  } catch (err) {
    return { error: err.message || 'Could not compile rule', sql: '', params: [], worse: 'none' };
  }
}
