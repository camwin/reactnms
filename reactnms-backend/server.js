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
  credentials: [
    { id: 'default-v2c', version: '2c', community: 'public', name: 'public' },
  ],
  schedule: { enabled: false, cron: '0 */6 * * *' }, // every 6 hours
  netbox: { url: '', token: '', tag: '', role: '' },
  deviceCreds: {},
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
if (!discoveryConfig.deviceCreds || typeof discoveryConfig.deviceCreds !== 'object') discoveryConfig.deviceCreds = {};
if (!Array.isArray(discoveryConfig.credentials)) discoveryConfig.credentials = [];

// Usable hosts per prefix. A /20 is 4094. Larger blocks are scanned only up to this cap and the log says so.
const HOST_CAP = Math.min(65534, Math.max(1, Number(process.env.DISCOVERY_HOST_CAP) || 4094));
const PROBE_CONCURRENCY = Math.min(64, Math.max(1, Number(process.env.DISCOVERY_CONCURRENCY) || 48));

function prefixPlan(cidr) {
  const raw = String(cidr || '').trim();
  if (!raw) return { error: 'empty prefix', total: 0, scan: 0, truncated: false };
  if (!raw.includes('/')) return { total: 1, scan: 1, truncated: false };
  if (raw.includes(':')) return { error: 'IPv6 prefixes are not scanned', total: 0, scan: 0, truncated: false };
  let block;
  try {
    block = new IPCIDR(raw);
  } catch {
    return { error: 'invalid prefix', total: 0, scan: 0, truncated: false };
  }
  const size = Number(block.size.toString());
  if (!Number.isFinite(size) || size < 1) return { error: 'prefix is too large', total: 0, scan: 0, truncated: false };
  const prefix = Number(raw.split('/')[1]);
  const usable = prefix <= 30 ? Math.max(0, size - 2) : size;
  const scan = Math.min(usable, HOST_CAP);
  return { total: usable, scan, truncated: usable > scan };
}

function expandSubnet(cidr) {
  const plan = prefixPlan(cidr);
  if (plan.error || plan.scan <= 0) return { ips: [], ...plan };
  const raw = String(cidr).trim();
  if (!raw.includes('/')) return { ips: [raw], ...plan };
  const prefix = Number(raw.split('/')[1]);
  const skip = prefix <= 30 ? 1 : 0;
  try {
    const ips = new IPCIDR(raw).toArray({ from: skip, limit: plan.scan });
    return { ips, ...plan };
  } catch {
    return { ips: [], ...plan, error: 'invalid prefix' };
  }
}

function credReady(cred) {
  if (!cred || typeof cred !== 'object') return false;
  if ((cred.version || '2c') === '3') return typeof cred.user === 'string' && cred.user.trim() !== '';
  return typeof cred.community === 'string' && cred.community !== '';
}

function credentialList() {
  const saved = (discoveryConfig.credentials || []).filter(credReady);
  if (saved.length) return { creds: saved, fallback: false };
  return {
    creds: [{ id: 'legacy-community', name: 'saved community', version: '2c', community: discoveryConfig.community || 'public' }],
    fallback: true,
  };
}

function credForIp(ip) {
  const { creds } = credentialList();
  const ref = discoveryConfig.deviceCreds?.[ip];
  if (ref) {
    const match = creds.find((cred) => (ref.id && cred.id === ref.id) || (ref.name && cred.name === ref.name));
    if (match) return match;
  }
  return creds[0];
}

function snmpUser(cred) {
  const user = { name: String(cred.user || '').trim() };
  const authKey = typeof cred.authKey === 'string' ? cred.authKey : '';
  const privKey = typeof cred.privKey === 'string' ? cred.privKey : '';
  if (authKey && privKey) {
    user.level = snmp.SecurityLevel.authPriv;
    user.authProtocol = snmp.AuthProtocols.sha;
    user.authKey = authKey;
    user.privProtocol = snmp.PrivProtocols.aes;
    user.privKey = privKey;
  } else if (authKey) {
    user.level = snmp.SecurityLevel.authNoPriv;
    user.authProtocol = snmp.AuthProtocols.sha;
    user.authKey = authKey;
  } else {
    user.level = snmp.SecurityLevel.noAuthNoPriv;
  }
  return user;
}

function credLevel(cred) {
  if ((cred.version || '2c') !== '3') return 'v2c';
  if (cred.authKey && cred.privKey) return 'v3 authPriv SHA/AES';
  if (cred.authKey) return 'v3 authNoPriv SHA';
  return 'v3 noAuthNoPriv';
}

function credLabel(cred) {
  return `${cred.name || cred.id || 'unnamed'} (${credLevel(cred)})`;
}

function openSession(ip, cred, overrides = {}) {
  const version3 = (cred?.version || '2c') === '3';
  const options = {
    port: 161,
    retries: overrides.retries ?? 0,
    timeout: overrides.timeout ?? 1500,
    version: version3 ? snmp.Version3 : snmp.Version2c,
  };
  const session = version3
    ? snmp.createV3Session(ip, snmpUser(cred), options)
    : snmp.createSession(ip, cred?.community || 'public', options);
  session.on('error', () => {});
  return session;
}

function safeError(err) {
  let message = err && err.message ? String(err.message) : 'Discovery failed';
  const secrets = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 3) secrets.push(value);
  };
  push(discoveryConfig.community);
  push(discoveryConfig.netbox && discoveryConfig.netbox.token);
  for (const cred of discoveryConfig.credentials || []) {
    push(cred && cred.community);
    push(cred && cred.authKey);
    push(cred && cred.privKey);
    push(cred && cred.user);
  }
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  return message.slice(0, 300);
}

const discoveryJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  currentSubnet: null,
  currentCredential: null,
  hostsScanned: 0,
  hostsTotal: 0,
  found: 0,
  log: [],
};

function logJob(message, level = 'info') {
  discoveryJob.log.push({ t: new Date().toISOString(), level, message });
  if (discoveryJob.log.length > 400) discoveryJob.log.splice(0, discoveryJob.log.length - 400);
  console.log(`[discovery] ${message}`);
}

function discoveryStatus() {
  return {
    running: discoveryJob.running,
    startedAt: discoveryJob.startedAt,
    finishedAt: discoveryJob.finishedAt,
    error: discoveryJob.error,
    currentSubnet: discoveryJob.currentSubnet,
    currentCredential: discoveryJob.currentCredential,
    hostsScanned: discoveryJob.hostsScanned,
    hostsTotal: discoveryJob.hostsTotal,
    found: discoveryJob.running ? discoveryJob.found : discoveryConfig.results.length,
    lastRun: discoveryConfig.lastRun,
    resultCount: discoveryConfig.results.length,
    log: discoveryJob.log,
  };
}

function probeWithCred(ip, cred, timeoutOverride) {
  const version3 = (cred?.version || '2c') === '3';
  const timeout = timeoutOverride || (version3 ? 1500 : 1000);
  const budget = timeoutOverride ? timeoutOverride + 500 : (version3 ? 4000 : 1600);
  return new Promise((resolve) => {
    let session;
    try {
      session = openSession(ip, cred, { timeout, retries: 0 });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), budget);
    session.on('error', () => finish(null));
    session.get(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.5.0'], (error, varbinds) => {
      if (error || !varbinds || snmp.isVarbindError(varbinds[0])) return finish(null);
      const sysName = varbinds[1] && !snmp.isVarbindError(varbinds[1]) ? String(varbinds[1].value || ip) : ip;
      finish({
        ip,
        sysDescr: String(varbinds[0]?.value || ''),
        sysName,
        method: version3 ? 'snmpv3' : 'snmp',
        credentialId: cred.id || '',
        credentialName: cred.name || cred.id || 'credential',
        version: cred.version || '2c',
      });
    });
  });
}

async function probeSNMP(ip, community, timeout = 1500) {
  return probeWithCred(ip, { id: 'query', name: 'query', version: '2c', community }, timeout);
}

async function probeMany(ips, cred, baseCount) {
  const concurrency = (cred.version || '2c') === '3' ? Math.min(32, PROBE_CONCURRENCY) : PROBE_CONCURRENCY;
  const found = [];
  const missed = [];
  discoveryJob.hostsScanned = 0;
  discoveryJob.hostsTotal = ips.length;
  discoveryJob.currentCredential = credLabel(cred);
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((host) => probeWithCred(host, cred)));
    results.forEach((hit, index) => {
      if (hit) found.push(hit);
      else missed.push(batch[index]);
    });
    discoveryJob.hostsScanned += batch.length;
    discoveryJob.found = baseCount + found.length;
  }
  return { found, missed };
}

async function runDiscovery(subnets) {
  const list = (Array.isArray(subnets) ? subnets : []).map((subnet) => String(subnet).trim()).filter(Boolean);
  try {
    await Promise.resolve();
    const { creds, fallback } = credentialList();
    let planned = 0;
    for (const subnet of list) planned += prefixPlan(subnet).scan || 0;
    logJob(`Scan started. ${list.length} prefix${list.length === 1 ? '' : 'es'}, ${planned.toLocaleString('en-US')} hosts, ${creds.length} credential${creds.length === 1 ? '' : 's'}.`);
    if (fallback) logJob('Credential bank has no usable entries. Using the saved v2c community.');
    else logJob(`Credentials in order: ${creds.map(credLabel).join(', ')}.`);
    const skipped = (discoveryConfig.credentials || []).filter((cred) => cred && !credReady(cred)).length;
    if (!fallback && skipped) logJob(`Skipped ${skipped} credential${skipped === 1 ? '' : 's'} with no community or v3 user.`);
    if (!list.length) {
      logJob('No prefixes to scan.');
      return;
    }

    const all = [];
    const seen = new Set();
    for (const subnet of list) {
      const expanded = expandSubnet(subnet);
      discoveryJob.currentSubnet = subnet;
      discoveryJob.currentCredential = null;
      if (expanded.error) {
        logJob(`${subnet}: ${expanded.error}.`, 'error');
        continue;
      }
      if (!expanded.ips.length) {
        logJob(`${subnet}: no hosts to probe.`);
        continue;
      }
      if (expanded.truncated) {
        logJob(`${subnet} has ${expanded.total.toLocaleString('en-US')} usable hosts. Scanning the first ${expanded.scan.toLocaleString('en-US')}.`);
      }
      let remaining = expanded.ips;
      const answered = [];
      for (const cred of creds) {
        if (!remaining.length) break;
        const pass = await probeMany(remaining, cred, all.length + answered.length);
        answered.push(...pass.found);
        remaining = pass.missed;
      }
      const counts = new Map(creds.map((cred) => [cred.name || cred.id || 'credential', 0]));
      for (const hit of answered) {
        const key = hit.credentialName || 'credential';
        counts.set(key, (counts.get(key) || 0) + 1);
        if (seen.has(hit.ip)) continue;
        seen.add(hit.ip);
        all.push({
          ip: hit.ip,
          sysDescr: hit.sysDescr,
          sysName: hit.sysName,
          method: hit.method,
          subnet,
          discoveredAt: new Date().toISOString(),
          credentialId: hit.credentialId || '',
          credentialName: hit.credentialName || '',
        });
        discoveryConfig.deviceCreds[hit.ip] = {
          id: hit.credentialId || '',
          name: hit.credentialName || '',
          version: hit.version || '2c',
        };
      }
      discoveryJob.found = all.length;
      const bits = [...counts.entries()].map(([name, count]) => `${name} ${count}`).join(', ');
      const scope = expanded.truncated ? `${expanded.ips.length} of ${expanded.total}` : String(expanded.ips.length);
      logJob(`${subnet}: probed ${scope} hosts. ${answered.length} answered (${bits}).`);
    }
    discoveryConfig.results = all;
    discoveryConfig.lastRun = new Date().toISOString();
    logJob(`Scan finished. ${all.length} device${all.length === 1 ? '' : 's'}.`);
  } catch (err) {
    discoveryJob.error = safeError(err);
    logJob(discoveryJob.error, 'error');
  }
}

function startDiscovery(subnets) {
  if (discoveryJob.running) return false;
  const list = (Array.isArray(subnets) ? subnets : []).map((subnet) => String(subnet).trim()).filter(Boolean);
  discoveryJob.running = true;
  discoveryJob.startedAt = new Date().toISOString();
  discoveryJob.finishedAt = null;
  discoveryJob.error = null;
  discoveryJob.log = [];
  discoveryJob.found = 0;
  discoveryJob.hostsScanned = 0;
  discoveryJob.hostsTotal = 0;
  discoveryJob.currentSubnet = list[0] || null;
  discoveryJob.currentCredential = null;
  discoveryConfig.subnets = list;
  runDiscovery(list).finally(() => {
    discoveryJob.running = false;
    discoveryJob.finishedAt = new Date().toISOString();
    discoveryJob.currentSubnet = null;
    discoveryJob.currentCredential = null;
    try { saveConfig(); } catch (err) { console.error('Failed to save discovery config', err.message); }
  });
  return true;
}

// --- Routes ---

app.get('/api/discovery/config', (_req, res) => {
  res.json(discoveryConfig);
});

app.post('/api/discovery/config', (req, res) => {
  const { subnets, community, schedule, netbox, credentials } = req.body || {};
  if (subnets) discoveryConfig.subnets = Array.isArray(subnets) ? subnets : [subnets];
  if (community) discoveryConfig.community = community;
  if (schedule) discoveryConfig.schedule = { ...discoveryConfig.schedule, ...schedule };
  if (netbox) discoveryConfig.netbox = { ...discoveryConfig.netbox, ...netbox };
  if (credentials) discoveryConfig.credentials = credentials;
  saveConfig();
  startScheduler();
  console.log('[config] saved netbox=', !!discoveryConfig.netbox?.url, 'creds=', (discoveryConfig.credentials || []).length);
  res.json(discoveryConfig);
});

app.get('/api/discovery/status', (_req, res) => {
  res.json(discoveryStatus());
});

app.post('/api/discovery/scan', (req, res) => {
  const bodySubnets = req.body && req.body.subnets;
  const subnets = Array.isArray(bodySubnets) && bodySubnets.length ? bodySubnets.map(String) : discoveryConfig.subnets;
  if (!startDiscovery(subnets)) {
    return res.status(409).json({ error: 'Discovery is already running', ...discoveryStatus() });
  }
  res.status(202).json({ started: true, ...discoveryStatus() });
});

app.get('/api/discovery/results', (_req, res) => {
  res.json({
    lastRun: discoveryConfig.lastRun,
    count: discoveryConfig.results.length,
    results: discoveryConfig.results,
  });
});

function sameText(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

async function netboxJson(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const detail = data ? JSON.stringify(data) : text;
    throw new Error(`NetBox ${resp.status}: ${detail.slice(0, 240)}`);
  }
  return data || {};
}

async function netboxList(base, token, firstPath) {
  const rows = [];
  let url = firstPath.startsWith('http') ? firstPath : `${base}${firstPath}`;
  let pages = 0;
  let truncated = false;
  while (url && pages < 40) {
    const data = await netboxJson(url, token);
    rows.push(...(data.results || []));
    url = data.next || '';
    pages += 1;
    if (pages >= 40 && url) truncated = true;
  }
  return { rows, pages, truncated };
}

// Import active prefixes whose role or tag matches. Role matches the NetBox name or slug.
app.post('/api/netbox/import', async (req, res) => {
  if (req.body?.type && req.body.type !== 'prefixes') {
    return res.status(400).json({ error: 'Only prefix import is supported.' });
  }
  const base = String(req.body?.url || discoveryConfig.netbox?.url || '').replace(/\/$/, '');
  const apiToken = req.body?.token || discoveryConfig.netbox?.token;
  if (!base || !apiToken) {
    return res.status(400).json({ error: 'NetBox URL and token required. Save them under Settings first.' });
  }
  const tagInput = String(req.body?.tag ?? discoveryConfig.netbox?.tag ?? '').trim();
  const roleInput = String(req.body?.role ?? discoveryConfig.netbox?.role ?? '').trim();
  if (!tagInput && !roleInput) {
    return res.status(400).json({ error: 'Set a NetBox tag or role before importing prefixes.' });
  }

  try {
    let roleSlug = '';
    let roleName = '';
    if (roleInput) {
      const { rows } = await netboxList(base, apiToken, '/api/ipam/roles/?limit=200');
      const bySlug = rows.find((role) => sameText(role.slug, roleInput));
      const byName = rows.filter((role) => sameText(role.name, roleInput));
      const match = bySlug || (byName.length === 1 ? byName[0] : null);
      if (!match) {
        const choices = rows.map((role) => `${role.name} (${role.slug})`).join(', ');
        return res.status(400).json({ error: `No prefix role matches "${roleInput}". Available: ${choices || 'none'}.` });
      }
      roleSlug = match.slug;
      roleName = match.name || match.slug;
    }

    let tagSlug = '';
    if (tagInput) {
      const { rows } = await netboxList(base, apiToken, `/api/extras/tags/?q=${encodeURIComponent(tagInput)}&limit=50`);
      const match = rows.find((tag) => sameText(tag.slug, tagInput) || sameText(tag.name, tagInput));
      if (!match) return res.status(400).json({ error: `No tag matches "${tagInput}".` });
      tagSlug = match.slug;
    }

    const params = new URLSearchParams();
    if (tagSlug) params.set('tag', tagSlug);
    if (roleSlug) params.set('role', roleSlug);
    params.set('status', 'active');
    params.set('limit', '100');
    const { rows, pages, truncated } = await netboxList(base, apiToken, `/api/ipam/prefixes/?${params}`);

    let plannedHosts = 0;
    let skipped = 0;
    const prefixes = [];
    for (const item of rows) {
      if (!item.prefix) { skipped += 1; continue; }
      const plan = prefixPlan(item.prefix);
      if (plan.error || plan.scan <= 0) { skipped += 1; continue; }
      prefixes.push(item.prefix);
      plannedHosts += plan.scan;
    }

    const before = new Set(discoveryConfig.subnets || []);
    const next = [...(discoveryConfig.subnets || [])];
    let added = 0;
    for (const prefix of prefixes) {
      if (before.has(prefix)) continue;
      before.add(prefix);
      next.push(prefix);
      added += 1;
    }
    discoveryConfig.subnets = next;
    discoveryConfig.netbox = { ...(discoveryConfig.netbox || {}), tag: tagSlug, role: roleSlug };
    saveConfig();

    const label = [roleName ? `${roleName} (${roleSlug})` : '', tagSlug ? `tag ${tagSlug}` : ''].filter(Boolean).join(', ');
    logJob(`Imported ${prefixes.length} active prefixes (${added} new) for ${label}. About ${plannedHosts.toLocaleString('en-US')} hosts.`);
    console.log('[NetBox] imported', prefixes.length, 'added', added, 'role', roleSlug || '-', 'tag', tagSlug || '-');
    res.json({
      count: prefixes.length,
      added,
      skipped,
      plannedHosts,
      subnets: next,
      truncated,
      pages,
      tag: tagSlug,
      role: roleSlug,
      roleName,
    });
  } catch (err) {
    const message = safeError(err);
    console.error('[NetBox] import failed', message);
    res.status(500).json({ error: message });
  }
});

// Simple scheduler
let cronJob = null;
function startScheduler() {
  if (cronJob) cronJob.stop();
  cronJob = null;
  if (discoveryConfig.schedule.enabled && discoveryConfig.schedule.cron) {
    try {
      cronJob = cron.schedule(discoveryConfig.schedule.cron, () => {
        if (!startDiscovery(discoveryConfig.subnets)) {
          console.log('Scheduled discovery skipped; a scan is already running');
        }
      });
    } catch (err) {
      console.error('Invalid discovery cron', err.message);
    }
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

// Background poller for selected interfaces. Uses the credential that discovered each device.
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
  const all = db.prepare('SELECT ip, indexes FROM interface_selections').all();
  for (const row of all) {
    const ip = row.ip;
    const indexes = JSON.parse(row.indexes || '[]');
    if (!indexes.length) continue;
    try {
      const cred = credForIp(ip);
      const session = openSession(ip, cred, { timeout: 2500, retries: 0 });
      const interfaces = await new Promise((resolve) => {
        const list = [];
        const t = setTimeout(() => { try { session.close(); } catch {} resolve(list); }, 6000);
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
      console.error('Poller error for', ip, safeError(e));
    }
  }
  } finally {
    polling = false;
  }
}, 10000);
app.get('/api/devices/:ip', async (req, res) => {
  const ip = req.params.ip;
  const cred = req.query.community
    ? { id: 'query', name: 'query', version: '2c', community: String(req.query.community) }
    : credForIp(ip);

  let session;
  try {
    session = openSession(ip, cred, { timeout: 3000, retries: 0 });
  } catch (err) {
    return res.status(500).json({ error: safeError(err), ip });
  }

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
      res.json({ ip, credential: credLabel(cred), ...sys, interfaces });
    }
  } catch (err) {
    clearTimeout(timeout);
    try { session.close(); } catch {}
    if (!res.headersSent) {
      res.status(502).json({ error: safeError(err) || 'SNMP failed', ip });
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

// Topology core designation
const CORES_FILE = path.join(DATA_DIR, 'cores.json');
function loadCores() {
  try { if (fs.existsSync(CORES_FILE)) return JSON.parse(fs.readFileSync(CORES_FILE, 'utf8')); } catch {}
  return [];
}
function saveCores(list) {
  try { fs.writeFileSync(CORES_FILE, JSON.stringify(list, null, 2)); } catch {}
}
let cores = loadCores();
app.get('/api/topology/cores', (_req, res) => res.json(cores));
app.post('/api/topology/cores', (req, res) => {
  cores = Array.isArray(req.body) ? req.body : [];
  saveCores(cores);
  res.json(cores);
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
