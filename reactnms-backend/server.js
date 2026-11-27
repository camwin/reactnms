import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import snmp from 'net-snmp';
import cron from 'node-cron';
import IPCIDR from 'ip-cidr';
import fs from 'fs';
import path from 'path';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { createDeviceBook, DEFAULT_INTERFACE_IGNORE, interfaceIgnored, pruneIgnoredInterfaces, syncInterfaceSelection, visibleDuringScan } from './lib/discovery-sync.js';
import { bitsPerSecond } from './lib/traffic-rate.js';
import { createAlertStore, registerAlertRoutes } from './lib/alerts.js';
import { buildLinks, CDP_TABLE, LLDP_TABLE, parseCdp, parseLldp, siteName } from './lib/topology.js';
import { createEventStore, interfaceTitle } from './lib/device-events.js';
import { createPollStats } from './lib/poll-stats.js';
import { createSyslogStore, normalizeSyslogConfig, parseSyslog } from './lib/syslog.js';
import { decryptSecret, encryptSecret, loadKey, normalizeServiceAccount, publicServiceAccount } from './lib/secret-box.js';
import { DEVICE_TYPES, deviceTypeFromDescr, normalizeDeviceType, runBackup } from './lib/config-backup.js';
import { createCatalog } from './lib/catalog.js';
import { classifyEvents, interfaceErrorRows } from './lib/device-errors.js';
import { JUNIPER_DOM_COLUMNS, JUNIPER_DOM_TABLE, SENSOR_COLUMNS, SENSOR_TABLE, juniperOptics, pairOptics } from './lib/optics.js';
import { codeChallenge, createAuthStore, normalizeAuth, publicAuth, ssoName, verifyIdToken } from './lib/auth.js';
import { authenticateDirectory } from './lib/ldap-client.js';
import {
  CIDR_ROUTE_COLUMNS,
  CIDR_ROUTE_TABLE,
  ENTITY_COLUMNS,
  ENTITY_TABLE,
  INET_ROUTE_COLUMNS,
  INET_ROUTE_TABLE,
  IP_FORWARDING_OID,
  JUNIPER_LEGACY_VLAN_COLUMNS,
  JUNIPER_LEGACY_VLAN_TABLE,
  JUNIPER_VLAN_COLUMNS,
  JUNIPER_VLAN_TABLE,
  QBRIDGE_VLAN_TABLE,
  ROUTE_COLUMNS,
  ROUTE_TABLE,
  SYS_SERVICES_OID,
  VTP_VLAN_COLUMNS,
  VTP_VLAN_TABLE,
  isRouter,
  parseCidrRoutes,
  parseInetRoutes,
  parseInventory,
  parseJuniperLegacyVlans,
  parseJuniperVlans,
  parseQbridgeVlans,
  parseRoutes,
  parseVtpVlans,
} from './lib/device-mibs.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

let authStore = null;

function authMode() {
  return discoveryConfig.auth?.mode || 'off';
}

function readSessionToken(req) {
  const raw = String(req.headers.cookie || '');
  const match = raw.match(/(?:^|;\s*)reactnms_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function requestIsSecure(req) {
  if (req.secure) return true;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, clear = false) {
  const parts = [
    `reactnms_session=${clear ? '' : encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${clear ? 0 : 43200}`,
  ];
  if (requestIsSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

const PUBLIC_API = new Set([
  'GET /api/health',
  'GET /api/auth/config',
  'GET /api/auth/session',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/auth/sso/start',
  'GET /api/auth/sso/callback',
]);

app.use((req, res, next) => {
  if (authMode() === 'off') return next();
  if (PUBLIC_API.has(`${req.method} ${req.path}`)) return next();
  const user = authStore?.sessionUser(readSessionToken(req));
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  req.user = user;
  next();
});

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
  netbox: { url: '', token: '', tag: '', role: '', region: '' },
  deviceCreds: {},
  topologyDefaultSite: '',
  serviceAccount: { enabled: false, username: '', deviceType: 'cisco_ios', passwordEnc: '', enableEnc: '' },
  backupSchedule: { enabled: false, cron: '0 2 * * *', lastRun: null, lastError: '' },
  syslog: { enabled: false, port: 5514, retainDays: 14, maxRows: 100000 },
  deviceCli: {},
  auth: { mode: 'off', ad: { url: '', domain: '' }, ldap: { url: '', baseDn: '', userFilter: '(uid={{username}})', bindDn: '', bindPasswordEnc: '' }, sso: { issuer: '', clientId: '', clientSecretEnc: '', redirectUri: '' } },
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
if (typeof discoveryConfig.topologyDefaultSite !== 'string') discoveryConfig.topologyDefaultSite = '';
if (!discoveryConfig.deviceCli || typeof discoveryConfig.deviceCli !== 'object') discoveryConfig.deviceCli = {};
if (!Array.isArray(discoveryConfig.credentials)) discoveryConfig.credentials = [];
discoveryConfig.netbox = { url: '', token: '', tag: '', role: '', region: '', ...(discoveryConfig.netbox || {}) };
const plainServiceSecret = !!(discoveryConfig.serviceAccount && (discoveryConfig.serviceAccount.password || discoveryConfig.serviceAccount.enable));
discoveryConfig.serviceAccount = normalizeServiceAccount(
  discoveryConfig.serviceAccount,
  normalizeDeviceType(discoveryConfig.serviceAccount?.deviceType) || 'cisco_ios',
);
discoveryConfig.syslog = normalizeSyslogConfig(discoveryConfig.syslog);
discoveryConfig.auth = normalizeAuth(discoveryConfig.auth);
discoveryConfig.backupSchedule = {
  enabled: !!discoveryConfig.backupSchedule?.enabled,
  cron: String(discoveryConfig.backupSchedule?.cron || '0 2 * * *').trim() || '0 2 * * *',
  lastRun: discoveryConfig.backupSchedule?.lastRun || null,
  lastError: typeof discoveryConfig.backupSchedule?.lastError === 'string' ? discoveryConfig.backupSchedule.lastError : '',
};
if (plainServiceSecret) saveConfig();

function ignorePatterns() {
  return Array.isArray(discoveryConfig.interfaceIgnore) ? discoveryConfig.interfaceIgnore : DEFAULT_INTERFACE_IGNORE;
}

let syslogStatus = 'stopped';
let syslogSocket = null;

function syslogView() {
  return { ...normalizeSyslogConfig(discoveryConfig.syslog), status: syslogStatus };
}

function serviceAccountView() {
  return { ...publicServiceAccount(discoveryConfig.serviceAccount), deviceTypes: DEVICE_TYPES };
}

function publicConfig(extra = {}) {
  const { results, serviceAccount, auth, ...rest } = discoveryConfig;
  return {
    ...rest,
    interfaceIgnore: ignorePatterns(),
    serviceAccount: serviceAccountView(),
    syslog: syslogView(),
    auth: publicAuth(auth),
    ...extra,
  };
}

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
  currentDevice: null,
  log: [],
};

const pollerJob = { currentDevice: null };
const interfaceInflight = new Set();

function deviceLabel(deviceOrIp) {
  if (deviceOrIp && typeof deviceOrIp === 'object') {
    const name = deviceOrIp.sysName && deviceOrIp.sysName !== deviceOrIp.ip ? deviceOrIp.sysName : '';
    return name ? `${name} (${deviceOrIp.ip})` : String(deviceOrIp.ip || '');
  }
  const ip = String(deviceOrIp || '');
  const found = (discoveryConfig.results || []).find((device) => device.ip === ip);
  if (found && found.sysName && found.sysName !== ip) return `${found.sysName} (${ip})`;
  return ip;
}

function refreshDiscoveryDevice() {
  const names = [...interfaceInflight];
  if (!names.length) {
    discoveryJob.currentDevice = null;
    return;
  }
  const shown = names.slice(0, 2).join(', ');
  discoveryJob.currentDevice = names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

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
    currentDevice: discoveryJob.currentDevice,
    pollingDevice: pollerJob.currentDevice,
    log: discoveryJob.log,
  };
}

function snmpText(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/g, '').trim();
  return String(value).replace(/\0+$/g, '').trim();
}

function sessionGet(session, oids, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      session.get(oids, (err, varbinds) => finish(err ? null : varbinds));
    } catch {
      finish(null);
    }
  });
}

function varbindNumber(vb) {
  if (!vb) return null;
  try {
    if (typeof snmp.isVarbindError === 'function' && snmp.isVarbindError(vb)) return null;
  } catch {
    return null;
  }
  const value = Number(vb.value);
  return Number.isFinite(value) ? value : null;
}

function hostnameOf(ip) {
  const found = (discoveryConfig.results || []).find((device) => device.ip === ip);
  return found?.sysName || '';
}

function descrOf(ip) {
  const found = (discoveryConfig.results || []).find((device) => device.ip === ip || (device.addresses || []).includes(ip));
  return found?.sysDescr || '';
}

function chassisFirst(rows) {
  return [...(rows || [])].sort((a, b) => Number(b.classId === 3) - Number(a.classId === 3));
}

function cliTypeFor(ip) {
  return normalizeDeviceType(discoveryConfig.deviceCli?.[ip]) || deviceTypeFromDescr(descrOf(ip));
}

const IF_TABLE = '1.3.6.1.2.1.2.2';
const IF_ALIAS = '1.3.6.1.2.1.31.1.1.1.18';

function sessionTableColumns(session, oid, columns, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (table) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(table);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      session.tableColumns(oid, columns, 20, (error, table) => finish(error ? null : table || {}));
    } catch {
      finish(null);
    }
  });
}

function sessionAliasMap(session, timeoutMs) {
  return new Promise((resolve) => {
    const map = {};
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, map });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      session.subtree(IF_ALIAS, 20, (varbinds) => {
        for (const vb of varbinds || []) {
          if (!vb || snmp.isVarbindError(vb) || !vb.oid) continue;
          const oid = String(vb.oid);
          const prefix = `${IF_ALIAS}.`;
          if (!oid.startsWith(prefix)) continue;
          map[oid.slice(prefix.length)] = snmpText(vb.value);
        }
      }, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

async function readInterfaces(session, timeoutMs = 8000) {
  const table = await sessionTableColumns(session, IF_TABLE, [2, 3, 5, 7, 8, 10, 16], timeoutMs);
  if (!table) return { interfaces: [], aliasOk: false };
  const interfaces = Object.entries(table).map(([idx, row]) => ({
    index: String(idx),
    name: snmpText(row[2]),
    type: Number(row[3] || 0),
    speed: Number(row[5] || 0),
    adminStatus: Number(row[7] || 0),
    operStatus: Number(row[8] || 0),
    inOctets: Number(row[10] || 0),
    outOctets: Number(row[16] || 0),
    alias: '',
  }));
  if (!interfaces.length) return { interfaces: [], aliasOk: false };
  const alias = await sessionAliasMap(session, timeoutMs);
  if (alias.ok) {
    for (const iface of interfaces) iface.alias = alias.map[iface.index] || '';
  }
  return { interfaces, aliasOk: alias.ok };
}

async function mapPool(items, limit, worker) {
  const queue = [...items];
  if (!queue.length) return;
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
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
    session.get(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.6.0'], (error, varbinds) => {
      if (error || !varbinds || snmp.isVarbindError(varbinds[0])) return finish(null);
      const sysName = varbinds[1] && !snmp.isVarbindError(varbinds[1]) ? snmpText(varbinds[1].value) || ip : ip;
      const sysLocation = varbinds[2] && !snmp.isVarbindError(varbinds[2]) ? snmpText(varbinds[2].value) : '';
      finish({
        ip,
        sysDescr: snmpText(varbinds[0]?.value),
        sysName,
        sysLocation,
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

async function probeMany(ips, cred, onBatch) {
  const concurrency = (cred.version || '2c') === '3' ? Math.min(32, PROBE_CONCURRENCY) : PROBE_CONCURRENCY;
  const found = [];
  const missed = [];
  discoveryJob.hostsScanned = 0;
  discoveryJob.hostsTotal = ips.length;
  discoveryJob.currentCredential = credLabel(cred);
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((host) => probeWithCred(host, cred)));
    const hits = [];
    results.forEach((hit, index) => {
      if (hit) {
        found.push(hit);
        hits.push(hit);
      } else missed.push(batch[index]);
    });
    discoveryJob.hostsScanned += batch.length;
    if (onBatch) onBatch(hits);
  }
  return { found, missed };
}

async function runDiscovery(subnets) {
  const list = (Array.isArray(subnets) ? subnets : []).map((subnet) => String(subnet).trim()).filter(Boolean);
  const previousResults = (discoveryConfig.results || []).map((device) => ({ ...device }));
  const book = createDeviceBook(previousResults);
  const synced = new Set();
  const queueSync = [];
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

    const rememberCred = (hit) => {
      discoveryConfig.deviceCreds[hit.ip] = {
        id: hit.credentialId || '',
        name: hit.credentialName || '',
        version: hit.version || '2c',
      };
    };
    const publish = (final = false) => {
      const found = book.devices();
      discoveryConfig.results = final ? found : visibleDuringScan(found, previousResults);
      discoveryJob.found = found.length;
      saveConfig();
    };
    const takeHit = (hit, subnet) => {
      const event = book.add({
        ip: hit.ip,
        sysDescr: hit.sysDescr || '',
        sysName: hit.sysName || hit.ip,
        sysLocation: hit.sysLocation || '',
        method: hit.method,
        subnet,
        discoveredAt: new Date().toISOString(),
        credentialId: hit.credentialId || '',
        credentialName: hit.credentialName || '',
        version: hit.version || '2c',
      });
      if (event.type === 'added') {
        rememberCred(hit);
        if (!synced.has(event.device.ip)) {
          synced.add(event.device.ip);
          queueSync.push(event.device);
        }
        return 'added';
      }
      if (event.type === 'duplicate') return 'duplicate';
      return 'deferred';
    };

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
      let answered = 0;
      let duplicates = 0;
      let deferred = 0;
      for (const cred of creds) {
        if (!remaining.length) break;
        const pass = await probeMany(remaining, cred, (hits) => {
          for (const hit of hits) {
            const kind = takeHit(hit, subnet);
            if (kind === 'duplicate') duplicates += 1;
            if (kind === 'deferred') deferred += 1;
          }
          publish();
        });
        answered += pass.found.length;
        remaining = pass.missed;
      }
      const scope = expanded.truncated ? `${expanded.ips.length} of ${expanded.total}` : String(expanded.ips.length);
      const extra = [
        duplicates ? `${duplicates} duplicate gateway${duplicates === 1 ? '' : 's'} skipped` : '',
        deferred ? `${deferred} extra gateway${deferred === 1 ? '' : 's'} held for the tracked address` : '',
      ].filter(Boolean).join(', ');
      logJob(`${subnet}: probed ${scope} hosts. ${answered} answered${extra ? ` (${extra})` : ''}. ${book.devices().length} devices.`);
      if (queueSync.length) {
        const batch = queueSync.splice(0, queueSync.length);
        await mapPool(batch, 4, syncDiscoveredDevice);
        publish();
      }
    }

    const promotions = book.finish();
    for (const event of promotions) {
      if (event.fromIp) migrateDeviceData(event.fromIp, event.device.ip);
      logJob(event.fromIp
        ? `${deviceLabel(event.device)}: ${event.fromIp} did not answer. Tracking ${event.device.ip} instead.`
        : `${deviceLabel(event.device)}: tracking this gateway.`);
      rememberCred(event.device);
      if (!synced.has(event.device.ip)) {
        synced.add(event.device.ip);
        queueSync.push(event.device);
      }
    }
    if (queueSync.length) {
      const batch = queueSync.splice(0, queueSync.length);
      await mapPool(batch, 4, syncDiscoveredDevice);
    }
    dropDuplicateGatewaySelections(book.devices());
    publish(true);
    discoveryConfig.lastRun = new Date().toISOString();
    saveConfig();
    logJob(`Scan finished. ${book.devices().length} device${book.devices().length === 1 ? '' : 's'}.`);
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
  discoveryJob.currentDevice = null;
  discoveryConfig.subnets = list;
  runDiscovery(list).finally(() => {
    discoveryJob.running = false;
    discoveryJob.finishedAt = new Date().toISOString();
    discoveryJob.currentSubnet = null;
    discoveryJob.currentCredential = null;
    discoveryJob.currentDevice = null;
    interfaceInflight.clear();
    try { saveConfig(); } catch (err) { console.error('Failed to save discovery config', err.message); }
  });
  return true;
}

// --- Routes ---

app.get('/api/discovery/config', (_req, res) => {
  res.json(publicConfig());
});

app.post('/api/discovery/config', (req, res) => {
  const body = req.body || {};
  const { subnets, community, schedule, netbox, credentials } = body;
  if (subnets) discoveryConfig.subnets = Array.isArray(subnets) ? subnets : [subnets];
  if (community) discoveryConfig.community = community;
  if (schedule) discoveryConfig.schedule = { ...discoveryConfig.schedule, ...schedule };
  if (netbox) discoveryConfig.netbox = { ...discoveryConfig.netbox, ...netbox };
  if (credentials) discoveryConfig.credentials = credentials;
  let ignoredRemoved = 0;
  if (Array.isArray(body.interfaceIgnore)) {
    discoveryConfig.interfaceIgnore = body.interfaceIgnore.map((item) => String(item).trim()).filter(Boolean);
    ignoredRemoved = applyIgnoreToStored(discoveryConfig.interfaceIgnore);
  }
  saveConfig();
  startScheduler();
  console.log('[config] saved netbox=', !!discoveryConfig.netbox?.url, 'creds=', (discoveryConfig.credentials || []).length);
  res.json(publicConfig({ ignoredRemoved }));
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
  const regionInput = String(req.body?.region ?? discoveryConfig.netbox?.region ?? '').trim();
  if (!tagInput && !roleInput && !regionInput) {
    return res.status(400).json({ error: 'Set a NetBox region, tag, or role before importing prefixes.' });
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

    let regionSlug = '';
    let regionName = '';
    if (regionInput) {
      const { rows } = await netboxList(base, apiToken, '/api/dcim/regions/?limit=100');
      const bySlug = rows.find((region) => sameText(region.slug, regionInput));
      const byName = rows.filter((region) => sameText(region.name, regionInput));
      const match = bySlug || (byName.length === 1 ? byName[0] : null);
      if (!match) {
        const choices = rows.map((region) => `${region.name} (${region.slug})`).join(', ');
        return res.status(400).json({ error: `No region matches "${regionInput}". Available: ${choices || 'none'}.` });
      }
      regionSlug = match.slug;
      regionName = match.name || match.slug;
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
    if (regionSlug) params.set('region', regionSlug);
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
    discoveryConfig.netbox = { ...(discoveryConfig.netbox || {}), tag: tagSlug, role: roleSlug, region: regionSlug };
    saveConfig();

    const label = [
      regionName ? `${regionName} (${regionSlug})` : '',
      roleName ? `${roleName} (${roleSlug})` : '',
      tagSlug ? `tag ${tagSlug}` : '',
    ].filter(Boolean).join(', ');
    logJob(`Imported ${prefixes.length} active prefixes (${added} new) for ${label}. About ${plannedHosts.toLocaleString('en-US')} hosts.`);
    console.log('[NetBox] imported', prefixes.length, 'added', added, 'region', regionSlug || '-', 'role', roleSlug || '-', 'tag', tagSlug || '-');
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
      region: regionSlug,
      regionName,
    });
  } catch (err) {
    const message = safeError(err);
    console.error('[NetBox] import failed', message);
    res.status(500).json({ error: message });
  }
});

app.post('/api/netbox/options', async (req, res) => {
  const base = String(req.body?.url || discoveryConfig.netbox?.url || '').replace(/\/$/, '');
  const apiToken = req.body?.token || discoveryConfig.netbox?.token;
  if (!base || !apiToken) {
    return res.status(400).json({ error: 'NetBox URL and token required. Save them under Settings first.' });
  }
  try {
    const [regions, roles, tags] = await Promise.all([
      netboxList(base, apiToken, '/api/dcim/regions/?limit=100'),
      netboxList(base, apiToken, '/api/ipam/roles/?limit=100'),
      netboxList(base, apiToken, '/api/extras/tags/?limit=100'),
    ]);
    const choice = (row) => ({ id: row.id, name: row.name || row.slug || '', slug: row.slug || '' });
    const sortChoices = (rows) => rows.map(choice).filter((row) => row.slug).sort((a, b) => a.name.localeCompare(b.name));
    res.json({
      regions: sortChoices(regions.rows),
      roles: sortChoices(roles.rows),
      tags: sortChoices(tags.rows),
    });
  } catch (err) {
    res.status(502).json({ error: safeError(err) });
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

const alertStore = createAlertStore(db);
const eventStore = createEventStore(db);
const pollStats = createPollStats(db);
const syslogStore = createSyslogStore(db);
const catalog = createCatalog(db);
authStore = createAuthStore(db);
const secretKey = loadKey(path.join(DATA_DIR, 'service.key'));
db.exec(`
  CREATE TABLE IF NOT EXISTS device_config (
    ip TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    device_type TEXT NOT NULL,
    error TEXT NOT NULL
  );
`);

function getSelections(ip) {
  const row = db.prepare('SELECT indexes FROM interface_selections WHERE ip = ?').get(ip);
  return row ? JSON.parse(row.indexes) : [];
}
function setSelections(ip, indexes) {
  db.prepare('INSERT OR REPLACE INTO interface_selections (ip, indexes) VALUES (?, ?)').run(ip, JSON.stringify(indexes));
}

function applyIgnoreToStored(patterns) {
  let rows = [];
  try {
    rows = db.prepare('SELECT ip, if_index AS "index", name FROM interfaces').all();
  } catch {
    return 0;
  }
  const drop = pruneIgnoredInterfaces(rows, patterns);
  const byIp = new Map();
  for (const row of drop) {
    const list = byIp.get(row.ip) || [];
    list.push(String(row.index));
    byIp.set(row.ip, list);
  }
  const tx = db.transaction(() => {
    for (const [ip, indexes] of byIp) {
      const selected = getSelections(ip).map(String).filter((index) => !indexes.includes(index));
      setSelections(ip, selected);
      db.prepare(`DELETE FROM interfaces WHERE ip = ? AND if_index IN (${indexes.map(() => '?').join(',')})`).run(ip, ...indexes);
    }
  });
  if (byIp.size) tx();
  return drop.length;
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

function credentialChoices() {
  return credentialList().creds.map((cred) => ({
    id: cred.id || cred.name || '',
    name: cred.name || cred.id || 'credential',
    version: cred.version || '2c',
  })).filter((cred) => cred.id);
}

app.get('/api/devices/:ip/settings', (req, res) => {
  const ip = req.params.ip;
  const ref = discoveryConfig.deviceCreds?.[ip] || {};
  res.json({
    credentialId: ref.id || '',
    credentialName: ref.name || '',
    credentials: credentialChoices(),
    poll: pollStats.device(ip),
    deviceType: normalizeDeviceType(discoveryConfig.deviceCli?.[ip]) || '',
    detectedType: deviceTypeFromDescr(descrOf(ip)),
    deviceTypes: DEVICE_TYPES,
  });
});

app.post('/api/devices/:ip/cli', (req, res) => {
  const raw = String(req.body?.deviceType || '').trim();
  if (!raw || raw === 'auto') {
    delete discoveryConfig.deviceCli[req.params.ip];
    saveConfig();
    return res.json({ ok: true, deviceType: '', detectedType: deviceTypeFromDescr(descrOf(req.params.ip)) });
  }
  const type = normalizeDeviceType(raw);
  if (!type) return res.status(400).json({ error: 'Choose a Netmiko device type' });
  discoveryConfig.deviceCli[req.params.ip] = type;
  saveConfig();
  res.json({ ok: true, deviceType: type, detectedType: deviceTypeFromDescr(descrOf(req.params.ip)) });
});

app.post('/api/devices/:ip/credential', (req, res) => {
  const ip = req.params.ip;
  const id = String(req.body?.credentialId || '').trim();
  if (!id) {
    delete discoveryConfig.deviceCreds[ip];
    saveConfig();
    return res.json({ ok: true, credentialId: '' });
  }
  const cred = credentialList().creds.find((item) => item.id === id);
  if (!cred) return res.status(400).json({ error: 'Unknown credential' });
  discoveryConfig.deviceCreds[ip] = { id: cred.id, name: cred.name || cred.id, version: cred.version || '2c' };
  saveConfig();
  res.json({ ok: true, credentialId: cred.id, credentialName: cred.name || cred.id });
});

const discoverInflight = new Set();

app.post('/api/devices/:ip/discover', async (req, res) => {
  const ip = req.params.ip;
  if (discoverInflight.has(ip)) return res.status(409).json({ error: 'Discovery is already running for this device' });
  discoverInflight.add(ip);
  try {
    const known = (discoveryConfig.results || []).find((device) => device.ip === ip) || null;
    const cred = credForIp(ip);
    const hit = await probeWithCred(ip, cred, 4000);
    if (!hit) return res.status(502).json({ error: 'SNMP timeout or unreachable', ip });
    const next = {
      ...(known || { ip, addresses: [ip], subnet: '' }),
      ip,
      sysDescr: hit.sysDescr || known?.sysDescr || '',
      sysName: hit.sysName || known?.sysName || ip,
      sysLocation: hit.sysLocation ?? known?.sysLocation ?? '',
      method: hit.method,
      discoveredAt: new Date().toISOString(),
      credentialId: hit.credentialId || known?.credentialId || '',
      credentialName: hit.credentialName || known?.credentialName || '',
      version: hit.version || known?.version || '2c',
    };
    if (!Array.isArray(next.addresses) || !next.addresses.length) next.addresses = [ip];
    const results = discoveryConfig.results || [];
    discoveryConfig.results = known ? results.map((device) => (device.ip === ip ? next : device)) : [...results, next];
    discoveryConfig.deviceCreds[ip] = {
      id: next.credentialId,
      name: next.credentialName,
      version: next.version,
    };
    saveConfig();
    await syncDiscoveredDevice(next);
    refreshDeviceSnapshot();
    res.json({ ok: true, sysName: next.sysName, sysLocation: next.sysLocation, discoveredAt: next.discoveredAt });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: safeError(err) });
  } finally {
    discoverInflight.delete(ip);
  }
});

function purgeDeviceAddress(ip) {
  for (const sql of [
    'DELETE FROM interface_selections WHERE ip = ?',
    'DELETE FROM interface_descriptions WHERE ip = ?',
    'DELETE FROM traffic_raw WHERE ip = ?',
    'DELETE FROM traffic_1m WHERE ip = ?',
    'DELETE FROM devices WHERE ip = ?',
    'DELETE FROM interfaces WHERE ip = ?',
    'DELETE FROM active_alerts WHERE device_ip = ?',
    'DELETE FROM device_config WHERE ip = ?',
  ]) db.prepare(sql).run(ip);
  eventStore.forgetDevice(ip);
  pollStats.forget(ip);
}

app.delete('/api/devices/:ip', (req, res) => {
  const ip = req.params.ip;
  const results = discoveryConfig.results || [];
  const device = results.find((item) => item.ip === ip);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  const addresses = new Set([ip, ...(device.addresses || [])].filter(Boolean));
  discoveryConfig.results = results.filter((item) => item.ip !== ip);
  for (const address of addresses) {
    delete discoveryConfig.deviceCreds[address];
    delete discoveryConfig.deviceCli[address];
  }
  saveConfig();
  for (const address of addresses) purgeDeviceAddress(address);
  for (const rule of alertStore.listRules()) {
    const devices = (rule.scope?.devices || []).filter((item) => !addresses.has(item));
    if (devices.length !== (rule.scope?.devices || []).length) {
      alertStore.saveRule({ ...rule, scope: { ...rule.scope, devices } });
    }
  }
  for (const group of alertStore.listGroups()) {
    const members = (group.members || []).filter((item) => !addresses.has(item));
    if (members.length !== (group.members || []).length) alertStore.saveGroup({ ...group, members });
  }
  topologyCache.links = (topologyCache.links || []).filter((link) => !addresses.has(link.a) && !addresses.has(link.b));
  try { fs.writeFileSync(TOPOLOGY_FILE, JSON.stringify(topologyCache)); } catch { /* cache is also in memory */ }
  res.json({ ok: true });
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

function writeAliases(ip, interfaces) {
  const stmt = db.prepare('INSERT OR REPLACE INTO interface_descriptions (ip, if_index, description) VALUES (?, ?, ?)');
  const tx = db.transaction((rows) => {
    for (const iface of rows) stmt.run(ip, String(iface.index), iface.alias || '');
  });
  tx(interfaces);
}

function migrateDeviceData(from, to) {
  if (!from || !to || from === to) return;
  const fromSel = getSelections(from).map(String);
  const toSel = getSelections(to).map(String);
  if (fromSel.length) {
    setSelections(to, [...new Set([...toSel, ...fromSel])]);
    db.prepare('DELETE FROM interface_selections WHERE ip = ?').run(from);
  }
  const descRows = db.prepare('SELECT if_index, description FROM interface_descriptions WHERE ip = ?').all(from);
  for (const row of descRows) {
    const exists = db.prepare('SELECT 1 AS ok FROM interface_descriptions WHERE ip = ? AND if_index = ?').get(to, row.if_index);
    if (!exists) setDescription(to, row.if_index, row.description);
  }
  db.prepare('DELETE FROM interface_descriptions WHERE ip = ?').run(from);
  const rawCount = db.prepare('SELECT COUNT(*) AS c FROM traffic_raw WHERE ip = ?').get(to)?.c || 0;
  if (!rawCount) db.prepare('UPDATE traffic_raw SET ip = ? WHERE ip = ?').run(to, from);
  const rollCount = db.prepare('SELECT COUNT(*) AS c FROM traffic_1m WHERE ip = ?').get(to)?.c || 0;
  if (!rollCount) db.prepare('UPDATE traffic_1m SET ip = ? WHERE ip = ?').run(to, from);
  if (discoveryConfig.deviceCreds?.[from]) {
    if (!discoveryConfig.deviceCreds[to]) discoveryConfig.deviceCreds[to] = discoveryConfig.deviceCreds[from];
    delete discoveryConfig.deviceCreds[from];
  }
}

function dropDuplicateGatewaySelections(devices) {
  const canonical = new Set(devices.map((device) => device.ip));
  for (const device of devices) {
    for (const address of device.addresses || []) {
      if (!address || address === device.ip || canonical.has(address)) continue;
      db.prepare('DELETE FROM interface_selections WHERE ip = ?').run(address);
    }
  }
}

async function syncDiscoveredDevice(device) {
  const label = deviceLabel(device);
  interfaceInflight.add(label);
  refreshDiscoveryDevice();
  let session;
  try {
    session = openSession(device.ip, credForIp(device.ip), { timeout: 2500, retries: 0 });
    const result = await readInterfaces(session, 8000);
    if (!result.interfaces.length) {
      logJob(`${device.ip}: no interfaces returned. Selections unchanged.`);
      return;
    }
    const summary = syncInterfaceSelection(getSelections(device.ip), result.interfaces, ignorePatterns());
    if (summary.changed) setSelections(device.ip, summary.indexes);
    if (result.aliasOk) writeAliases(device.ip, result.interfaces);
    logJob(`${label}: tracking ${summary.indexes.length} interfaces (${summary.added} up added, ${summary.removed} removed).`);
  } catch (err) {
    logJob(`${device.ip}: interface poll failed (${safeError(err)}).`, 'error');
  } finally {
    try { session?.close(); } catch { /* already closed */ }
    interfaceInflight.delete(label);
    refreshDiscoveryDevice();
  }
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

function rememberInterfaces(ip, interfaces) {
  const previous = db.prepare('SELECT t, in_octets, out_octets FROM traffic_raw WHERE ip = ? AND if_index = ? ORDER BY t DESC LIMIT 1');
  const aliases = getDescriptions(ip);
  const patterns = ignorePatterns();
  const now = Date.now();
  eventStore.noteInterfaces(ip, (interfaces || []).map((iface) => ({
    index: String(iface.index),
    name: iface.name || '',
    alias: aliases[String(iface.index)] || '',
    adminStatus: iface.adminStatus,
    operStatus: iface.operStatus,
  })));
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO interfaces (
      ip, if_index, name, alias, admin_status, oper_status, in_bps, out_bps, speed, ignored
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    const seen = [];
    for (const iface of rows) {
      const index = String(iface.index);
      seen.push(index);
      const prior = previous.get(ip, index);
      const rate = bitsPerSecond(prior, { t: now, inOctets: iface.inOctets, outOctets: iface.outOctets });
      upsert.run(
        ip,
        index,
        iface.name || '',
        aliases[index] || '',
        iface.adminStatus,
        iface.operStatus,
        rate.inBps,
        rate.outBps,
        iface.speed || 0,
        interfaceIgnored(iface.name, patterns) ? 1 : 0,
      );
    }
    if (seen.length) {
      db.prepare(`DELETE FROM interfaces WHERE ip = ? AND if_index NOT IN (${seen.map(() => '?').join(',')})`).run(ip, ...seen);
    } else {
      db.prepare('DELETE FROM interfaces WHERE ip = ?').run(ip);
    }
  });
  tx(interfaces);
}

function refreshDeviceSnapshot() {
  const previous = new Map(db.prepare('SELECT ip, hostname, location, icmp_up, icmp_at, icmp_error FROM devices').all().map((row) => [row.ip, row]));
  const current = discoveryConfig.results || [];
  const keep = new Set(current.map((device) => device.ip));
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO devices (ip, hostname, sys_descr, location, icmp_up, icmp_at, icmp_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const removeDevice = db.prepare('DELETE FROM devices WHERE ip = ?');
  const removeInterfaces = db.prepare('DELETE FROM interfaces WHERE ip = ?');
  for (const device of current) {
    const prior = previous.get(device.ip);
    if (!prior) continue;
    eventStore.noteIdentity(
      device.ip,
      { hostname: prior.hostname, location: prior.location },
      { sysName: device.sysName, sysLocation: device.sysLocation },
      device.sysName || prior.hostname || '',
    );
  }
  const tx = db.transaction(() => {
    for (const device of current) {
      const prior = previous.get(device.ip);
      upsert.run(
        device.ip,
        device.sysName || device.ip,
        String(device.sysDescr || '').split('\n')[0],
        String(device.sysLocation || '').trim(),
        prior ? prior.icmp_up : null,
        prior ? prior.icmp_at : null,
        prior ? prior.icmp_error : null,
      );
    }
    for (const ip of previous.keys()) {
      if (keep.has(ip)) continue;
      removeDevice.run(ip);
      removeInterfaces.run(ip);
    }
  });
  tx();
}

function pingHost(ip) {
  return new Promise((resolve) => {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(ip || ''))) {
      resolve({ up: null, error: 'not an IPv4 address' });
      return;
    }
    execFile('ping', ['-c', '1', '-W', '3', String(ip)], { timeout: 8000 }, (err) => {
      if (err && err.code === 'ENOENT') {
        resolve({ up: null, error: 'ping is not installed' });
        return;
      }
      resolve({ up: err ? 0 : 1, error: err ? 'no reply' : '' });
    });
  });
}

async function refreshIcmp() {
  const due = db.prepare('SELECT ip, icmp_at FROM devices').all()
    .filter((row) => !row.icmp_at || Date.now() - row.icmp_at > 45000);
  if (!due.length) return;
  const priorStmt = db.prepare('SELECT icmp_up, icmp_at FROM devices WHERE ip = ?');
  const update = db.prepare('UPDATE devices SET icmp_up = ?, icmp_at = ?, icmp_error = ? WHERE ip = ?');
  await mapPool(due, 16, async (row) => {
    const previous = priorStmt.get(row.ip);
    const result = await pingHost(row.ip);
    update.run(result.up, Date.now(), result.error || '', row.ip);
    const device = (discoveryConfig.results || []).find((item) => item.ip === row.ip);
    eventStore.noteReachability(row.ip, previous, { icmp_up: result.up }, device?.sysName || '');
  });
}

// Background poller for selected interfaces. Uses the credential that discovered each device.
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  const cycleStarted = Date.now();
  try {
  const all = db.prepare('SELECT ip, indexes FROM interface_selections').all();
  for (const row of all) {
    const ip = row.ip;
    const indexes = JSON.parse(row.indexes || '[]');
    if (!indexes.length) continue;
    const started = Date.now();
    pollerJob.currentDevice = deviceLabel(ip);
    try {
      const cred = credForIp(ip);
      const session = openSession(ip, cred, { timeout: 2500, retries: 0 });
      const read = await new Promise((resolve) => {
        const list = [];
        const t = setTimeout(() => { try { session.close(); } catch {} resolve({ ok: false, list }); }, 6000);
        session.tableColumns('1.3.6.1.2.1.2.2', [2, 5, 7, 8, 10, 16], 20, (error, table) => {
          clearTimeout(t);
          try { session.close(); } catch {}
          if (error || !table) return resolve({ ok: false, list: [] });
          Object.entries(table).forEach(([idx, r]) => {
            if (!indexes.includes(String(idx))) return;
            list.push({
              index: String(idx),
              name: snmpText(r[2]),
              speed: Number(r[5] || 0),
              adminStatus: Number(r[7] || 0),
              operStatus: Number(r[8] || 0),
              inOctets: Number(r[10] || 0),
              outOctets: Number(r[16] || 0),
            });
          });
          resolve({ ok: true, list });
        });
      });
      if (read.ok) {
        rememberInterfaces(ip, read.list);
        if (read.list.length) recordTraffic(ip, read.list);
      }
    } catch (e) {
      console.error('Poller error for', ip, safeError(e));
    } finally {
      pollStats.recordDevice(ip, hostnameOf(ip), Date.now() - started);
      pollerJob.currentDevice = null;
    }
  }
  try {
    refreshDeviceSnapshot();
    await refreshIcmp();
    await sampleDueObservations();
    await alertStore.evaluate();
  } catch (err) {
    console.error('Alert evaluation failed', err.message);
  }
  } finally {
    pollStats.recordCycle(Date.now() - cycleStarted);
    polling = false;
    pollerJob.currentDevice = null;
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
  }, 20000);

  try {
    const sys = await new Promise((resolve, reject) => {
      session.get(oids, (err, varbinds) => {
        if (err) return reject(err);
        resolve({
          sysDescr: snmpText(varbinds[0]?.value),
          sysName: snmpText(varbinds[1]?.value) || ip,
          sysLocation: snmpText(varbinds[2]?.value),
          sysUpTime: Number(varbinds[3]?.value || 0),
          sysContact: snmpText(varbinds[4]?.value),
        });
      });
    });

    const extra = await sessionGet(session, [SYS_SERVICES_OID, IP_FORWARDING_OID], 2000);
    const router = isRouter(varbindNumber(extra?.[1]), varbindNumber(extra?.[0]));
    const read = await readInterfaces(session, 8000);
    const interfaces = read.interfaces;
    clearTimeout(timeout);
    try { session.close(); } catch {}
    recordTraffic(ip, interfaces);
    const stored = read.aliasOk ? {} : getDescriptions(ip);
    if (read.aliasOk) writeAliases(ip, interfaces);
    interfaces.forEach((iface) => {
      if (!read.aliasOk) iface.alias = stored[String(iface.index)] || '';
      iface.customDesc = iface.alias || '';
      iface.ignored = interfaceIgnored(iface.name, ignorePatterns());
    });
    const known = (discoveryConfig.results || []).find((device) => device.ip === ip);
    if (!res.headersSent) {
      res.json({
        ip,
        credential: credLabel(cred),
        discoveredAt: known?.discoveredAt || null,
        addresses: known?.addresses || [ip],
        aliasKnown: read.aliasOk,
        router,
        configEnabled: !!discoveryConfig.serviceAccount?.enabled,
        serials: catalog.serialsFor(ip).map((row) => row.serial).filter(Boolean).join(', '),
        ...sys,
        interfaces,
      });
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

const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
function loadAlerts() {
  try {
    if (fs.existsSync(ALERTS_FILE)) return JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'));
  } catch { /* start with no legacy rules */ }
  return [];
}
if (!alertStore.listRules().length) {
  const legacy = loadAlerts();
  if (Array.isArray(legacy) && legacy.length) alertStore.migrateLegacy(legacy);
}
registerAlertRoutes(app, alertStore, { devices: () => discoveryConfig.results || [] });

const TOPOLOGY_FILE = path.join(DATA_DIR, 'topology.json');
function loadTopology() {
  try {
    if (fs.existsSync(TOPOLOGY_FILE)) return JSON.parse(fs.readFileSync(TOPOLOGY_FILE, 'utf8'));
  } catch { /* start with an empty map */ }
  return { updatedAt: null, links: [] };
}
let topologyCache = loadTopology();
const topologyJob = { running: false, scanned: 0, total: 0, error: null };

function sessionTableResult(session, oid, columns, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, table: null }), timeoutMs);
    try {
      session.tableColumns(oid, columns, 20, (error, table) => {
        finish(error ? { ok: false, table: null } : { ok: true, table: table || {} });
      });
    } catch {
      finish({ ok: false, table: null });
    }
  });
}

async function readNeighbors(device, timeoutMs = 6000) {
  const report = { ip: device.ip, cdp: [], lldp: [], cdpOk: false, lldpOk: false };
  let session;
  try {
    session = openSession(device.ip, credForIp(device.ip), { timeout: Math.min(2000, timeoutMs), retries: 0 });
    const cdp = await sessionTableResult(session, CDP_TABLE, [4, 6, 7], timeoutMs);
    report.cdpOk = cdp.ok;
    if (cdp.ok) {
      report.cdp = parseCdp(cdp.table);
      if (!report.cdp.length) {
        const lldp = await sessionTableResult(session, LLDP_TABLE, [7, 9], timeoutMs);
        report.lldpOk = lldp.ok;
        if (lldp.ok) report.lldp = parseLldp(lldp.table);
      }
    }
  } catch (err) {
    console.error('Topology poll failed', device.ip, safeError(err));
  } finally {
    try { session?.close(); } catch { /* already closed */ }
  }
  return report;
}

const STP_STATE_TABLE = '1.3.6.1.2.1.17.2.15';
const STP_PORT_TABLE = '1.3.6.1.2.1.17.1.4';

function eventHostname(ip) {
  const device = (discoveryConfig.results || []).find((item) => item.ip === ip);
  return device?.sysName || '';
}

async function sampleStp(ip) {
  let session;
  try {
    session = openSession(ip, credForIp(ip), { timeout: 1500, retries: 0 });
    const states = await sessionTableResult(session, STP_STATE_TABLE, [3], 2000);
    if (!states.ok) {
      eventStore.touch(ip, 'stp');
      return;
    }
    const mapped = await sessionTableResult(session, STP_PORT_TABLE, [2], 1500);
    const ifByPort = new Map();
    if (mapped.ok) {
      for (const [port, row] of Object.entries(mapped.table || {})) {
        const value = row[2] ?? row['2'];
        if (value != null && value !== '') ifByPort.set(String(port), String(value));
      }
    }
    const names = new Map();
    try {
      for (const row of db.prepare('SELECT if_index, name, alias FROM interfaces WHERE ip = ?').all(ip)) {
        names.set(String(row.if_index), interfaceTitle(row.name, row.alias) || `if ${row.if_index}`);
      }
    } catch { /* no interface snapshot yet */ }
    const ports = Object.entries(states.table || {}).map(([port, row]) => {
      const ifIndex = ifByPort.get(String(port)) || '';
      return {
        bridgePort: String(port),
        ifIndex,
        name: names.get(ifIndex) || (ifIndex ? `if ${ifIndex}` : `bridge port ${port}`),
        state: Number(row[3] ?? row['3'] ?? 0),
      };
    });
    eventStore.noteStp(ip, ports, eventHostname(ip));
  } catch (err) {
    console.error('STP poll failed', ip, safeError(err));
    eventStore.touch(ip, 'stp');
  } finally {
    try { session?.close(); } catch { /* already closed */ }
  }
}

async function sampleDueObservations() {
  const ips = (discoveryConfig.results || []).map((device) => device.ip);
  if (!ips.length) return;
  const stpIp = eventStore.nextDue('stp', ips);
  if (stpIp) await sampleStp(stpIp);
  if (topologyJob.running) return;
  const neighborIp = eventStore.nextDue('neighbor', ips);
  if (!neighborIp) return;
  const device = (discoveryConfig.results || []).find((item) => item.ip === neighborIp);
  if (!device) return;
  try {
    const report = await readNeighbors(device, 2000);
    if (!report.cdpOk || (!report.cdp.length && !report.lldpOk)) {
      eventStore.touch(neighborIp, 'neighbor');
      return;
    }
    eventStore.noteNeighbors(neighborIp, report.cdp.length ? report.cdp : report.lldp, device.sysName || '');
  } catch (err) {
    console.error('Neighbor poll failed', neighborIp, safeError(err));
    eventStore.touch(neighborIp, 'neighbor');
  }
}

function topologyView() {
  const devices = discoveryConfig.results || [];
  const known = new Set(devices.map((device) => device.ip));
  const links = (topologyCache.links || []).filter((link) => known.has(link.a) && known.has(link.b));
  const groups = new Map();
  for (const device of devices) {
    const name = siteName(device);
    const list = groups.get(name) || [];
    list.push({
      ip: device.ip,
      sysName: device.sysName,
      sysLocation: device.sysLocation || '',
      sysDescr: device.sysDescr || '',
      addresses: device.addresses || [device.ip],
    });
    groups.set(name, list);
  }
  const sites = [...groups.entries()]
    .map(([name, list]) => ({
      name,
      devices: list.sort((a, b) => (a.sysName || a.ip).localeCompare(b.sysName || b.ip)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    sites,
    links,
    scanning: topologyJob.running,
    scanned: topologyJob.scanned,
    total: topologyJob.total,
    updatedAt: topologyCache.updatedAt || null,
    error: topologyJob.error,
    defaultSite: discoveryConfig.topologyDefaultSite || '',
    core: discoveryConfig.topologyDefaultSite || '',
  };
}

async function scanTopology() {
  if (topologyJob.running) return false;
  const devices = [...(discoveryConfig.results || [])];
  topologyJob.running = true;
  topologyJob.error = null;
  topologyJob.scanned = 0;
  topologyJob.total = devices.length;
  const reports = [];
  try {
    await mapPool(devices, 4, async (device) => {
      const report = await readNeighbors(device);
      reports.push(report);
      if (report.cdpOk && (report.cdp.length || report.lldpOk)) {
        eventStore.noteNeighbors(device.ip, report.cdp.length ? report.cdp : report.lldp, device.sysName || '');
      }
      topologyJob.scanned += 1;
    });
    topologyCache = { updatedAt: new Date().toISOString(), links: buildLinks(devices, reports) };
    fs.writeFileSync(TOPOLOGY_FILE, JSON.stringify(topologyCache));
  } catch (err) {
    topologyJob.error = safeError(err);
  } finally {
    topologyJob.running = false;
  }
  return true;
}

app.get('/api/topology', (_req, res) => {
  const updated = Date.parse(topologyCache.updatedAt || '');
  const stale = !topologyCache.updatedAt || Number.isNaN(updated) || Date.now() - updated > 10 * 60 * 1000;
  if (stale && (discoveryConfig.results || []).length && !topologyJob.running) scanTopology();
  res.json(topologyView());
});

app.post('/api/topology/scan', (_req, res) => {
  if (!topologyJob.running) scanTopology();
  res.status(topologyJob.running ? 202 : 200).json(topologyView());
});

app.post('/api/topology/default', (req, res) => {
  discoveryConfig.topologyDefaultSite = String(req.body?.site || '').trim();
  saveConfig();
  res.json(topologyView());
});

app.get('/api/events', (req, res) => {
  res.json(eventStore.list({ device: req.query.device || '', q: req.query.q || '', limit: req.query.limit }));
});

app.get('/api/poller', (_req, res) => {
  res.json({ ...pollStats.summary(), currentDevice: pollerJob.currentDevice });
});

function backupScheduleView() {
  const schedule = discoveryConfig.backupSchedule || {};
  return {
    enabled: !!schedule.enabled,
    cron: schedule.cron || '0 2 * * *',
    lastRun: schedule.lastRun || null,
    lastError: schedule.lastError || '',
  };
}

app.post('/api/settings/service-account', (req, res) => {
  const body = req.body || {};
  const current = discoveryConfig.serviceAccount || {};
  const deviceType = normalizeDeviceType(body.deviceType) || normalizeDeviceType(current.deviceType) || 'cisco_ios';
  let passwordEnc = current.passwordEnc || '';
  let enableEnc = current.enableEnc || '';
  if (typeof body.password === 'string' && body.password !== '') passwordEnc = encryptSecret(secretKey, body.password);
  if (body.clearEnable) enableEnc = '';
  else if (typeof body.enable === 'string' && body.enable !== '') enableEnc = encryptSecret(secretKey, body.enable);
  if (body.schedule && typeof body.schedule === 'object') {
    const cronExpr = String(body.schedule.cron || '').trim();
    if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'Backup schedule is not a valid cron expression' });
    discoveryConfig.backupSchedule = {
      enabled: !!body.schedule.enabled,
      cron: cronExpr,
      lastRun: discoveryConfig.backupSchedule?.lastRun || null,
      lastError: discoveryConfig.backupSchedule?.lastError || '',
    };
  }
  discoveryConfig.serviceAccount = normalizeServiceAccount({
    enabled: !!body.enabled,
    username: body.username,
    deviceType,
    passwordEnc,
    enableEnc,
  }, deviceType);
  saveConfig();
  startBackupScheduler();
  res.json({ ...serviceAccountView(), backupSchedule: backupScheduleView() });
});

app.post('/api/settings/syslog', async (req, res) => {
  discoveryConfig.syslog = normalizeSyslogConfig({ ...discoveryConfig.syslog, ...(req.body || {}) });
  saveConfig();
  await bindSyslog();
  res.json(syslogView());
});

async function walkDevice(ip, timeoutMs, read, options = {}) {
  let session;
  try {
    const pduTimeout = options.pduTimeout || Math.min(2000, timeoutMs);
    session = openSession(ip, credForIp(ip), { timeout: pduTimeout, retries: 0 });
    return await read(session);
  } finally {
    try { session?.close(); } catch { /* already closed */ }
  }
}

function varbindOk(vb) {
  if (!vb || !vb.oid) return false;
  try {
    if (typeof snmp.isVarbindError === 'function' && snmp.isVarbindError(vb)) return false;
  } catch {
    return false;
  }
  return true;
}

function sessionSubtree(session, oid, timeoutMs, onVarbind) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      session.subtree(oid, 50, (varbinds) => {
        let stop = false;
        for (const vb of varbinds || []) {
          if (onVarbind(vb) === true) stop = true;
        }
        return stop;
      }, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

async function readTableColumns(session, tableOid, columns, perColumnMs, rowCap) {
  const table = {};
  let responded = false;
  for (const column of columns) {
    const prefix = `${tableOid}.1.${column}.`;
    let added = 0;
    const ok = await sessionSubtree(session, `${tableOid}.1.${column}`, perColumnMs, (vb) => {
      if (!varbindOk(vb)) return false;
      const oid = String(vb.oid);
      if (!oid.startsWith(prefix)) return false;
      const index = oid.slice(prefix.length);
      if (!index) return false;
      const row = table[index] || {};
      row[column] = vb.value;
      table[index] = row;
      added += 1;
      return Object.keys(table).length >= rowCap;
    });
    if (ok || added) responded = true;
    if (!responded) break;
  }
  return { ok: responded, table };
}

const manualSnmp = { pduTimeout: 5000 };

async function readRoutes(session) {
  const cidr = await readTableColumns(session, CIDR_ROUTE_TABLE, CIDR_ROUTE_COLUMNS, 12000, 250);
  const cidrRows = cidr.ok ? parseCidrRoutes(cidr.table) : [];
  if (cidrRows.length) return { ok: true, routes: cidrRows, error: '' };
  const inet = await readTableColumns(session, INET_ROUTE_TABLE, INET_ROUTE_COLUMNS, 12000, 250);
  const inetRows = inet.ok ? parseInetRoutes(inet.table) : [];
  if (inetRows.length) return { ok: true, routes: inetRows, error: '' };
  const classic = await readTableColumns(session, ROUTE_TABLE, ROUTE_COLUMNS, 8000, 250);
  const routes = classic.ok ? parseRoutes(classic.table) : [];
  if (routes.length) return { ok: true, routes, error: '' };
  const any = cidr.ok || inet.ok || classic.ok;
  return { ok: any, routes: [], error: any ? '' : 'SNMP timeout or the route table is unavailable' };
}

function largerVlans(current, next) {
  if (!next) return current;
  if (!current || next.length > current.length) return next;
  return current;
}

async function readVlans(session) {
  const qbridge = await readTableColumns(session, QBRIDGE_VLAN_TABLE, [1], 8000, 1024);
  const vtp = await readTableColumns(session, VTP_VLAN_TABLE, VTP_VLAN_COLUMNS, 8000, 1024);
  let best = largerVlans(
    qbridge.ok ? parseQbridgeVlans(qbridge.table) : [],
    vtp.ok ? parseVtpVlans(vtp.table) : [],
  );
  let any = qbridge.ok || vtp.ok;
  if (best.length < 2) {
    const juniper = await readTableColumns(session, JUNIPER_VLAN_TABLE, JUNIPER_VLAN_COLUMNS, 8000, 1024);
    if (juniper.ok) best = largerVlans(best, parseJuniperVlans(juniper.table));
    any = any || juniper.ok;
    if (best.length < 2) {
      const legacy = await readTableColumns(session, JUNIPER_LEGACY_VLAN_TABLE, JUNIPER_LEGACY_VLAN_COLUMNS, 8000, 1024);
      if (legacy.ok) best = largerVlans(best, parseJuniperLegacyVlans(legacy.table));
      any = any || legacy.ok;
    }
  }
  return { ok: any || best.length > 0, vlans: best, error: any || best.length ? '' : 'SNMP timeout or no VLAN table' };
}

app.get('/api/devices/:ip/routing', async (req, res) => {
  try {
    const body = await walkDevice(req.params.ip, 20000, (session) => readRoutes(session), manualSnmp);
    res.json(body);
  } catch (err) {
    res.status(502).json({ ok: false, routes: [], error: safeError(err) });
  }
});

app.get('/api/devices/:ip/vlans', async (req, res) => {
  try {
    const body = await walkDevice(req.params.ip, 20000, (session) => readVlans(session), manualSnmp);
    if (body.ok) catalog.saveVlans(req.params.ip, body.vlans);
    res.json(body);
  } catch (err) {
    res.status(502).json({ ok: false, vlans: [], error: safeError(err) });
  }
});

const neighborCache = new Map();

app.get('/api/devices/:ip/neighbors', async (req, res) => {
  const ip = req.params.ip;
  const refresh = req.query.refresh === '1';
  const cached = neighborCache.get(ip);
  if (!refresh && cached && Date.now() - cached.at < 60000) {
    return res.json({ cdp: cached.cdp, lldp: cached.lldp, cdpOk: cached.cdpOk, lldpOk: cached.lldpOk, error: '', cachedAt: cached.at });
  }
  const report = { at: Date.now(), cdp: [], lldp: [], cdpOk: false, lldpOk: false, error: '' };
  try {
    await walkDevice(ip, 4000, async (session) => {
      const cdp = await sessionTableResult(session, CDP_TABLE, [4, 6, 7], 4000);
      report.cdpOk = cdp.ok;
      if (cdp.ok) report.cdp = parseCdp(cdp.table).slice(0, 500);
      const lldp = await sessionTableResult(session, LLDP_TABLE, [7, 9], 4000);
      report.lldpOk = lldp.ok;
      if (lldp.ok) report.lldp = parseLldp(lldp.table).slice(0, 500);
    });
  } catch (err) {
    report.error = safeError(err);
  }
  if (report.cdpOk || report.lldpOk) neighborCache.set(ip, report);
  res.json({ cdp: report.cdp, lldp: report.lldp, cdpOk: report.cdpOk, lldpOk: report.lldpOk, error: report.error, cachedAt: report.at });
});

app.get('/api/devices/:ip/inventory', async (req, res) => {
  try {
    const body = await walkDevice(req.params.ip, 20000, async (session) => {
      const result = await readTableColumns(session, ENTITY_TABLE, ENTITY_COLUMNS, 8000, 300);
      return {
        ok: result.ok,
        rows: result.ok ? parseInventory(result.table) : [],
        error: result.ok ? '' : 'SNMP timeout or the entity table is unavailable',
      };
    }, manualSnmp);
    if (body.ok) catalog.saveSerials(req.params.ip, chassisFirst(body.rows));
    res.json(body);
  } catch (err) {
    res.status(502).json({ ok: false, rows: [], error: safeError(err) });
  }
});

app.get('/api/devices/:ip/logs', (req, res) => {
  const ip = req.params.ip;
  const device = (discoveryConfig.results || []).find((item) => item.ip === ip);
  res.json({
    events: eventStore.list({ device: ip, q: req.query.q || '', limit: 200 }),
    syslog: syslogStore.forDevice({
      ips: [ip, ...(device?.addresses || [])],
      hostname: device?.sysName || '',
      q: req.query.q || '',
      limit: 200,
    }),
  });
});

app.get('/api/devices/:ip/config', (req, res) => {
  const row = db.prepare('SELECT body, saved_at, device_type, error FROM device_config WHERE ip = ?').get(req.params.ip);
  res.json({
    enabled: !!discoveryConfig.serviceAccount?.enabled,
    deviceType: cliTypeFor(req.params.ip),
    savedAt: row?.saved_at || null,
    body: row?.body || '',
    error: row?.error || '',
  });
});

const backupInflight = new Set();
let backupCron = null;
let backupSweepRunning = false;

async function storeBackup(ip) {
  const account = discoveryConfig.serviceAccount || {};
  if (!account.enabled) return { status: 400, ok: false, error: 'The service account is disabled', body: '', savedAt: null, deviceType: '' };
  if (!account.username || !account.passwordEnc) {
    return { status: 400, ok: false, error: 'Service account username and password are required', body: '', savedAt: null, deviceType: '' };
  }
  if (backupInflight.has(ip)) {
    return { status: 409, ok: false, error: 'A backup is already running for this device', body: '', savedAt: null, deviceType: '' };
  }
  backupInflight.add(ip);
  try {
    let password = '';
    let enable = '';
    try {
      password = decryptSecret(secretKey, account.passwordEnc);
      enable = account.enableEnc ? decryptSecret(secretKey, account.enableEnc) : '';
    } catch {
      return { status: 500, ok: false, error: 'The stored service account password could not be read', body: '', savedAt: null, deviceType: '' };
    }
    const deviceType = cliTypeFor(ip);
    if (!deviceType) {
      return {
        status: 200,
        ok: false,
        error: 'Could not detect a device type from the operating system. Set the type on this device.',
        body: '',
        savedAt: null,
        deviceType: '',
        enabled: true,
      };
    }
    const result = await runBackup({ host: ip, username: account.username, password, enable, deviceType });
    const savedAt = Date.now();
    const previous = db.prepare('SELECT body FROM device_config WHERE ip = ?').get(ip);
    const body = result.ok ? result.config : (previous?.body || '');
    db.prepare(`
      INSERT OR REPLACE INTO device_config (ip, body, saved_at, device_type, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(ip, body, savedAt, deviceType, result.ok ? '' : (result.error || 'Backup failed'));
    return { status: 200, ok: !!result.ok, error: result.error || '', savedAt, deviceType, body, enabled: true };
  } finally {
    backupInflight.delete(ip);
  }
}

async function runBackupSweep() {
  if (backupSweepRunning) return;
  backupSweepRunning = true;
  const ips = (discoveryConfig.results || []).map((device) => device && device.ip).filter(Boolean);
  let failed = 0;
  let lastError = '';
  try {
    for (const ip of ips) {
      let result;
      try {
        result = await storeBackup(ip);
      } catch (err) {
        failed += 1;
        lastError = safeError(err);
        continue;
      }
      if (result.ok || result.status === 409) continue;
      failed += 1;
      lastError = result.error || 'Backup failed';
      if (result.status === 400 || result.status === 500) break;
    }
    discoveryConfig.backupSchedule = {
      ...backupScheduleView(),
      lastRun: new Date().toISOString(),
      lastError: failed ? `${failed} failed. ${lastError}`.trim() : '',
    };
    saveConfig();
  } catch (err) {
    discoveryConfig.backupSchedule = {
      ...backupScheduleView(),
      lastRun: new Date().toISOString(),
      lastError: safeError(err),
    };
    saveConfig();
  } finally {
    backupSweepRunning = false;
  }
}

function startBackupScheduler() {
  if (backupCron) backupCron.stop();
  backupCron = null;
  const schedule = backupScheduleView();
  if (!schedule.enabled || !cron.validate(schedule.cron)) {
    if (schedule.enabled) console.error('Invalid backup cron', schedule.cron);
    return;
  }
  try {
    backupCron = cron.schedule(schedule.cron, () => {
      runBackupSweep().catch((err) => console.error('Scheduled backup failed', safeError(err)));
    });
  } catch (err) {
    console.error('Invalid backup cron', err.message);
  }
}

startBackupScheduler();

app.post('/api/devices/:ip/config/backup', async (req, res) => {
  try {
    const result = await storeBackup(req.params.ip);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json({ ok: result.ok, error: result.error, savedAt: result.savedAt, deviceType: result.deviceType, body: result.body, enabled: true });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: safeError(err) });
  }
});

function closeSyslog() {
  const previous = syslogSocket;
  syslogSocket = null;
  if (!previous) return Promise.resolve();
  return new Promise((resolve) => {
    previous.once('close', () => resolve());
    try { previous.close(); } catch { resolve(); }
  });
}

function bindSyslog() {
  return closeSyslog().then(() => new Promise((resolve) => {
    const cfg = normalizeSyslogConfig(discoveryConfig.syslog);
    if (!cfg.enabled) {
      syslogStatus = 'stopped';
      resolve(syslogStatus);
      return;
    }
    const socket = dgram.createSocket('udp4');
    syslogSocket = socket;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(syslogStatus);
    };
    const timer = setTimeout(finish, 2000);
    socket.on('error', (err) => {
      syslogStatus = err?.code === 'EACCES' || err?.code === 'EADDRINUSE'
        ? `could not bind UDP ${cfg.port}: ${err.code}`
        : (err?.message || 'syslog bind failed');
      if (syslogSocket === socket) syslogSocket = null;
      try { socket.close(); } catch { /* closed */ }
      finish();
    });
    socket.on('message', (msg, rinfo) => {
      const parsed = parseSyslog(msg.toString('utf8'));
      if (!parsed) return;
      try {
        syslogStore.insert({
          sourceIp: rinfo.address,
          facility: parsed.facility,
          severity: parsed.severity,
          host: parsed.host,
          message: parsed.message,
        }, cfg);
      } catch (err) {
        console.error('syslog store failed', err.message);
      }
    });
    socket.once('listening', () => {
      if (syslogSocket === socket) syslogStatus = `listening on UDP ${socket.address().port}`;
      finish();
    });
    try {
      socket.bind(cfg.port, '0.0.0.0');
    } catch (err) {
      syslogStatus = err.message || 'syslog bind failed';
      finish();
    }
  }));
}

function deviceRecord(ip) {
  return (discoveryConfig.results || []).find((device) => device.ip === ip) || null;
}

app.get('/api/catalog/serials', (_req, res) => {
  res.json({ serials: catalog.allSerials() });
});

app.get('/api/devices/:ip/serials', async (req, res) => {
  const ip = req.params.ip;
  const stamp = catalog.seen(ip);
  const cached = catalog.serialsFor(ip);
  const fresh = stamp.serialAt && Date.now() - stamp.serialAt < 6 * 3600 * 1000;
  if (fresh) return res.json({ serials: cached, cached: true });
  try {
    const body = await walkDevice(ip, 12000, async (session) => {
      const result = await readTableColumns(session, ENTITY_TABLE, [5, 7, 11, 13], 6000, 80);
      return { ok: result.ok, rows: result.ok ? parseInventory(result.table) : [] };
    }, manualSnmp);
    if (body.ok) catalog.saveSerials(ip, chassisFirst(body.rows));
    res.json({ serials: catalog.serialsFor(ip), cached: false });
  } catch (err) {
    res.json({ serials: cached, cached: true, error: safeError(err) });
  }
});

app.get('/api/devices/:ip/errors', async (req, res) => {
  const ip = req.params.ip;
  const device = deviceRecord(ip);
  const grouped = classifyEvents(eventStore.list({ device: ip, limit: 400 }));
  const syslog = syslogStore.forDevice({
    ips: [ip, ...(device?.addresses || [])],
    hostname: device?.sysName || '',
    limit: 200,
  }).filter((row) => row.severity <= 3);
  let interfaces = [];
  let error = '';
  try {
    const body = await walkDevice(ip, 8000, async (session) => {
      const result = await readTableColumns(session, IF_TABLE, [2, 13, 14, 19, 20], 4000, 512);
      return { ok: result.ok, rows: result.ok ? interfaceErrorRows(result.table) : [] };
    }, manualSnmp);
    interfaces = body.rows;
    if (!body.ok) error = 'Interface counters were not readable';
  } catch (err) {
    error = safeError(err);
  }
  res.json({ interfaces, syslog, ...grouped, error });
});

function columnText(row, column) {
  return snmpText(row?.[column] ?? row?.[String(column)]);
}

app.get('/api/devices/:ip/optics', async (req, res) => {
  const ip = req.params.ip;
  try {
    const body = await walkDevice(ip, 15000, async (session) => {
      const entity = await readTableColumns(session, ENTITY_TABLE, [7], 4000, 300);
      const entityNames = {};
      if (entity.ok) {
        for (const [index, row] of Object.entries(entity.table)) entityNames[index] = columnText(row, 7);
      }
      const sensors = await readTableColumns(session, SENSOR_TABLE, SENSOR_COLUMNS, 5000, 400);
      let optics = sensors.ok ? pairOptics(entityNames, sensors.table) : [];
      let responded = sensors.ok;
      if (!optics.length) {
        const ifs = await readTableColumns(session, IF_TABLE, [2], 4000, 256);
        const ifNames = {};
        if (ifs.ok) {
          for (const [index, row] of Object.entries(ifs.table)) ifNames[index] = columnText(row, 2);
        }
        const dom = await readTableColumns(session, JUNIPER_DOM_TABLE, JUNIPER_DOM_COLUMNS, 5000, 200);
        responded = responded || dom.ok || ifs.ok;
        if (dom.ok) optics = juniperOptics(dom.table, ifNames);
      }
      return { ok: responded, optics };
    }, manualSnmp);
    if (body.optics.length) catalog.recordOptics(ip, body.optics);
    res.json({
      detected: body.optics.length > 0,
      optics: body.optics,
      history: catalog.opticHistory(ip),
      error: body.ok || body.optics.length ? '' : 'No optical sensors responded',
    });
  } catch (err) {
    res.status(502).json({ detected: false, optics: [], history: [], error: safeError(err) });
  }
});

app.get('/api/network-search', (req, res) => {
  const kind = ['vlan', 'ip', 'serial'].includes(req.query.kind) ? req.query.kind : 'ip';
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ kind, rows: [], catalogEmpty: false });
  if (kind === 'vlan') {
    const counts = catalog.counts();
    const rows = catalog.searchVlan(q).map((row) => {
      const device = deviceRecord(row.ip);
      return { ...row, hostname: device?.sysName || '', location: device?.sysLocation || '' };
    });
    return res.json({ kind, rows, catalogEmpty: counts.vlans === 0 });
  }
  if (kind === 'serial') {
    const counts = catalog.counts();
    const rows = catalog.searchSerial(q).map((row) => {
      const device = deviceRecord(row.ip);
      return { ...row, hostname: device?.sysName || row.name || '' };
    });
    return res.json({ kind, rows, catalogEmpty: counts.serials === 0 });
  }
  const needle = q.toLowerCase();
  const rows = [];
  for (const device of discoveryConfig.results || []) {
    const addresses = [device.ip, ...(device.addresses || [])].filter(Boolean);
    const match = addresses.find((address) => String(address).toLowerCase().includes(needle));
    if (!match) continue;
    rows.push({ ip: device.ip, hostname: device.sysName || '', match, location: device.sysLocation || '' });
    if (rows.length >= 200) break;
  }
  res.json({ kind: 'ip', rows, catalogEmpty: false });
});

app.get('/api/syslog', (req, res) => {
  res.json({
    status: syslogStatus,
    enabled: !!discoveryConfig.syslog?.enabled,
    rows: syslogStore.list({ q: req.query.q || '', severity: req.query.severity || '', limit: req.query.limit || 200 }),
  });
});

app.get('/api/auth/config', (_req, res) => {
  res.json(publicAuth(discoveryConfig.auth));
});

app.get('/api/auth/session', (req, res) => {
  if (authMode() === 'off') return res.json({ mode: 'off', username: '' });
  const user = authStore.sessionUser(readSessionToken(req));
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  res.json({ mode: authMode(), username: user.username });
});

app.get('/api/auth/users', (_req, res) => {
  res.json({ users: authStore.listUsers() });
});

app.post('/api/auth/users', (req, res) => {
  try {
    const result = authStore.addUser(req.body?.username, req.body?.password);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, username: result.username });
  } catch (err) {
    const duplicate = String(err?.message || '').includes('UNIQUE');
    res.status(400).json({ error: duplicate ? 'That username already exists' : 'Could not create the user' });
  }
});

app.delete('/api/auth/users/:username', (req, res) => {
  const name = String(req.params.username || '');
  if (authMode() === 'local' && authStore.listUsers().filter((user) => user.username !== name).length === 0) {
    return res.status(400).json({ error: 'Keep at least one local user while local authentication is on' });
  }
  authStore.deleteUser(name);
  res.json({ ok: true });
});

app.post('/api/auth/login', async (req, res) => {
  const mode = authMode();
  if (mode === 'off') return res.status(400).json({ error: 'Authentication is off' });
  if (mode === 'sso') return res.status(400).json({ error: 'This site uses single sign-on' });
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');
  if (mode === 'local') {
    const session = authStore.loginLocal(username, password);
    if (!session) return res.status(401).json({ error: 'Username or password was rejected' });
    res.setHeader('Set-Cookie', sessionCookie(req, session.token));
    return res.json({ ok: true, username: session.username, mode });
  }
  const cfg = normalizeAuth(discoveryConfig.auth);
  let bindPassword = '';
  try {
    if (mode === 'ldap' && cfg.ldap.bindPasswordEnc) bindPassword = decryptSecret(secretKey, cfg.ldap.bindPasswordEnc);
  } catch {
    return res.status(500).json({ error: 'The directory bind password could not be read' });
  }
  const result = await authenticateDirectory({
    url: mode === 'ad' ? cfg.ad.url : cfg.ldap.url,
    username,
    password,
    mode,
    domain: cfg.ad.domain,
    baseDn: cfg.ldap.baseDn,
    userFilter: cfg.ldap.userFilter,
    bindDn: cfg.ldap.bindDn,
    bindPassword,
  });
  if (!result.ok) return res.status(401).json({ error: result.error || 'Directory login was rejected' });
  const session = authStore.openSession(result.name || username);
  res.setHeader('Set-Cookie', sessionCookie(req, session.token));
  res.json({ ok: true, username: session.username, mode });
});

app.post('/api/auth/logout', (req, res) => {
  authStore.endSession(readSessionToken(req));
  res.setHeader('Set-Cookie', sessionCookie(req, '', true));
  res.json({ ok: true });
});

function safeRedirect(next) {
  const text = String(next || '');
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch { /* reject unexpected targets */ }
  return '/';
}

function ssoReturnUrl(req) {
  let origin = '';
  try {
    if (req.get('referer')) origin = new URL(req.get('referer')).origin;
  } catch { /* ignore a bad referer */ }
  const requested = String(req.query.next || '');
  if (requested.startsWith('/') && !requested.startsWith('//')) return origin ? `${origin}${requested}` : requested;
  return origin ? `${origin}/` : '/';
}

app.get('/api/auth/sso/start', async (req, res) => {
  const sso = normalizeAuth(discoveryConfig.auth).sso;
  if (authMode() !== 'sso' || !sso.issuer || !sso.clientId || !sso.redirectUri) {
    return res.status(400).json({ error: 'Single sign-on is not configured' });
  }
  try {
    const discovery = await fetch(`${sso.issuer}/.well-known/openid-configuration`);
    if (!discovery.ok) return res.status(502).json({ error: 'Could not read the SSO discovery document' });
    const doc = await discovery.json();
    if (!doc.authorization_endpoint) return res.status(502).json({ error: 'SSO discovery did not include an authorization endpoint' });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = authStore.saveState(verifier, ssoReturnUrl(req));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: sso.clientId,
      redirect_uri: sso.redirectUri,
      scope: 'openid profile email',
      state,
      code_challenge: codeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    res.redirect(`${doc.authorization_endpoint}?${params}`);
  } catch {
    res.status(502).json({ error: 'Could not start single sign-on' });
  }
});

app.get('/api/auth/sso/callback', async (req, res) => {
  const sso = normalizeAuth(discoveryConfig.auth).sso;
  const pending = authStore.takeState(String(req.query.state || ''));
  if (!pending?.verifier) return res.status(400).send('Sign-in state was missing or expired');
  if (!req.query.code) return res.status(400).send('Sign-in did not return a code');
  try {
    const discovery = await fetch(`${sso.issuer}/.well-known/openid-configuration`);
    if (!discovery.ok) return res.status(502).send('Could not read the SSO discovery document');
    const doc = await discovery.json();
    const secret = sso.clientSecretEnc ? decryptSecret(secretKey, sso.clientSecretEnc) : '';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      redirect_uri: sso.redirectUri,
      client_id: sso.clientId,
      code_verifier: pending.verifier,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (secret) headers.Authorization = `Basic ${Buffer.from(`${sso.clientId}:${secret}`).toString('base64')}`;
    const tokenRes = await fetch(doc.token_endpoint, { method: 'POST', headers, body });
    if (!tokenRes.ok) return res.status(401).send('Single sign-on rejected the code');
    const tokens = await tokenRes.json();
    const jwksRes = await fetch(doc.jwks_uri);
    if (!jwksRes.ok) return res.status(502).send('Could not read the SSO signing keys');
    const payload = verifyIdToken(tokens.id_token, await jwksRes.json(), { issuer: doc.issuer || sso.issuer, audience: sso.clientId });
    let name = ssoName(payload);
    if (tokens.access_token && doc.userinfo_endpoint) {
      const infoRes = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (infoRes.ok) name = ssoName(await infoRes.json()) || name;
    }
    if (!name) return res.status(401).send('Single sign-on did not return a username');
    const session = authStore.openSession(name);
    res.setHeader('Set-Cookie', sessionCookie(req, session.token));
    res.redirect(safeRedirect(pending.next));
  } catch {
    res.status(401).send('Single sign-on failed');
  }
});

app.post('/api/settings/auth', (req, res) => {
  const body = req.body || {};
  const current = normalizeAuth(discoveryConfig.auth);
  const mode = ['off', 'local', 'ad', 'ldap', 'sso'].includes(body.mode) ? body.mode : current.mode;
  if (mode === 'local' && authStore.listUsers().length === 0) {
    return res.status(400).json({ error: 'Create a local user first' });
  }
  let bindPasswordEnc = current.ldap.bindPasswordEnc;
  if (body.ldap?.clearPassword) bindPasswordEnc = '';
  else if (typeof body.ldap?.bindPassword === 'string' && body.ldap.bindPassword) bindPasswordEnc = encryptSecret(secretKey, body.ldap.bindPassword);
  let clientSecretEnc = current.sso.clientSecretEnc;
  if (body.sso?.clearSecret) clientSecretEnc = '';
  else if (typeof body.sso?.clientSecret === 'string' && body.sso.clientSecret) clientSecretEnc = encryptSecret(secretKey, body.sso.clientSecret);
  discoveryConfig.auth = normalizeAuth({
    mode,
    ad: { url: body.ad?.url ?? current.ad.url, domain: body.ad?.domain ?? current.ad.domain },
    ldap: {
      url: body.ldap?.url ?? current.ldap.url,
      baseDn: body.ldap?.baseDn ?? current.ldap.baseDn,
      userFilter: body.ldap?.userFilter ?? current.ldap.userFilter,
      bindDn: body.ldap?.bindDn ?? current.ldap.bindDn,
      bindPasswordEnc,
    },
    sso: {
      issuer: body.sso?.issuer ?? current.sso.issuer,
      clientId: body.sso?.clientId ?? current.sso.clientId,
      redirectUri: body.sso?.redirectUri ?? current.sso.redirectUri,
      clientSecretEnc,
    },
  });
  saveConfig();
  res.json(publicAuth(discoveryConfig.auth));
});

const CATALOG_STALE_MS = 6 * 3600 * 1000;
let catalogSampling = false;

function nextCatalogIp() {
  let best = '';
  let oldest = Infinity;
  for (const device of discoveryConfig.results || []) {
    if (!device?.ip) continue;
    const stamp = catalog.seen(device.ip);
    const at = Math.min(stamp.serialAt || 0, stamp.vlanAt || 0);
    if (at < oldest) {
      oldest = at;
      best = device.ip;
    }
  }
  return best;
}

async function sampleCatalogDevice(ip) {
  const stamp = catalog.seen(ip);
  const now = Date.now();
  const needSerial = !stamp.serialAt || now - stamp.serialAt > CATALOG_STALE_MS;
  const needVlan = !stamp.vlanAt || now - stamp.vlanAt > CATALOG_STALE_MS;
  if (!needSerial && !needVlan) return;
  await walkDevice(ip, 14000, async (session) => {
    if (needSerial) {
      const result = await readTableColumns(session, ENTITY_TABLE, [5, 7, 11, 13], 6000, 80);
      if (result.ok) catalog.saveSerials(ip, chassisFirst(parseInventory(result.table)));
    }
    if (needVlan) {
      const body = await readVlans(session);
      if (body.ok) catalog.saveVlans(ip, body.vlans);
    }
  }, manualSnmp);
}

setInterval(() => {
  if (catalogSampling) return;
  const ip = nextCatalogIp();
  if (!ip) return;
  catalogSampling = true;
  sampleCatalogDevice(ip)
    .catch((err) => console.error('catalog sample failed', err.message))
    .finally(() => {
      catalogSampling = false;
    });
}, 60000);

// Keep existing health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, discovery: discoveryConfig.schedule.enabled });
});

await bindSyslog();

app.listen(PORT, () => {
  console.log(`ReactNMS backend (with discovery) on http://localhost:${PORT}`);
});
