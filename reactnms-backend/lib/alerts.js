import { assertReadOnly, compileRule, ENTITIES, TEMPLATES } from './alert-sql.js';

const SEVERITIES = new Set(['ok', 'warning', 'critical']);
const TRANSPORTS = new Set(['email', 'webhook', 'slack']);

export function interfaceTitle(name, alias) {
  const base = String(name || '').trim();
  const extra = String(alias || '').trim();
  if (base && extra) return `${base} — ${extra}`;
  return base || extra;
}

function asList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function safeProcedure(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return text;
  } catch {
    return '';
  }
}

function normalizeGroup(group) {
  const join = group?.join === 'OR' ? 'OR' : 'AND';
  const items = Array.isArray(group?.items) ? group.items.map(normalizeItem).filter(Boolean) : [];
  return { join, items };
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.kind === 'group') {
    const group = normalizeGroup(item);
    return { kind: 'group', join: group.join, items: group.items };
  }
  const op = String(item.op || '=').toUpperCase();
  return { kind: 'cond', entity: String(item.entity || ''), op, value: String(item.value ?? '') };
}

export function normalizeRule(input) {
  const src = input && typeof input === 'object' ? input : {};
  const scope = src.scope && typeof src.scope === 'object' ? src.scope : {};
  return {
    id: String(src.id || ''),
    name: String(src.name || 'Alert rule').slice(0, 200),
    enabled: src.enabled !== false,
    severity: SEVERITIES.has(src.severity) ? src.severity : 'warning',
    notes: String(src.notes || ''),
    procedureUrl: safeProcedure(src.procedureUrl),
    invert: Boolean(src.invert),
    mute: Boolean(src.mute),
    notifyRecovery: src.notifyRecovery !== false,
    notifyAck: Boolean(src.notifyAck),
    operationId: src.operationId ? String(src.operationId) : '',
    advanced: Boolean(src.advanced),
    sql: String(src.sql || ''),
    scope: {
      devices: asList(scope.devices),
      groups: asList(scope.groups),
      locations: asList(scope.locations),
      exclude: Boolean(scope.exclude),
    },
    builder: normalizeGroup(src.builder),
  };
}

export function migrateLegacyRule(old) {
  if (!old || typeof old !== 'object') return normalizeRule({});
  if (old.builder || old.advanced || old.scope) return normalizeRule(old);
  const devices = old.device && old.device !== 'pick' ? [String(old.device)] : [];
  const scope = { devices, groups: [], locations: [], exclude: false };
  if (old.type === 'traffic') {
    const unit = old.unit || 'bps';
    const mult = unit === 'Gbps' ? 1e9 : unit === 'Mbps' ? 1e6 : unit === 'Kbps' ? 1e3 : 1;
    const value = String(Number(old.threshold || 0) * mult);
    const items = [{
      kind: 'cond',
      entity: old.metric === 'out' ? 'interfaces.out_bps' : 'interfaces.in_bps',
      op: old.op === 'lt' ? '<' : '>',
      value,
    }];
    if (old.interface) {
      items.push({ kind: 'cond', entity: 'interfaces.if_index', op: '=', value: String(old.interface) });
    }
    return normalizeRule({
      id: old.id,
      name: old.name,
      enabled: old.enabled,
      severity: 'warning',
      scope,
      builder: { join: 'AND', items },
    });
  }
  return normalizeRule({
    id: old.id,
    name: old.name || 'Device down (ICMP)',
    enabled: old.enabled,
    severity: 'critical',
    scope,
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.device_down', op: '=', value: '' }] },
  });
}

function normalizeOperation(input) {
  const src = input && typeof input === 'object' ? input : {};
  const steps = Array.isArray(src.steps) ? src.steps : [];
  return {
    id: String(src.id || ''),
    name: String(src.name || 'Operation').slice(0, 200),
    delaySec: Math.max(0, Number(src.delaySec) || 0),
    repeatSec: Math.max(0, Number(src.repeatSec) || 0),
    steps: steps.map((step) => ({
      afterSec: Math.max(0, Number(step?.afterSec) || 0),
      transportIds: asList(step?.transportIds),
    })),
  };
}

function normalizeTransport(input) {
  const src = input && typeof input === 'object' ? input : {};
  const type = TRANSPORTS.has(src.type) ? src.type : 'webhook';
  return {
    id: String(src.id || ''),
    name: String(src.name || type).slice(0, 200),
    type,
    target: String(src.target || '').trim(),
  };
}

function normalizeGroupDoc(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    id: String(src.id || ''),
    name: String(src.name || 'Device group').slice(0, 200),
    members: asList(src.members),
  };
}

function applyGroups(rule, groups) {
  const wanted = new Set(rule.scope?.groups || []);
  const members = [];
  for (const group of groups) {
    if (wanted.has(group.id)) members.push(...(group.members || []));
  }
  return { ...rule, scope: { ...rule.scope, groupMembers: [...new Set(members)] } };
}

async function defaultDeliver(transport, payload) {
  if (transport.type === 'email') {
    const mailUrl = process.env.ALERT_MAIL_URL;
    const target = transport.target || 'an unset address';
    if (!mailUrl) {
      return { delivered: false, detail: `Email to ${target} was logged. Set ALERT_MAIL_URL to deliver it.` };
    }
    const response = await fetch(mailUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: transport.target, subject: payload.text, ...payload }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { delivered: false, detail: `Mailer returned ${response.status}` };
    return { delivered: true, detail: `Email accepted for ${target}` };
  }
  const target = String(transport.target || '').trim();
  if (!target) return { delivered: false, detail: `${transport.type} has no URL` };
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return { delivered: false, detail: 'Transport URL is invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { delivered: false, detail: 'Transport URL must be http or https' };
  }
  const body = transport.type === 'slack' ? { text: payload.text } : payload;
  const response = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { delivered: false, detail: `${transport.type} returned ${response.status}` };
  return { delivered: true, detail: `${transport.type} posted` };
}

function transportIdsFor(operation, elapsedMs) {
  const steps = [...(operation?.steps || [])].sort((a, b) => a.afterSec - b.afterSec);
  let chosen = null;
  for (const step of steps) {
    if (elapsedMs >= step.afterSec * 1000) chosen = step;
  }
  return chosen ? chosen.transportIds : [];
}

export function createAlertStore(db, options = {}) {
  const deliver = options.deliver || defaultDeliver;
  db.function('regexp', (pattern, value) => {
    try {
      return new RegExp(String(pattern), 'i').test(value == null ? '' : String(value)) ? 1 : 0;
    } catch {
      return 0;
    }
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      ip TEXT PRIMARY KEY,
      hostname TEXT,
      sys_descr TEXT,
      location TEXT,
      icmp_up INTEGER,
      icmp_at INTEGER,
      icmp_error TEXT
    );
    CREATE TABLE IF NOT EXISTS interfaces (
      ip TEXT NOT NULL,
      if_index TEXT NOT NULL,
      name TEXT,
      alias TEXT,
      admin_status INTEGER,
      oper_status INTEGER,
      in_bps REAL,
      out_bps REAL,
      speed INTEGER,
      ignored INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip, if_index)
    );
    CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alert_operations (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alert_transports (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alert_groups (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS active_alerts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      device_ip TEXT NOT NULL,
      if_index TEXT NOT NULL DEFAULT '',
      hostname TEXT,
      if_name TEXT,
      if_alias TEXT,
      severity TEXT,
      rule_name TEXT,
      message TEXT,
      procedure_url TEXT,
      worse TEXT,
      started_at INTEGER,
      acked_at INTEGER,
      ack_mode TEXT,
      ack_value REAL,
      metric_value REAL,
      last_notified INTEGER,
      muted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      rule_id TEXT,
      device_ip TEXT,
      kind TEXT,
      detail TEXT
    );
  `);
  const activeColumns = new Set(db.prepare('PRAGMA table_info(active_alerts)').all().map((column) => column.name));
  if (!activeColumns.has('if_alias')) db.exec('ALTER TABLE active_alerts ADD COLUMN if_alias TEXT');

  const insertLog = db.prepare('INSERT INTO alert_log (at, rule_id, device_ip, kind, detail) VALUES (?, ?, ?, ?, ?)');
  const upsertActive = db.prepare(`
    INSERT OR REPLACE INTO active_alerts (
      id, rule_id, device_ip, if_index, hostname, if_name, if_alias, severity, rule_name, message,
      procedure_url, worse, started_at, acked_at, ack_mode, ack_value, metric_value, last_notified, muted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function log(kind, ruleId, deviceIp, detail) {
    insertLog.run(Date.now(), ruleId || '', deviceIp || '', kind, String(detail || '').slice(0, 500));
    const count = db.prepare('SELECT COUNT(*) AS c FROM alert_log').get().c;
    if (count > 500) {
      db.prepare('DELETE FROM alert_log WHERE id <= (SELECT id FROM alert_log ORDER BY id DESC LIMIT 1 OFFSET 400)').run();
    }
  }

  function readDocs(table, normalize) {
    return db.prepare(`SELECT doc FROM ${table} ORDER BY id`).all().map((row) => normalize(JSON.parse(row.doc)));
  }

  function writeDoc(table, doc) {
    db.prepare(`INSERT OR REPLACE INTO ${table} (id, doc) VALUES (?, ?)`).run(doc.id, JSON.stringify(doc));
    return doc;
  }

  function listRules() { return readDocs('alert_rules', normalizeRule); }
  function listOperations() { return readDocs('alert_operations', normalizeOperation); }
  function listTransports() { return readDocs('alert_transports', normalizeTransport); }
  function listGroups() { return readDocs('alert_groups', normalizeGroupDoc); }

  function getRule(id) {
    const row = db.prepare('SELECT doc FROM alert_rules WHERE id = ?').get(id);
    return row ? normalizeRule(JSON.parse(row.doc)) : null;
  }

  function saveRule(input) {
    const rule = normalizeRule(input);
    if (!rule.id) rule.id = makeId();
    return writeDoc('alert_rules', rule);
  }

  function deleteRule(id) {
    db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    db.prepare('DELETE FROM active_alerts WHERE rule_id = ?').run(id);
  }

  function saveOperation(input) {
    const doc = normalizeOperation(input);
    if (!doc.id) doc.id = makeId();
    return writeDoc('alert_operations', doc);
  }

  function saveTransport(input) {
    const doc = normalizeTransport(input);
    if (!doc.id) doc.id = makeId();
    return writeDoc('alert_transports', doc);
  }

  function saveGroup(input) {
    const doc = normalizeGroupDoc(input);
    if (!doc.id) doc.id = makeId();
    return writeDoc('alert_groups', doc);
  }

  function mapAlert(row, notes = '') {
    return {
      id: row.id,
      ruleId: row.rule_id,
      deviceIp: row.device_ip,
      ifIndex: row.if_index || '',
      hostname: row.hostname || row.device_ip,
      ifName: row.if_name || '',
      ifAlias: row.if_alias || '',
      severity: row.severity,
      ruleName: row.rule_name,
      message: row.message,
      procedureUrl: row.procedure_url || '',
      notes,
      worse: row.worse || 'none',
      startedAt: row.started_at,
      ackedAt: row.acked_at,
      ackMode: row.ack_mode,
      ackValue: row.ack_value,
      metricValue: row.metric_value,
      lastNotified: row.last_notified,
      muted: Boolean(row.muted),
    };
  }

  function listActive() {
    const notes = new Map(listRules().map((rule) => [rule.id, rule.notes]));
    return db.prepare('SELECT * FROM active_alerts ORDER BY started_at DESC').all()
      .map((row) => mapAlert(row, notes.get(row.rule_id) || ''));
  }

  function listLog(limit = 40, query = '', device = '') {
    const cap = Math.max(1, Math.min(500, Number(limit) || 40));
    const q = String(query || '').trim();
    const exact = String(device || '').trim();
    const like = `%${q.replace(/[%_\\]/g, '')}%`;
    if (exact && q) {
      return db.prepare(`
        SELECT id, at, rule_id AS ruleId, device_ip AS deviceIp, kind, detail FROM alert_log
        WHERE device_ip = ? AND (detail LIKE ? OR kind LIKE ? OR rule_id LIKE ?)
        ORDER BY id DESC LIMIT ?
      `).all(exact, like, like, like, cap);
    }
    if (exact) {
      return db.prepare(`
        SELECT id, at, rule_id AS ruleId, device_ip AS deviceIp, kind, detail FROM alert_log
        WHERE device_ip = ?
        ORDER BY id DESC LIMIT ?
      `).all(exact, cap);
    }
    if (!q) {
      return db.prepare('SELECT id, at, rule_id AS ruleId, device_ip AS deviceIp, kind, detail FROM alert_log ORDER BY id DESC LIMIT ?').all(cap);
    }
    return db.prepare(`
      SELECT id, at, rule_id AS ruleId, device_ip AS deviceIp, kind, detail FROM alert_log
      WHERE detail LIKE ? OR device_ip LIKE ? OR kind LIKE ? OR rule_id LIKE ?
      ORDER BY id DESC LIMIT ?
    `).all(like, like, like, like, cap);
  }

  function payloadFor(kind, rule, alert) {
    const who = alert.hostname && alert.hostname !== alert.device_ip ? `${alert.hostname} (${alert.device_ip})` : alert.device_ip;
    const label = interfaceTitle(alert.if_name, alert.if_alias);
    const where = label ? `${who} ${label}` : who;
    const text = `${kind}: ${rule.name} on ${where}`;
    return {
      kind,
      text,
      rule: rule.name,
      severity: rule.severity,
      device: alert.hostname,
      ip: alert.device_ip,
      interface: interfaceTitle(alert.if_name, alert.if_alias),
      message: alert.message,
      procedureUrl: rule.procedureUrl,
      at: new Date().toISOString(),
    };
  }

  async function send(rule, alert, operation, transports, kind, now) {
    const payload = payloadFor(kind, rule, alert);
    if (rule.mute) {
      log(kind === 'alert' ? 'mute' : kind, rule.id, alert.device_ip, payload.text);
      return;
    }
    const ids = transportIdsFor(operation, now - alert.started_at);
    const chosen = ids.map((id) => transports.get(id)).filter(Boolean);
    if (!chosen.length) {
      log(kind === 'recovery' ? 'recovery' : kind === 'ack' ? 'ack' : 'notify', rule.id, alert.device_ip, `${payload.text} (no transport)`);
      return;
    }
    for (const transport of chosen) {
      try {
        const result = await deliver(transport, payload);
        log(kind, rule.id, alert.device_ip, `${transport.type} ${transport.name}: ${result.detail}`);
      } catch (err) {
        log(kind, rule.id, alert.device_ip, `${transport.type} ${transport.name}: ${err.message || 'failed'}`);
      }
    }
  }

  function shouldNotify(alert, operation, now) {
    if (alert.ack_mode) return false;
    if (!operation) return false;
    const elapsed = now - alert.started_at;
    if (elapsed < (operation.delaySec || 0) * 1000) return false;
    if (!alert.last_notified) return true;
    const repeat = (operation.repeatSec || 0) * 1000;
    if (repeat <= 0) return false;
    return now - alert.last_notified >= repeat;
  }

  function writeActive(alert) {
    upsertActive.run(
      alert.id,
      alert.rule_id,
      alert.device_ip,
      alert.if_index || '',
      alert.hostname || '',
      alert.if_name || '',
      alert.if_alias || '',
      alert.severity,
      alert.rule_name,
      alert.message,
      alert.procedure_url || '',
      alert.worse || 'none',
      alert.started_at,
      alert.acked_at,
      alert.ack_mode,
      alert.ack_value,
      alert.metric_value,
      alert.last_notified,
      alert.muted ? 1 : 0,
    );
  }

  async function evaluate(now = Date.now()) {
    const rules = listRules().filter((rule) => rule.enabled !== false);
    const enabled = new Set(rules.map((rule) => rule.id));
    const groups = listGroups();
    const operations = new Map(listOperations().map((item) => [item.id, item]));
    const transports = new Map(listTransports().map((item) => [item.id, item]));
    const activeRows = db.prepare('SELECT * FROM active_alerts').all();
    const active = new Map(activeRows.map((row) => [row.id, row]));
    const seen = new Set();
    const ran = new Set();

    for (const rule of rules) {
      const compiled = compileRule(applyGroups(rule, groups));
      if (compiled.error) continue;
      let rows = [];
      try {
        rows = db.prepare(compiled.sql).all(...compiled.params);
      } catch (err) {
        log('error', rule.id, '', err.message || 'query failed');
        continue;
      }
      ran.add(rule.id);
      const operation = operations.get(rule.operationId) || null;
      for (const row of rows) {
        const deviceIp = String(row.device_ip || row.ip || '');
        if (!deviceIp) continue;
        const ifIndex = row.if_index == null ? '' : String(row.if_index);
        const id = `${rule.id}|${deviceIp}|${ifIndex}`;
        seen.add(id);
        const metric = row.metric_value == null || row.metric_value === '' ? null : Number(row.metric_value);
        const metricValue = Number.isFinite(metric) ? metric : null;
        const hostname = row.hostname || deviceIp;
        const ifName = row.if_name || '';
        const ifAlias = row.if_alias || '';
        const label = interfaceTitle(ifName, ifAlias);
        const message = `${rule.name}: ${hostname}${label ? ` ${label}` : ''}`;
        let alert = active.get(id);
        let reopened = false;
        if (!alert) {
          alert = {
            id,
            rule_id: rule.id,
            device_ip: deviceIp,
            if_index: ifIndex,
            hostname,
            if_name: ifName,
            if_alias: ifAlias,
            severity: rule.severity,
            rule_name: rule.name,
            message,
            procedure_url: rule.procedureUrl,
            worse: compiled.worse,
            started_at: now,
            acked_at: null,
            ack_mode: null,
            ack_value: null,
            metric_value: metricValue,
            last_notified: null,
            muted: rule.mute ? 1 : 0,
          };
          log('open', rule.id, deviceIp, message);
        } else {
          if (alert.ack_mode === 'worsens' && alert.ack_value != null && metricValue != null && alert.worse !== 'none') {
            const worsened = alert.worse === 'lower' ? metricValue < Number(alert.ack_value) : metricValue > Number(alert.ack_value);
            if (worsened) {
              alert.ack_mode = null;
              alert.acked_at = null;
              alert.ack_value = null;
              reopened = true;
              log('open', rule.id, deviceIp, `${message} worsened`);
            }
          }
          alert.hostname = hostname;
          alert.if_name = ifName;
          alert.if_alias = ifAlias;
          alert.severity = rule.severity;
          alert.rule_name = rule.name;
          alert.message = message;
          alert.procedure_url = rule.procedureUrl;
          alert.worse = compiled.worse;
          alert.metric_value = metricValue;
          alert.muted = rule.mute ? 1 : 0;
        }
        const delayOk = !operation || now - alert.started_at >= (operation.delaySec || 0) * 1000;
        if ((reopened && delayOk) || shouldNotify(alert, operation, now)) {
          await send(rule, alert, operation, transports, 'alert', now);
          alert.last_notified = now;
        }
        writeActive(alert);
        active.set(id, alert);
      }
    }

    for (const alert of activeRows) {
      if (seen.has(alert.id)) continue;
      const rule = getRule(alert.rule_id);
      if (rule && enabled.has(rule.id) && !ran.has(rule.id)) continue;
      if (rule && enabled.has(rule.id) && rule.notifyRecovery && alert.last_notified) {
        const operation = operations.get(rule.operationId) || null;
        await send(rule, alert, operation, transports, 'recovery', now);
      } else {
        log('recovery', alert.rule_id, alert.device_ip, `${alert.message || alert.rule_name} cleared`);
      }
      db.prepare('DELETE FROM active_alerts WHERE id = ?').run(alert.id);
    }
  }

  async function acknowledge(id, mode, now = Date.now()) {
    if (mode !== 'clear' && mode !== 'worsens') throw new Error('mode must be clear or worsens');
    const row = db.prepare('SELECT * FROM active_alerts WHERE id = ?').get(id);
    if (!row) return null;
    row.ack_mode = mode;
    row.acked_at = now;
    row.ack_value = row.metric_value;
    writeActive(row);
    const rule = getRule(row.rule_id);
    if (rule?.notifyAck) {
      const operation = listOperations().find((item) => item.id === rule.operationId) || null;
      const transports = new Map(listTransports().map((item) => [item.id, item]));
      await send(rule, row, operation, transports, 'ack', now);
    } else {
      log('ack', row.rule_id, row.device_ip, `${row.message || row.rule_name} acknowledged until ${mode}`);
    }
    return mapAlert(row, rule?.notes || '');
  }

  function test(ruleInput, device) {
    const prepared = applyGroups(normalizeRule(ruleInput), listGroups());
    const compiled = compileRule(prepared, { device: device || undefined });
    if (compiled.error) {
      return { status: 400, body: { error: compiled.error, sql: compiled.sql || '', params: compiled.params || [], rows: [], match: false, count: 0 } };
    }
    try {
      const rows = db.prepare(compiled.sql).all(...compiled.params);
      return {
        status: 200,
        body: { error: null, sql: compiled.sql, params: compiled.params, rows: rows.slice(0, 50), match: rows.length > 0, count: rows.length },
      };
    } catch (err) {
      if (prepared.advanced && device && !prepared.invert) {
        try {
          const bare = assertReadOnly(prepared.sql);
          const all = db.prepare(bare).all();
          const rows = all.filter((row) => String(row.device_ip || row.ip || '') === String(device));
          return { status: 200, body: { error: null, sql: bare, params: [], rows: rows.slice(0, 50), match: rows.length > 0, count: rows.length } };
        } catch (inner) {
          return { status: 400, body: { error: inner.message, sql: compiled.sql, params: compiled.params, rows: [], match: false, count: 0 } };
        }
      }
      return { status: 400, body: { error: err.message, sql: compiled.sql, params: compiled.params, rows: [], match: false, count: 0 } };
    }
  }

  function migrateLegacy(rules) {
    const saved = [];
    for (const rule of rules || []) saved.push(saveRule(migrateLegacyRule(rule)));
    return saved;
  }

  return {
    listRules,
    getRule,
    saveRule,
    deleteRule,
    listOperations,
    saveOperation,
    deleteOperation: (id) => db.prepare('DELETE FROM alert_operations WHERE id = ?').run(id),
    listTransports,
    saveTransport,
    deleteTransport: (id) => db.prepare('DELETE FROM alert_transports WHERE id = ?').run(id),
    listGroups,
    saveGroup,
    deleteGroup: (id) => db.prepare('DELETE FROM alert_groups WHERE id = ?').run(id),
    listActive,
    listLog,
    acknowledge,
    evaluate,
    test,
    migrateLegacy,
  };
}

export function registerAlertRoutes(app, store, deps) {
  app.get('/api/alerts/entities', (_req, res) => {
    res.json(ENTITIES.map((entity) => ({ id: entity.id, label: entity.label })));
  });
  app.get('/api/alerts/templates', (_req, res) => res.json(TEMPLATES));
  app.get('/api/alerts/rules', (_req, res) => res.json(store.listRules()));
  app.post('/api/alerts/rules', (req, res) => res.json(store.saveRule(req.body || {})));
  app.patch('/api/alerts/rules/:id', (req, res) => {
    const current = store.getRule(req.params.id);
    if (!current) return res.status(404).json({ error: 'Rule not found' });
    const next = store.saveRule({ ...current, ...(req.body || {}), id: current.id });
    res.json(next);
  });
  app.delete('/api/alerts/rules/:id', (req, res) => {
    store.deleteRule(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/alerts/operations', (_req, res) => res.json(store.listOperations()));
  app.post('/api/alerts/operations', (req, res) => res.json(store.saveOperation(req.body || {})));
  app.patch('/api/alerts/operations/:id', (req, res) => {
    const current = store.listOperations().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Operation not found' });
    res.json(store.saveOperation({ ...current, ...(req.body || {}), id: current.id }));
  });
  app.delete('/api/alerts/operations/:id', (req, res) => {
    store.deleteOperation(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/alerts/transports', (_req, res) => res.json(store.listTransports()));
  app.post('/api/alerts/transports', (req, res) => res.json(store.saveTransport(req.body || {})));
  app.patch('/api/alerts/transports/:id', (req, res) => {
    const current = store.listTransports().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Transport not found' });
    res.json(store.saveTransport({ ...current, ...(req.body || {}), id: current.id }));
  });
  app.delete('/api/alerts/transports/:id', (req, res) => {
    store.deleteTransport(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/alerts/groups', (_req, res) => res.json(store.listGroups()));
  app.post('/api/alerts/groups', (req, res) => res.json(store.saveGroup(req.body || {})));
  app.patch('/api/alerts/groups/:id', (req, res) => {
    const current = store.listGroups().find((item) => item.id === req.params.id);
    if (!current) return res.status(404).json({ error: 'Group not found' });
    res.json(store.saveGroup({ ...current, ...(req.body || {}), id: current.id }));
  });
  app.delete('/api/alerts/groups/:id', (req, res) => {
    store.deleteGroup(req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/alerts/active', (_req, res) => res.json(store.listActive()));
  app.get('/api/alerts/log', (req, res) => res.json(store.listLog(req.query.limit, req.query.q, req.query.device)));
  app.post('/api/alerts/active/:id/ack', async (req, res) => {
    try {
      const alert = await store.acknowledge(req.params.id, req.body?.mode);
      if (!alert) return res.status(404).json({ error: 'Alert not found' });
      res.json(alert);
    } catch (err) {
      res.status(400).json({ error: err.message || 'Could not acknowledge' });
    }
  });
  app.post('/api/alerts/test', (req, res) => {
    const result = store.test(req.body?.rule || {}, req.body?.device || '');
    res.json(result.body);
  });
  app.get('/api/alerts/locations', (_req, res) => {
    const names = new Set();
    for (const device of deps.devices()) {
      const location = String(device?.sysLocation || '').trim();
      if (location) names.add(location);
    }
    res.json([...names].sort((a, b) => a.localeCompare(b)));
  });
}
