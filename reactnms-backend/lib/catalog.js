export function createCatalog(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_serial (
      ip TEXT NOT NULL,
      serial TEXT NOT NULL,
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_vlan (
      ip TEXT NOT NULL,
      vlan_id TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS catalog_seen (
      ip TEXT PRIMARY KEY,
      serial_at INTEGER,
      vlan_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS optic_sample (
      ip TEXT NOT NULL,
      name TEXT NOT NULL,
      t INTEGER NOT NULL,
      rx REAL,
      tx REAL,
      PRIMARY KEY (ip, name, t)
    );
  `);

  function replaceRows(ip, table, columns, rows, stampColumn) {
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM ${table} WHERE ip = ?`).run(ip);
      const placeholders = columns.map(() => '?').join(', ');
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);
      for (const values of rows) insert.run(...values);
      db.prepare(`
        INSERT INTO catalog_seen (ip, ${stampColumn}) VALUES (?, ?)
        ON CONFLICT(ip) DO UPDATE SET ${stampColumn} = excluded.${stampColumn}
      `).run(ip, Date.now());
    });
    tx();
  }

  function saveSerials(ip, rows) {
    const at = Date.now();
    const values = [];
    const seen = new Set();
    for (const row of rows || []) {
      const serial = String(row.serial || '').trim();
      if (!serial || seen.has(serial.toLowerCase())) continue;
      seen.add(serial.toLowerCase());
      values.push([ip, serial, String(row.name || ''), String(row.model || ''), at]);
    }
    replaceRows(ip, 'device_serial', ['ip', 'serial', 'name', 'model', 'updated_at'], values, 'serial_at');
  }

  function saveVlans(ip, rows) {
    const at = Date.now();
    const values = [];
    const seen = new Set();
    for (const row of rows || []) {
      const id = String(row.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      values.push([ip, id, String(row.name || ''), String(row.source || ''), at]);
    }
    replaceRows(ip, 'device_vlan', ['ip', 'vlan_id', 'name', 'source', 'updated_at'], values, 'vlan_at');
  }

  function serialsFor(ip) {
    return db.prepare(`
      SELECT serial, name, model FROM device_serial WHERE ip = ? ORDER BY name, serial
    `).all(ip);
  }

  function allSerials() {
    return db.prepare(`
      SELECT ip, serial, name, model FROM device_serial ORDER BY ip, serial
    `).all();
  }

  function searchSerial(query) {
    const like = `%${String(query || '').trim().replace(/[%_\\]/g, '')}%`;
    return db.prepare(`
      SELECT ip, serial, name, model FROM device_serial
      WHERE serial LIKE ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE
      ORDER BY ip, serial
      LIMIT 100
    `).all(like, like);
  }

  function searchVlan(query) {
    const text = String(query || '').trim();
    if (!text) return [];
    if (/^\d+$/.test(text)) {
      return db.prepare(`
        SELECT ip, vlan_id AS id, name, source FROM device_vlan
        WHERE vlan_id = ? OR name LIKE ? COLLATE NOCASE
        ORDER BY ip, vlan_id
        LIMIT 200
      `).all(text, `%${text}%`);
    }
    const like = `%${text.replace(/[%_\\]/g, '')}%`;
    return db.prepare(`
      SELECT ip, vlan_id AS id, name, source FROM device_vlan
      WHERE vlan_id LIKE ? OR name LIKE ? COLLATE NOCASE
      ORDER BY ip, vlan_id
      LIMIT 200
    `).all(like, like);
  }

  function seen(ip) {
    return db.prepare('SELECT serial_at AS serialAt, vlan_at AS vlanAt FROM catalog_seen WHERE ip = ?').get(ip) || { serialAt: null, vlanAt: null };
  }

  function recordOptics(ip, optics, minGapMs = 60000) {
    const now = Date.now();
    const last = db.prepare('SELECT MAX(t) AS t FROM optic_sample WHERE ip = ?').get(ip);
    if (last?.t && now - last.t < minGapMs) return;
    const insert = db.prepare('INSERT OR REPLACE INTO optic_sample (ip, name, t, rx, tx) VALUES (?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      for (const optic of optics || []) {
        insert.run(ip, optic.name, now, optic.rx ?? null, optic.tx ?? null);
      }
      db.prepare('DELETE FROM optic_sample WHERE ip = ? AND t < ?').run(ip, now - 48 * 3600 * 1000);
    });
    tx();
  }

  function counts() {
    return {
      serials: db.prepare('SELECT COUNT(*) AS n FROM device_serial').get().n,
      vlans: db.prepare('SELECT COUNT(*) AS n FROM device_vlan').get().n,
    };
  }

  function opticHistory(ip, since = Date.now() - 6 * 3600 * 1000) {
    return db.prepare(`
      SELECT name, t, rx, tx FROM optic_sample WHERE ip = ? AND t >= ? ORDER BY name, t
    `).all(ip, since);
  }

  return { saveSerials, saveVlans, serialsFor, allSerials, searchSerial, searchVlan, seen, counts, recordOptics, opticHistory };
}
