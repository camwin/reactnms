import net from 'node:net';
import tls from 'node:tls';

function encodeLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

function encodeInt(tag, value) {
  let number = value >>> 0;
  const bytes = [number & 0xff];
  number >>= 8;
  while (number > 0) {
    bytes.unshift(number & 0xff);
    number >>= 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(tag, Buffer.from(bytes));
}

function ldapString(text) {
  return tlv(0x04, Buffer.from(String(text || ''), 'utf8'));
}

export function parseLdapUrl(url) {
  const match = String(url || '').trim().match(/^(ldaps?):\/\/([^/:]+)(?::(\d+))?\/?$/i);
  if (!match) return null;
  const secure = match[1].toLowerCase() === 'ldaps';
  const port = Number(match[3] || (secure ? 636 : 389));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[2], port, tls: secure };
}

export function bindMessage(messageId, dn, password) {
  const body = Buffer.concat([
    encodeInt(0x02, 3),
    ldapString(dn),
    tlv(0x80, Buffer.from(String(password || ''), 'utf8')),
  ]);
  return tlv(0x30, Buffer.concat([encodeInt(0x02, messageId), tlv(0x60, body)]));
}

function escapeFilter(value) {
  return String(value || '').replace(/[\\*()\0]/g, (char) => `\\${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function unescapeFilter(value) {
  return String(value || '').replace(/\\([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function equalityFilter(attribute, value) {
  return tlv(0xa3, Buffer.concat([ldapString(attribute), ldapString(unescapeFilter(value))]));
}

function extensibleFilter(attribute, rule, value) {
  return tlv(0xa9, Buffer.concat([
    tlv(0x81, Buffer.from(rule)),
    tlv(0x82, Buffer.from(attribute)),
    tlv(0x83, Buffer.from(unescapeFilter(value), 'utf8')),
  ]));
}

export function applyUserFilter(template, username) {
  return String(template || '(uid={{username}})').split('{{username}}').join(escapeFilter(username));
}

function compoundFilter(source, prefix, tag) {
  if (!source.startsWith(prefix) || !source.endsWith(')')) return null;
  const inner = source.slice(prefix.length, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] === '(') depth += 1;
    if (inner[i] === ')') depth -= 1;
    if (depth === 0 && inner[i] === ')') {
      parts.push(parseFilter(inner.slice(start, i + 1)));
      start = i + 1;
    }
  }
  if (!parts.length || parts.some((part) => !part) || start !== inner.length) return null;
  return tlv(tag, Buffer.concat(parts));
}

function parseFilter(text) {
  const source = String(text || '').trim();
  const extensible = source.match(/^\(([a-zA-Z][\w.-]*):([0-9.]+):=([^)]*)\)$/);
  if (extensible) return extensibleFilter(extensible[1], extensible[2], extensible[3]);
  const present = source.match(/^\(([a-zA-Z][\w.-]*)=\*\)$/);
  if (present) return tlv(0x87, Buffer.from(present[1]));
  const equality = source.match(/^\(([a-zA-Z][\w.-]*)=([^)]*)\)$/);
  if (equality) return equalityFilter(equality[1], equality[2]);
  return compoundFilter(source, '(&', 0xa0) || compoundFilter(source, '(|', 0xa1);
}

export function searchMessage(messageId, base, filterText, scope = 2, attributes = ['1.1']) {
  const filter = parseFilter(filterText);
  if (!filter) return null;
  const names = attributes.length ? attributes : ['1.1'];
  const body = Buffer.concat([
    ldapString(base),
    tlv(0x0a, Buffer.from([scope & 0xff])),
    tlv(0x0a, Buffer.from([0x00])),
    encodeInt(0x02, 5),
    encodeInt(0x02, 8),
    tlv(0x01, Buffer.from([0x00])),
    filter,
    tlv(0x30, Buffer.concat(names.map((name) => ldapString(name)))),
  ]);
  return tlv(0x30, Buffer.concat([encodeInt(0x02, messageId), tlv(0x63, body)]));
}

function readLength(buf, offset) {
  if (offset >= buf.length) return null;
  const first = buf[offset];
  if (first < 0x80) return { length: first, next: offset + 1 };
  const count = first & 0x7f;
  if (!count || offset + 1 + count > buf.length) return null;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = (length << 8) | buf[offset + 1 + i];
  return { length, next: offset + 1 + count };
}

function readTlv(buf, offset) {
  if (offset >= buf.length) return null;
  const tag = buf[offset];
  const len = readLength(buf, offset + 1);
  if (!len || len.next + len.length > buf.length) return null;
  return { tag, value: buf.subarray(len.next, len.next + len.length), next: len.next + len.length };
}

function messageBody(message) {
  const outer = readTlv(message, 0);
  if (!outer || outer.tag !== 0x30) return null;
  const id = readTlv(outer.value, 0);
  if (!id) return null;
  return readTlv(outer.value, id.next);
}

function integerValue(buf) {
  let value = 0;
  for (const byte of buf) value = (value << 8) | byte;
  return value;
}

function ldapStatus(app) {
  if (!app) return { code: null, diagnostic: '' };
  const code = readTlv(app.value, 0);
  if (!code) return { code: null, diagnostic: '' };
  const matched = readTlv(app.value, code.next);
  const diagnostic = matched ? readTlv(app.value, matched.next) : null;
  const text = diagnostic && diagnostic.tag === 0x04 ? diagnostic.value.toString('utf8') : '';
  return { code: integerValue(code.value), diagnostic: text };
}

function entryRecord(app) {
  if (!app || app.tag !== 0x64) return null;
  const name = readTlv(app.value, 0);
  if (!name || name.tag !== 0x04) return null;
  const attributes = {};
  const list = readTlv(app.value, name.next);
  if (list && list.tag === 0x30) {
    let cursor = 0;
    while (cursor < list.value.length) {
      const item = readTlv(list.value, cursor);
      if (!item) break;
      cursor = item.next;
      const type = readTlv(item.value, 0);
      const vals = type ? readTlv(item.value, type.next) : null;
      if (!type || !vals) continue;
      const key = type.value.toString('utf8').toLowerCase();
      const values = [];
      let valueCursor = 0;
      while (valueCursor < vals.value.length) {
        const one = readTlv(vals.value, valueCursor);
        if (!one) break;
        valueCursor = one.next;
        values.push(one.value);
      }
      attributes[key] = values;
    }
  }
  return { dn: name.value.toString('utf8'), attributes };
}

function normDn(dn) {
  return String(dn || '').trim().toLowerCase().replace(/,\s+/g, ',');
}

function sameDn(left, right) {
  const a = normDn(left);
  const b = normDn(right);
  return !!a && a === b;
}

function underDn(userDn, containerDn) {
  const user = normDn(userDn);
  const container = normDn(containerDn);
  return !!user && !!container && (user === container || user.endsWith(`,${container}`));
}

function textValues(values) {
  return (values || []).map((value) => value.toString('utf8'));
}

function sidRid(value) {
  if (!value || value.length < 8) return null;
  const count = value[1];
  if (!count) return null;
  const offset = 8 + (count - 1) * 4;
  if (offset + 4 > value.length) return null;
  return value.readUInt32LE(offset);
}

function primaryRid(values) {
  const text = textValues(values)[0] || '';
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function statusError(status, fallback) {
  if (status.code === 8) return 'The directory rejected a cleartext bind. Use an ldaps:// server';
  const detail = String(status.diagnostic || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return detail ? `${fallback}: ${detail}` : fallback;
}

function connectionError(err) {
  const code = err?.code;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
    return 'The directory closed the connection. Check the server URL and port';
  }
  return err?.message || 'Directory login failed';
}

// An IP address must not be sent as the TLS server name. Active Directory resets
// that handshake, and an unhandled socket error was taking down the API.
export function directoryTlsOptions(target) {
  return {
    host: target.host,
    port: target.port,
    servername: net.isIP(target.host) ? '' : target.host,
    rejectUnauthorized: false,
  };
}

function openLdap(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = target.tls
      ? tls.connect(directoryTlsOptions(target))
      : net.connect({ host: target.host, port: target.port });
    let buffer = Buffer.alloc(0);
    let pending = null;
    let opened = false;
    let failed = false;
    const finish = (err) => {
      const error = err instanceof Error ? err : new Error('directory connection failed');
      if (!opened && !failed) {
        failed = true;
        clearTimeout(timer);
        reject(error);
        try { socket.destroy(); } catch { /* already closed */ }
        return;
      }
      if (!pending) return;
      const waiter = pending;
      pending = null;
      waiter.reject(error);
    };
    const timer = setTimeout(() => finish(new Error('directory server timed out')), timeoutMs);
    socket.on('error', finish);
    socket.on('close', () => {
      if (pending) finish(new Error('The directory closed the connection'));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!pending) return;
      const outer = readTlv(buffer, 0);
      if (!outer) return;
      const message = buffer.subarray(0, outer.next);
      buffer = Buffer.from(buffer.subarray(outer.next));
      const waiter = pending;
      pending = null;
      waiter.resolve(message);
    });
    const readMessage = (waitMs) => new Promise((resolveMessage, rejectMessage) => {
      const wait = setTimeout(() => {
        if (!pending || pending.settle !== resolveMessage) return;
        pending = null;
        rejectMessage(new Error('directory server timed out'));
      }, waitMs);
      pending = {
        settle: resolveMessage,
        resolve: (message) => {
          clearTimeout(wait);
          resolveMessage(message);
        },
        reject: (err) => {
          clearTimeout(wait);
          rejectMessage(err);
        },
      };
      const outer = readTlv(buffer, 0);
      if (!outer) return;
      const message = buffer.subarray(0, outer.next);
      buffer = Buffer.from(buffer.subarray(outer.next));
      const waiter = pending;
      pending = null;
      clearTimeout(wait);
      waiter.resolve(message);
    });
    socket.once(target.tls ? 'secureConnect' : 'connect', () => {
      if (failed) return;
      opened = true;
      clearTimeout(timer);
      resolve({
        readMessage,
        write(payload) {
          socket.write(payload);
        },
        request(payload, waitMs) {
          const reading = readMessage(waitMs);
          socket.write(payload);
          return reading;
        },
        end() {
          try { socket.end(); } catch { /* already closed */ }
        },
      });
    });
  });
}

async function readSearch(conn, timeoutMs) {
  const names = [];
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < 32; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const app = messageBody(await conn.readMessage(remaining));
    if (!app || app.tag === 0x73) continue;
    if (app.tag === 0x64) {
      const entry = entryRecord(app);
      if (entry?.dn) names.push(entry);
      continue;
    }
    if (app.tag === 0x65) return { entries: names, names: names.map((entry) => entry.dn), ...ldapStatus(app) };
  }
  throw new Error('directory server timed out');
}

function requestSearch(conn, payload, timeoutMs) {
  const reading = readSearch(conn, timeoutMs);
  conn.write(payload);
  return reading;
}

export async function ldapBind(target, dn, password, timeoutMs = 8000) {
  const conn = await openLdap(target, timeoutMs);
  try {
    const response = await conn.request(bindMessage(1, dn, password), timeoutMs);
    return ldapStatus(messageBody(response)).code === 0;
  } finally {
    conn.end();
  }
}

export async function ldapSearchDn(target, bindDn, bindPassword, base, filter, timeoutMs = 8000) {
  const conn = await openLdap(target, timeoutMs);
  try {
    const bound = await conn.request(bindMessage(1, bindDn, bindPassword), timeoutMs);
    if (ldapStatus(messageBody(bound)).code !== 0) return '';
    const query = searchMessage(2, base, filter);
    if (!query) return '';
    const found = await requestSearch(conn, query, timeoutMs);
    return found.names[0] || '';
  } finally {
    conn.end();
  }
}

async function searchHasEntry(conn, messageId, base, filter, scope, timeoutMs) {
  const query = searchMessage(messageId, base, filter, scope);
  if (!query) return false;
  const found = await requestSearch(conn, query, timeoutMs);
  return found.names.length > 0;
}

export async function authenticateDirectory({ url, username, password, mode, baseDn, groupDn, userFilter, bindDn, bindPassword }) {
  const target = parseLdapUrl(url);
  if (!target) return { ok: false, error: 'Directory URL must look like ldap://host or ldaps://host' };
  const user = String(username || '').trim();
  if (!user || !password) return { ok: false, error: 'Username and password are required' };
  if (!String(bindDn || '').trim() || !bindPassword) return { ok: false, error: 'Set the directory bind account in Settings' };
  if (!String(baseDn || '').trim()) return { ok: false, error: 'Set the search base DN in Settings' };
  if (!String(groupDn || '').trim()) return { ok: false, error: 'Set the required group DN in Settings' };
  const fallback = mode === 'ad'
    ? '(|(sAMAccountName={{username}})(userPrincipalName={{username}}))'
    : '(uid={{username}})';
  const filter = applyUserFilter(userFilter || fallback, user);
  if (!searchMessage(2, baseDn, filter)) return { ok: false, error: 'The user filter is not a supported LDAP filter' };
  const group = escapeFilter(groupDn);
  let conn;
  let userDn = '';
  try {
    conn = await openLdap(target, 8000);
    const bound = messageBody(await conn.request(bindMessage(1, bindDn, bindPassword), 8000));
    const bindStatus = ldapStatus(bound);
    if (bound?.tag !== 0x61 || bindStatus.code !== 0) {
      return { ok: false, error: statusError(bindStatus, 'The directory bind account was rejected') };
    }
    const found = await requestSearch(conn, searchMessage(2, baseDn, filter), 8000);
    userDn = found.names[0] || '';
    if (!userDn) {
      if (found.code === 32) return { ok: false, error: 'The search base DN was not found' };
      return { ok: false, error: 'No directory account matched' };
    }
    const memberOf = `(&${filter}(memberOf=${group}))`;
    let inGroup = await searchHasEntry(conn, 3, baseDn, memberOf, 2, 8000);
    if (!inGroup) inGroup = await searchHasEntry(conn, 4, groupDn, `(member=${escapeFilter(userDn)})`, 0, 8000);
    if (!inGroup) inGroup = await searchHasEntry(conn, 5, groupDn, `(uniqueMember=${escapeFilter(userDn)})`, 0, 8000);
    if (!inGroup) return { ok: false, error: 'This account is not in the required group' };
  } catch (err) {
    return { ok: false, error: connectionError(err) };
  } finally {
    try { conn?.end(); } catch { /* already closed */ }
  }
  try {
    const ok = await ldapBind(target, userDn, password);
    return ok ? { ok: true, name: user } : { ok: false, error: 'Directory login was rejected' };
  } catch (err) {
    return { ok: false, error: connectionError(err) };
  }
}
