export const DEFAULT_SYSLOG = {
  enabled: false,
  port: 5514,
  retainDays: 14,
  maxRows: 100000,
};

const FACILITIES = ['kern', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news', 'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock', 'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'];
const SEVERITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

export function normalizeSyslogConfig(input) {
  const src = { ...DEFAULT_SYSLOG, ...(input || {}) };
  const port = Number(src.port);
  const days = Number(src.retainDays);
  const maxRows = Number(src.maxRows);
  return {
    enabled: !!src.enabled,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_SYSLOG.port,
    retainDays: Number.isFinite(days) && days >= 1 && days <= 3650 ? Math.round(days) : DEFAULT_SYSLOG.retainDays,
    maxRows: Number.isFinite(maxRows) && maxRows >= 100 && maxRows <= 5_000_000 ? Math.round(maxRows) : DEFAULT_SYSLOG.maxRows,
  };
}

export function parseSyslog(raw) {
  let text = String(raw || '').replace(/\0/g, '').trim();
  if (!text) return null;
  let facility = 1;
  let severity = 6;
  const pri = text.match(/^<(\d{1,3})>/);
  if (pri) {
    const code = Math.max(0, Math.min(191, Number(pri[1])));
    facility = Math.floor(code / 8);
    severity = code % 8;
    text = text.slice(pri[0].length).trim();
  }
  if (!text) return null;
  let host = '';
  let message = text;
  if (/^\d\s/.test(text)) {
    const parts = text.split(/\s+/);
    host = parts[2] && parts[2] !== '-' ? parts[2] : '';
    let rest = parts.slice(6);
    if (rest[0] === '-') rest = rest.slice(1);
    if (rest[0] && rest[0].startsWith('[')) {
      const joined = rest.join(' ');
      const end = joined.indexOf('] ');
      message = end >= 0 ? joined.slice(end + 2) : joined;
    } else {
      message = rest.join(' ');
    }
  } else {
    const bsd = text.match(/^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+([\s\S]*)$/);
    if (bsd) {
      host = bsd[1];
      message = bsd[2];
    } else {
      const token = text.match(/^([A-Za-z0-9_.:-]{1,64})\s+([\s\S]*)$/);
      if (token && !token[1].endsWith(':')) {
        host = token[1];
        message = token[2];
      }
    }
  }
  return {
    facility,
    severity,
    facilityName: FACILITIES[facility] || String(facility),
    severityName: SEVERITIES[severity] || String(severity),
    host: host.replace(/:$/, ''),
    message: message.slice(0, 2000),
  };
}

function likeTerm(query) {
  return `%${String(query || '').replace(/[%_\\]/g, '')}%`;
}

export function createSyslogStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS syslog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      source_ip TEXT NOT NULL,
      facility INTEGER NOT NULL,
      severity INTEGER NOT NULL,
      host TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_syslog_at ON syslog(at);
    CREATE INDEX IF NOT EXISTS idx_syslog_source ON syslog(source_ip);
  `);

  const insertRow = db.prepare(`
    INSERT INTO syslog (at, source_ip, facility, severity, host, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  function prune(config) {
    const cfg = normalizeSyslogConfig(config);
    db.prepare('DELETE FROM syslog WHERE at < ?').run(Date.now() - cfg.retainDays * 86400000);
    const count = db.prepare('SELECT COUNT(*) AS n FROM syslog').get().n;
    if (count > cfg.maxRows) {
      db.prepare('DELETE FROM syslog WHERE id IN (SELECT id FROM syslog ORDER BY id ASC LIMIT ?)').run(count - cfg.maxRows);
    }
  }

  function insert(row, config) {
    insertRow.run(
      row.at || Date.now(),
      String(row.sourceIp || ''),
      Number(row.facility) || 0,
      Number(row.severity) || 0,
      String(row.host || '').slice(0, 128),
      String(row.message || '').slice(0, 2000),
    );
    prune(config);
  }

  function mapRow(row) {
    return {
      id: row.id,
      at: row.at,
      sourceIp: row.source_ip,
      facility: row.facility,
      severity: row.severity,
      facilityName: FACILITIES[row.facility] || String(row.facility),
      severityName: SEVERITIES[row.severity] || String(row.severity),
      host: row.host,
      message: row.message,
    };
  }

  function forDevice({ ips = [], hostname = '', q = '', limit = 200 } = {}) {
    const addresses = [...new Set((ips || []).map((ip) => String(ip || '')).filter(Boolean))];
    const names = new Set();
    const host = String(hostname || '').trim();
    if (host) {
      names.add(host);
      const short = host.split('.')[0];
      if (short) names.add(short);
    }
    if (!addresses.length && !names.size) return [];
    const match = [];
    const params = [];
    if (addresses.length) {
      match.push(`source_ip IN (${addresses.map(() => '?').join(',')})`);
      params.push(...addresses);
    }
    for (const name of names) {
      match.push('LOWER(host) = LOWER(?)');
      params.push(name);
    }
    const where = [`(${match.join(' OR ')})`];
    const query = String(q || '').trim();
    if (query) {
      where.push('(message LIKE ? OR host LIKE ? OR source_ip LIKE ?)');
      const like = likeTerm(query);
      params.push(like, like, like);
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 200)));
    const rows = db.prepare(`
      SELECT id, at, source_ip, facility, severity, host, message
      FROM syslog
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?
    `).all(...params);
    return rows.map(mapRow);
  }

  return { insert, prune, forDevice };
}
