export function nextAverage(prevAvg, samples, value, cap = 99) {
  const n = Math.max(0, Math.min(cap, Number(samples) || 0));
  const prev = Number(prevAvg) || 0;
  const sample = Number(value) || 0;
  const avg = n === 0 ? sample : (prev * n + sample) / (n + 1);
  return { avg, samples: Math.min(cap, n + 1) };
}

export function createPollStats(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_device (
      ip TEXT PRIMARY KEY,
      hostname TEXT NOT NULL DEFAULT '',
      last_ms INTEGER NOT NULL,
      avg_ms REAL NOT NULL,
      last_at INTEGER NOT NULL,
      samples INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS poll_cycle (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_ms INTEGER NOT NULL,
      avg_ms REAL NOT NULL,
      last_at INTEGER NOT NULL,
      samples INTEGER NOT NULL
    );
  `);

  const getDevice = db.prepare('SELECT * FROM poll_device WHERE ip = ?');
  const putDevice = db.prepare(`
    INSERT OR REPLACE INTO poll_device (ip, hostname, last_ms, avg_ms, last_at, samples)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getCycle = db.prepare('SELECT * FROM poll_cycle WHERE id = 1');
  const putCycle = db.prepare(`
    INSERT OR REPLACE INTO poll_cycle (id, last_ms, avg_ms, last_at, samples)
    VALUES (1, ?, ?, ?, ?)
  `);

  function recordDevice(ip, hostname, ms, at = Date.now()) {
    const prev = getDevice.get(ip);
    const next = nextAverage(prev?.avg_ms, prev?.samples, ms);
    putDevice.run(ip, hostname || prev?.hostname || '', Math.round(ms), next.avg, at, next.samples);
  }

  function recordCycle(ms, at = Date.now()) {
    const prev = getCycle.get();
    const next = nextAverage(prev?.avg_ms, prev?.samples, ms);
    putCycle.run(Math.round(ms), next.avg, at, next.samples);
  }

  function device(ip) {
    const row = getDevice.get(ip);
    if (!row) return { lastMs: null, avgMs: null, lastAt: null, samples: 0 };
    return { lastMs: row.last_ms, avgMs: row.avg_ms, lastAt: row.last_at, samples: row.samples };
  }

  function summary() {
    const cycle = getCycle.get();
    const devices = db.prepare(`
      SELECT ip, hostname, last_ms AS lastMs, avg_ms AS avgMs, last_at AS lastAt, samples
      FROM poll_device
    `).all();
    return {
      lastMs: cycle ? cycle.last_ms : null,
      avgMs: cycle ? cycle.avg_ms : null,
      lastAt: cycle ? cycle.last_at : null,
      samples: cycle ? cycle.samples : 0,
      devices,
    };
  }

  function forget(ip) {
    db.prepare('DELETE FROM poll_device WHERE ip = ?').run(ip);
  }

  return { recordDevice, recordCycle, device, summary, forget };
}
