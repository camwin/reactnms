const OPER = {
  1: 'up',
  2: 'down',
  3: 'testing',
  4: 'unknown',
  5: 'dormant',
  6: 'not present',
  7: 'lower layer down',
};
const ADMIN = { 1: 'up', 2: 'down', 3: 'testing' };
const STP = { 1: 'disabled', 2: 'blocking', 3: 'listening', 4: 'learning', 5: 'forwarding', 6: 'broken' };

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function indexOf(row) {
  return String(row?.if_index ?? row?.index ?? '');
}

export function interfaceTitle(name, alias) {
  const base = String(name || '').trim();
  const extra = String(alias || '').trim();
  if (base && extra) return `${base} — ${extra}`;
  return base || extra;
}

function labelOf(current, previous) {
  return interfaceTitle(current?.name || previous?.name, current?.alias || previous?.alias) || 'interface';
}

export function diffInterfaces(previous, next) {
  if (!Array.isArray(previous) || previous.length === 0) return [];
  const before = new Map(previous.map((row) => [indexOf(row), row]));
  const events = [];
  for (const iface of next || []) {
    const prior = before.get(indexOf(iface));
    if (!prior) continue;
    const label = labelOf(iface, prior);
    const operBefore = num(prior.oper_status ?? prior.operStatus);
    const operAfter = num(iface.oper_status ?? iface.operStatus);
    if (operBefore != null && operAfter != null && operBefore !== operAfter) {
      events.push({
        kind: 'interface',
        summary: `${label} operational ${OPER[operBefore] || operBefore} → ${OPER[operAfter] || operAfter}`,
      });
    }
    const adminBefore = num(prior.admin_status ?? prior.adminStatus);
    const adminAfter = num(iface.admin_status ?? iface.adminStatus);
    if (adminBefore != null && adminAfter != null && adminBefore !== adminAfter) {
      events.push({
        kind: 'interface',
        summary: `${label} admin ${ADMIN[adminBefore] || adminBefore} → ${ADMIN[adminAfter] || adminAfter}`,
      });
    }
  }
  return events;
}

export function diffReachability(previous, next) {
  if (!previous || previous.icmp_at == null) return [];
  const before = previous.icmp_up ?? previous.icmpUp;
  const after = next?.icmp_up ?? next?.icmpUp;
  if (before == null || after == null) return [];
  if (Number(before) === Number(after)) return [];
  return [{ kind: 'reachability', summary: Number(after) ? 'ICMP up' : 'ICMP down' }];
}

export function diffIdentity(previous, next) {
  if (!previous || !next) return [];
  const events = [];
  const nameBefore = String(previous.sysName || previous.hostname || '').trim();
  const nameAfter = String(next.sysName || next.hostname || '').trim();
  if (nameBefore && nameAfter && nameBefore !== nameAfter) {
    events.push({ kind: 'identity', summary: `Hostname ${nameBefore} → ${nameAfter}` });
  }
  const locBefore = String(previous.sysLocation || previous.location || '').trim();
  const locAfter = String(next.sysLocation || next.location || '').trim();
  if ((locBefore || locAfter) && locBefore !== locAfter) {
    events.push({ kind: 'identity', summary: `Location ${locBefore || 'blank'} → ${locAfter || 'blank'}` });
  }
  return events;
}

function stpKey(row) {
  return String(row?.bridge_port ?? row?.bridgePort ?? '');
}

export function diffStp(previous, next) {
  if (!Array.isArray(previous) || previous.length === 0) return [];
  const before = new Map(previous.map((row) => [stpKey(row), row]));
  const events = [];
  for (const port of next || []) {
    const prior = before.get(stpKey(port));
    if (!prior) continue;
    const from = num(prior.state);
    const to = num(port.state);
    if (from == null || to == null || from === to) continue;
    const name = port.name || prior.name || `bridge port ${stpKey(port)}`;
    events.push({
      kind: 'spanning-tree',
      summary: `${name} spanning-tree ${STP[from] || from} → ${STP[to] || to}`,
    });
  }
  return events;
}

export function neighborRecord(row) {
  return {
    protocol: String(row?.protocol || '').toLowerCase(),
    localIf: String(row?.localIf || row?.local_if || ''),
    remoteName: String(row?.remoteName || row?.remote_name || row?.remoteAddr || row?.remote_addr || ''),
    remotePort: String(row?.remotePort || row?.remote_port || ''),
  };
}

function neighborKey(row) {
  const item = neighborRecord(row);
  return [item.protocol, item.localIf, item.remoteName.toLowerCase(), item.remotePort.toLowerCase()].join('|');
}

function neighborLabel(row) {
  const item = neighborRecord(row);
  const protocol = (item.protocol || 'neighbor').toUpperCase();
  const remote = item.remoteName || 'unknown';
  const port = item.remotePort ? ` ${item.remotePort}` : '';
  const local = item.localIf ? ` on if ${item.localIf}` : '';
  return `${protocol} ${remote}${port}${local}`;
}

export function diffNeighbors(previous, next) {
  if (!Array.isArray(previous) || previous.length === 0) return [];
  const before = new Map(previous.map((row) => [neighborKey(row), row]));
  const after = new Map((next || []).map((row) => [neighborKey(row), row]));
  const events = [];
  for (const [key, row] of after) {
    if (!before.has(key)) events.push({ kind: 'neighbor', summary: `${neighborLabel(row)} appeared` });
  }
  for (const [key, row] of before) {
    if (!after.has(key)) events.push({ kind: 'neighbor', summary: `${neighborLabel(row)} disappeared` });
  }
  return events;
}

function likeTerm(query) {
  return `%${String(query || '').trim().replace(/[%_\\]/g, '')}%`;
}

export function createEventStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      device_ip TEXT NOT NULL,
      hostname TEXT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_device_events_at ON device_events(at DESC);
    CREATE TABLE IF NOT EXISTS stp_state (
      ip TEXT NOT NULL,
      bridge_port TEXT NOT NULL,
      if_index TEXT,
      name TEXT,
      state INTEGER,
      seen_at INTEGER,
      PRIMARY KEY (ip, bridge_port)
    );
    CREATE TABLE IF NOT EXISTS neighbor_state (
      ip TEXT NOT NULL,
      neighbor_key TEXT NOT NULL,
      protocol TEXT,
      local_if TEXT,
      remote_name TEXT,
      remote_port TEXT,
      seen_at INTEGER,
      PRIMARY KEY (ip, neighbor_key)
    );
    CREATE TABLE IF NOT EXISTS event_schedule (
      ip TEXT PRIMARY KEY,
      stp_at INTEGER,
      neighbor_at INTEGER
    );
  `);

  const insert = db.prepare('INSERT INTO device_events (at, device_ip, hostname, kind, summary) VALUES (?, ?, ?, ?, ?)');

  function lookupHostname(ip) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'devices'").get();
    if (!table) return '';
    return db.prepare('SELECT hostname FROM devices WHERE ip = ?').get(ip)?.hostname || '';
  }

  function record(ip, hostname, events, at = Date.now()) {
    if (!events?.length) return;
    const name = hostname || lookupHostname(ip) || ip;
    const tx = db.transaction((rows) => {
      for (const event of rows) insert.run(at, ip, name, event.kind, String(event.summary || '').slice(0, 400));
    });
    tx(events);
    const count = db.prepare('SELECT COUNT(*) AS c FROM device_events').get().c;
    if (count > 4000) {
      db.prepare('DELETE FROM device_events WHERE id <= (SELECT id FROM device_events ORDER BY id DESC LIMIT 1 OFFSET 3500)').run();
    }
  }

  function list({ device = '', q = '', limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (device) {
      where.push('device_ip = ?');
      params.push(String(device));
    }
    const query = String(q || '').trim();
    if (query) {
      where.push('(summary LIKE ? OR kind LIKE ? OR hostname LIKE ? OR device_ip LIKE ?)');
      const like = likeTerm(query);
      params.push(like, like, like, like);
    }
    params.push(Math.max(1, Math.min(500, Number(limit) || 200)));
    const sql = `SELECT id, at, device_ip AS deviceIp, hostname, kind, summary FROM device_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...params);
  }

  function noteInterfaces(ip, nextRows, hostname = '') {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'interfaces'").get();
    const previous = table
      ? db.prepare('SELECT if_index, name, alias, admin_status, oper_status FROM interfaces WHERE ip = ?').all(ip)
      : [];
    record(ip, hostname, diffInterfaces(previous, nextRows));
  }

  function noteReachability(ip, previous, next, hostname = '') {
    record(ip, hostname, diffReachability(previous, next));
  }

  function noteIdentity(ip, previous, next, hostname = '') {
    record(ip, hostname || next?.sysName || '', diffIdentity(previous, next));
  }

  function noteStp(ip, ports, hostname = '') {
    const previous = db.prepare('SELECT bridge_port, if_index, name, state FROM stp_state WHERE ip = ?').all(ip);
    const events = diffStp(previous, ports);
    const now = Date.now();
    const upsert = db.prepare('INSERT OR REPLACE INTO stp_state (ip, bridge_port, if_index, name, state, seen_at) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction((rows) => {
      db.prepare('DELETE FROM stp_state WHERE ip = ?').run(ip);
      for (const port of rows || []) {
        const key = stpKey(port);
        if (!key) continue;
        upsert.run(ip, key, String(port.ifIndex ?? port.if_index ?? ''), port.name || '', num(port.state), now);
      }
    });
    tx(ports || []);
    record(ip, hostname, events, now);
    touch(ip, 'stp', now);
  }

  function noteNeighbors(ip, neighbors, hostname = '') {
    const previous = db.prepare('SELECT protocol, local_if AS localIf, remote_name AS remoteName, remote_port AS remotePort FROM neighbor_state WHERE ip = ?').all(ip);
    const events = diffNeighbors(previous, neighbors);
    const now = Date.now();
    const upsert = db.prepare('INSERT OR REPLACE INTO neighbor_state (ip, neighbor_key, protocol, local_if, remote_name, remote_port, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tx = db.transaction((rows) => {
      db.prepare('DELETE FROM neighbor_state WHERE ip = ?').run(ip);
      for (const row of rows || []) {
        const item = neighborRecord(row);
        if (!item.remoteName && !item.localIf) continue;
        upsert.run(ip, neighborKey(item), item.protocol, item.localIf, item.remoteName, item.remotePort, now);
      }
    });
    tx(neighbors || []);
    record(ip, hostname, events, now);
    touch(ip, 'neighbor', now);
  }

  function touch(ip, kind, at = Date.now()) {
    if (kind === 'stp') {
      db.prepare('INSERT INTO event_schedule (ip, stp_at) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET stp_at = excluded.stp_at').run(ip, at);
    } else {
      db.prepare('INSERT INTO event_schedule (ip, neighbor_at) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET neighbor_at = excluded.neighbor_at').run(ip, at);
    }
  }

  function nextDue(kind, ips, now = Date.now()) {
    const column = kind === 'stp' ? 'stp_at' : 'neighbor_at';
    const rows = db.prepare(`SELECT ip, ${column} AS at FROM event_schedule`).all();
    const seen = new Map(rows.map((row) => [row.ip, Number(row.at) || 0]));
    let chosen = null;
    let oldest = Infinity;
    for (const ip of ips || []) {
      const at = seen.get(ip) || 0;
      if (at && now - at < 60000) continue;
      if (at < oldest) {
        oldest = at;
        chosen = ip;
      }
    }
    return chosen;
  }

  function forgetDevice(ip) {
    db.prepare('DELETE FROM device_events WHERE device_ip = ?').run(ip);
    db.prepare('DELETE FROM stp_state WHERE ip = ?').run(ip);
    db.prepare('DELETE FROM neighbor_state WHERE ip = ?').run(ip);
    db.prepare('DELETE FROM event_schedule WHERE ip = ?').run(ip);
  }

  return {
    list,
    noteInterfaces,
    noteReachability,
    noteIdentity,
    noteStp,
    noteNeighbors,
    touch,
    nextDue,
    forgetDevice,
  };
}
