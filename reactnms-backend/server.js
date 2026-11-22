import express from 'express';
import cors from 'cors';
import snmp from 'net-snmp';
import cron from 'node-cron';
import IPCIDR from 'ip-cidr';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'discovery.json');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'reactnms.db');

let discoveryConfig = {
  subnets: ['192.168.1.0/24'],
  community: 'public',
  schedule: { enabled: false, cron: '0 */6 * * *' }, // every 6 hours
  netbox: { url: '', token: '', tag: '', role: '' },
  lastRun: null,
  results: [],
};

function loadConfig() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      discoveryConfig = { ...discoveryConfig, ...data };
    }
  } catch (e) {
    console.error('Failed to load discovery config', e.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(discoveryConfig, null, 2));
  } catch (e) {
    console.error('Failed to save discovery config', e.message);
  }
}

loadConfig();

function expandSubnet(cidr, limit = 254) {
  // Allow a bare IP (treat as /32)
  if (cidr && !cidr.includes('/')) {
    return [cidr];
  }
  try {
    const block = new IPCIDR(cidr);
    const ips = block.toArray({ from: 1, limit });
    return ips.slice(0, limit);
  } catch {
    return [];
  }
}

async function probeSNMP(ip, community, timeout = 1500) {
  return new Promise((resolve) => {
    const session = snmp.createSession(ip, community, {
      port: 161,
      retries: 0,
      timeout,
      version: snmp.Version2c,
    });
    session.get(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.5.0'], (error, varbinds) => {
      session.close();
      if (error || !varbinds || snmp.isVarbindError(varbinds[0])) {
        return resolve(null);
      }
      resolve({
        ip,
        sysDescr: String(varbinds[0]?.value || ''),
        sysName: String(varbinds[1]?.value || ip),
        method: 'snmp',
      });
    });
  });
}

async function scanSubnet(cidr, community, concurrency = 20) {
  const ips = expandSubnet(cidr);
  const found = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((ip) => probeSNMP(ip, community)));
    results.forEach((r) => r && found.push(r));
  }
  return found;
}

async function runDiscovery(subnets, community) {
  const all = [];
  for (const subnet of subnets) {
    const devices = await scanSubnet(subnet, community);
    all.push(...devices.map((d) => ({ ...d, subnet, discoveredAt: new Date().toISOString() })));
  }
  discoveryConfig.results = all;
  discoveryConfig.lastRun = new Date().toISOString();
  saveConfig();
  return all;
}

// --- Routes ---

app.get('/api/discovery/config', (_req, res) => {
  res.json(discoveryConfig);
});

app.post('/api/discovery/config', (req, res) => {
  const { subnets, community, schedule, netbox } = req.body;
  if (subnets) discoveryConfig.subnets = Array.isArray(subnets) ? subnets : [subnets];
  if (community) discoveryConfig.community = community;
  if (schedule) discoveryConfig.schedule = { ...discoveryConfig.schedule, ...schedule };
  if (netbox) discoveryConfig.netbox = { ...discoveryConfig.netbox, ...netbox };
  saveConfig();
  res.json(discoveryConfig);
});

app.post('/api/discovery/scan', async (req, res) => {
  const subnets = req.body.subnets || discoveryConfig.subnets;
  const community = req.body.community || discoveryConfig.community;
  try {
    const results = await runDiscovery(subnets, community);
    res.json({ count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/discovery/results', (_req, res) => {
  res.json({
    lastRun: discoveryConfig.lastRun,
    count: discoveryConfig.results.length,
    results: discoveryConfig.results,
  });
});

// NetBox import
app.post('/api/netbox/import', async (req, res) => {
  const { url, token, tag, role, type = 'prefixes' } = req.body;
  const base = (url || discoveryConfig.netbox.url).replace(/\/$/, '');
  const apiToken = token || discoveryConfig.netbox.token;
  if (!base || !apiToken) {
    return res.status(400).json({ error: 'NetBox URL and token required' });
  }

  try {
    const headers = { Authorization: `Token ${apiToken}`, Accept: 'application/json' };
    let endpoint = type === 'devices' ? '/api/dcim/devices/' : '/api/ipam/prefixes/';
    const params = new URLSearchParams();
    if (tag) params.set('tag', tag);
    if (role) params.set('role', role);
    params.set('limit', '100');

    const resp = await fetch(`${base}${endpoint}?${params}`, { headers });
    if (!resp.ok) throw new Error(`NetBox ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();

    const items = (data.results || []).map((item) => {
      if (type === 'devices') {
        return {
          name: item.name,
          ip: item.primary_ip4?.address?.split('/')[0] || item.primary_ip?.address?.split('/')[0],
          role: item.role?.name,
          site: item.site?.name,
          status: item.status?.value,
        };
      }
      return {
        prefix: item.prefix,
        description: item.description,
        role: item.role?.name,
        site: item.scope?.name || item.site?.name,
      };
    });

    // If prefixes, add them to scan list
    if (type === 'prefixes') {
      const prefixes = items.map((i) => i.prefix).filter(Boolean);
      discoveryConfig.subnets = [...new Set([...discoveryConfig.subnets, ...prefixes])];
      saveConfig();
    }

    res.json({ count: items.length, items, type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple scheduler
let cronJob = null;
function startScheduler() {
  if (cronJob) cronJob.stop();
  if (discoveryConfig.schedule.enabled && discoveryConfig.schedule.cron) {
    cronJob = cron.schedule(discoveryConfig.schedule.cron, async () => {
      console.log('Scheduled discovery starting...');
      try {
        await runDiscovery(discoveryConfig.subnets, discoveryConfig.community);
        console.log(`Scheduled discovery finished: ${discoveryConfig.results.length} devices`);
      } catch (e) {
        console.error('Scheduled discovery failed', e.message);
      }
    });
  }
}

startScheduler();

// Single-device SNMP poll (used by Dashboard / Devices)
app.get('/api/device', async (req, res) => {
  const host = req.query.host || process.env.SNMP_HOST || '192.168.1.1';
  const community = req.query.community || process.env.SNMP_COMMUNITY || 'public';
  try {
    const result = await probeSNMP(host, community, 2000);
    if (!result) {
      return res.status(502).json({ error: 'SNMP timeout or unreachable', host, community });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

import Database from 'better-sqlite3';

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS interface_selections (
    ip TEXT PRIMARY KEY,
    indexes TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS traffic_raw (
    ip TEXT NOT NULL,
    if_index TEXT NOT NULL,
    t INTEGER NOT NULL,
    in_octets INTEGER NOT NULL,
    out_octets INTEGER NOT NULL,
    PRIMARY KEY (ip, if_index, t)
  );
  CREATE INDEX IF NOT EXISTS idx_traffic_raw_lookup ON traffic_raw(ip, if_index, t);
  CREATE TABLE IF NOT EXISTS interface_descriptions (
    ip TEXT NOT NULL,
    if_index TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (ip, if_index)
  );
  CREATE TABLE IF NOT EXISTS traffic_1m (
    ip TEXT NOT NULL,
    if_index TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    in_octets INTEGER NOT NULL,
    out_octets INTEGER NOT NULL,
    PRIMARY KEY (ip, if_index, bucket)
  );
`);

function getSelections(ip) {
  const row = db.prepare('SELECT indexes FROM interface_selections WHERE ip = ?').get(ip);
  return row ? JSON.parse(row.indexes) : [];
}
function setSelections(ip, indexes) {
  db.prepare('INSERT OR REPLACE INTO interface_selections (ip, indexes) VALUES (?, ?)').run(ip, JSON.stringify(indexes));
}

function recordTraffic(ip, interfaces) {
  const now = Date.now();
  const selected = getSelections(ip);
  const insert = db.prepare('INSERT OR REPLACE INTO traffic_raw (ip, if_index, t, in_octets, out_octets) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const r of rows) insert.run(r.ip, r.ifIndex, r.t, r.inOctets, r.outOctets);
  });
  const rows = [];
  (interfaces || []).forEach((iface) => {
    if (selected.length && !selected.includes(String(iface.index))) return;
    rows.push({
      ip,
      ifIndex: String(iface.index),
      t: now,
      inOctets: iface.inOctets || 0,
      outOctets: iface.outOctets || 0,
    });
  });
  if (rows.length) tx(rows);
  // Simple rollup: every minute, aggregate last minute into traffic_1m
  rollup1m();
}

function rollup1m() {
  const cutoff = Date.now() - 60_000;
  const recent = db.prepare(`
    SELECT ip, if_index, 
           (t / 60000) * 60000 as bucket,
           AVG(in_octets) as in_octets,
           AVG(out_octets) as out_octets
    FROM traffic_raw
    WHERE t >= ?
    GROUP BY ip, if_index, bucket
  `).all(cutoff);
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO traffic_1m (ip, if_index, bucket, in_octets, out_octets)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) upsert.run(r.ip, r.if_index, r.bucket, Math.round(r.in_octets), Math.round(r.out_octets));
  });
  if (recent.length) tx(recent);
  // Prune raw older than 2 hours
  db.prepare('DELETE FROM traffic_raw WHERE t < ?').run(Date.now() - 2 * 3600 * 1000);
}

app.get('/api/devices/:ip/selections', (req, res) => {
  res.json(getSelections(req.params.ip));
});
app.post('/api/devices/:ip/selections', (req, res) => {
  const ip = req.params.ip;
  const indexes = Array.isArray(req.body.indexes) ? req.body.indexes.map(String) : [];
  setSelections(ip, indexes);
  res.json(indexes);
});

app.get('/api/devices/:ip/traffic', (req, res) => {
  const ip = req.params.ip;
  const indexes = (req.query.if || '').split(',').filter(Boolean);
  const from = Number(req.query.from) || Date.now() - 3600_000;
  const to = Number(req.query.to) || Date.now();
  const resolution = req.query.res || 'raw'; // raw | 1m
  const toUse = indexes.length ? indexes : getSelections(ip);
  const series = {};
  const table = resolution === '1m' ? 'traffic_1m' : 'traffic_raw';
  const timeCol = resolution === '1m' ? 'bucket' : 't';
  const stmt = db.prepare(`
    SELECT ${timeCol} as t, in_octets as "in", out_octets as "out"
    FROM ${table}
    WHERE ip = ? AND if_index = ? AND ${timeCol} BETWEEN ? AND ?
    ORDER BY ${timeCol}
  `);
  toUse.forEach((idx) => {
    series[idx] = stmt.all(ip, idx, from, to);
  });
  res.json(series);
});

app.get('/api/devices/:ip/stats', (req, res) => {
  const ip = req.params.ip;
  const raw = db.prepare('SELECT COUNT(*) as c, SUM(in_octets + out_octets) as bytes FROM traffic_raw WHERE ip = ?').get(ip) || { c: 0, bytes: 0 };
  const rolled = db.prepare('SELECT COUNT(*) as c FROM traffic_1m WHERE ip = ?').get(ip) || { c: 0 };
  const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
  res.json({
    ip,
    rawSamples: raw.c || 0,
    rawApproxBytes: raw.bytes || 0,
    rolledSamples: rolled.c || 0,
    dbSizeBytes: dbSize?.size || 0,
  });
});

function getDescriptions(ip) {
  const rows = db.prepare('SELECT if_index, description FROM interface_descriptions WHERE ip = ?').all(ip);
  const map = {};
  rows.forEach((r) => { map[r.if_index] = r.description; });
  return map;
}
function setDescription(ip, ifIndex, description) {
  db.prepare('INSERT OR REPLACE INTO interface_descriptions (ip, if_index, description) VALUES (?, ?, ?)').run(ip, String(ifIndex), description || '');
}

app.get('/api/devices/:ip/descriptions', (req, res) => {
  res.json(getDescriptions(req.params.ip));
});
app.post('/api/devices/:ip/descriptions', (req, res) => {
  const ip = req.params.ip;
  const { index, description } = req.body || {};
  if (index == null) return res.status(400).json({ error: 'index required' });
  setDescription(ip, index, description);
  res.json({ ok: true });
});

// Background poller for selected interfaces
setInterval(async () => {
  const all = db.prepare('SELECT ip, indexes FROM interface_selections').all();
  for (const row of all) {
    const ip = row.ip;
    const indexes = JSON.parse(row.indexes || '[]');
    if (!indexes.length) continue;
    try {
      const community = discoveryConfig.community || 'public';
      const session = snmp.createSession(ip, community, { port: 161, retries: 0, timeout: 1500, version: snmp.Version2c });
      const interfaces = await new Promise((resolve) => {
        const list = [];
        const t = setTimeout(() => { try { session.close(); } catch {} resolve(list); }, 3000);
        session.table('1.3.6.1.2.1.2.2', 20, (error, table) => {
          clearTimeout(t);
          try { session.close(); } catch {}
          if (error || !table) return resolve([]);
          Object.entries(table).forEach(([idx, r]) => {
            if (!indexes.includes(String(idx))) return;
            list.push({
              index: idx,
              inOctets: Number(r[10] || 0),
              outOctets: Number(r[16] || 0),
            });
          });
          resolve(list);
        });
      });
      if (interfaces.length) recordTraffic(ip, interfaces);
    } catch (e) {
      console.error('Poller error for', ip, e.message);
    }
  }
}, 10000);
app.get('/api/devices/:ip', async (req, res) => {
  const ip = req.params.ip;
  const community = req.query.community || discoveryConfig.community || 'public';

  const session = snmp.createSession(ip, community, {
    port: 161,
    retries: 0,
    timeout: 1500,
    version: snmp.Version2c,
  });

  const oids = [
    '1.3.6.1.2.1.1.1.0', // sysDescr
    '1.3.6.1.2.1.1.5.0', // sysName
    '1.3.6.1.2.1.1.6.0', // sysLocation
    '1.3.6.1.2.1.1.3.0', // sysUpTime
    '1.3.6.1.2.1.1.4.0', // sysContact
  ];

  const timeout = setTimeout(() => {
    try { session.close(); } catch {}
    if (!res.headersSent) {
      res.status(504).json({ error: 'SNMP timeout', ip });
    }
  }, 8000);

  try {
    const sys = await new Promise((resolve, reject) => {
      session.get(oids, (err, varbinds) => {
        if (err) return reject(err);
        resolve({
          sysDescr: String(varbinds[0]?.value || ''),
          sysName: String(varbinds[1]?.value || ip),
          sysLocation: String(varbinds[2]?.value || ''),
          sysUpTime: Number(varbinds[3]?.value || 0),
          sysContact: String(varbinds[4]?.value || ''),
        });
      });
    });

    // Walk interfaces (ifTable) with a short timeout
    const interfaces = await new Promise((resolve) => {
      const list = [];
      const walkTimeout = setTimeout(() => resolve(list), 4000);
      session.table('1.3.6.1.2.1.2.2', 20, (error, table) => {
        clearTimeout(walkTimeout);
        if (error || !table) return resolve([]);
        Object.entries(table).forEach(([idx, row]) => {
          list.push({
            index: idx,
            name: String(row[2] || ''),
            type: Number(row[3] || 0),
            speed: Number(row[5] || 0),
            adminStatus: Number(row[7] || 0),
            operStatus: Number(row[8] || 0),
            inOctets: Number(row[10] || 0),
            outOctets: Number(row[16] || 0),
          });
        });
        resolve(list);
      });
    });

    clearTimeout(timeout);
    try { session.close(); } catch {}
    recordTraffic(ip, interfaces);
    const descriptions = getDescriptions(ip);
    interfaces.forEach((iface) => {
      iface.customDesc = descriptions[String(iface.index)] || '';
    });
    if (!res.headersSent) {
      res.json({ ip, community, ...sys, interfaces });
    }
  } catch (err) {
    clearTimeout(timeout);
    try { session.close(); } catch {}
    if (!res.headersSent) {
      res.status(502).json({ error: err.message || 'SNMP failed', ip });
    }
  }
});

// Traffic history for selected interfaces
app.get('/api/devices/:ip/traffic', (req, res) => {
  const ip = req.params.ip;
  const indexes = (req.query.if || '').split(',').filter(Boolean);
  const series = {};
  indexes.forEach((idx) => {
    const key = `${ip}:${idx}`;
    series[idx] = trafficHistory.get(key) || [];
  });
  res.json(series);
});

// Simple alert rules
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
  } catch {}
  return [];
}
function saveAlerts(rules) {
  try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(rules, null, 2)); } catch {}
}
let alertRules = loadAlerts();

app.get('/api/alerts/rules', (_req, res) => res.json(alertRules));
app.post('/api/alerts/rules', (req, res) => {
  alertRules.push(req.body);
  saveAlerts(alertRules);
  res.json(req.body);
});
app.delete('/api/alerts/rules/:id', (req, res) => {
  alertRules = alertRules.filter((r) => r.id !== req.params.id);
  saveAlerts(alertRules);
  res.json({ ok: true });
});
app.patch('/api/alerts/rules/:id', (req, res) => {
  alertRules = alertRules.map((r) => (r.id === req.params.id ? { ...r, ...req.body } : r));
  saveAlerts(alertRules);
  res.json({ ok: true });
});

// Keep existing health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, discovery: discoveryConfig.schedule.enabled });
});

app.listen(PORT, () => {
  console.log(`ReactNMS backend (with discovery) on http://localhost:${PORT}`);
});
