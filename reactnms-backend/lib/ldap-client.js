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

function equalityFilter(attribute, value) {
  return tlv(0xa3, Buffer.concat([ldapString(attribute), ldapString(value)]));
}

export function applyUserFilter(template, username) {
  return String(template || '(uid={{username}})').split('{{username}}').join(escapeFilter(username));
}

function parseFilter(text) {
  const source = String(text || '').trim();
  const equality = source.match(/^\(([a-zA-Z][\w.-]*)=([^)]*)\)$/);
  if (equality) return equalityFilter(equality[1], equality[2]);
  if (source.startsWith('(&') && source.endsWith(')')) {
    const inner = source.slice(2, -1);
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
    if (parts.length && parts.every(Boolean) && start === inner.length) return tlv(0xa0, Buffer.concat(parts));
  }
  return null;
}

export function searchMessage(messageId, base, filterText) {
  const filter = parseFilter(filterText);
  if (!filter) return null;
  const body = Buffer.concat([
    ldapString(base),
    tlv(0x0a, Buffer.from([0x02])),
    tlv(0x0a, Buffer.from([0x00])),
    encodeInt(0x02, 5),
    encodeInt(0x02, 8),
    tlv(0x01, Buffer.from([0x00])),
    filter,
    tlv(0x30, Buffer.alloc(0)),
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

function resultCode(message, appTag) {
  const outer = readTlv(message, 0);
  if (!outer || outer.tag !== 0x30) return null;
  let cursor = 0;
  const id = readTlv(outer.value, cursor);
  if (!id) return null;
  cursor = id.next;
  const app = readTlv(outer.value, cursor);
  if (!app || app.tag !== appTag) return null;
  const code = readTlv(app.value, 0);
  if (!code) return null;
  let value = 0;
  for (const byte of code.value) value = (value << 8) | byte;
  return value;
}

function entryDn(message) {
  const outer = readTlv(message, 0);
  if (!outer || outer.tag !== 0x30) return '';
  const id = readTlv(outer.value, 0);
  if (!id) return '';
  const app = readTlv(outer.value, id.next);
  if (!app || app.tag !== 0x64) return '';
  const name = readTlv(app.value, 0);
  if (!name || name.tag !== 0x04) return '';
  return name.value.toString('utf8');
}

function connectLdap(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = target.tls
      ? tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false })
      : net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('directory server timed out'));
    }, timeoutMs);
    const fail = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err instanceof Error ? err : new Error('directory connection failed'));
    };
    socket.once('error', fail);
    socket.once(target.tls ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}

function requestLdap(socket, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new Error('directory server timed out'));
    }, timeoutMs);
    const onData = (buf) => {
      chunks.push(buf);
      const message = Buffer.concat(chunks);
      const outer = readTlv(message, 0);
      if (!outer) return;
      clearTimeout(timer);
      socket.off('data', onData);
      resolve(message.subarray(0, outer.next));
    };
    socket.on('data', onData);
    socket.write(payload);
  });
}

export async function ldapBind(target, dn, password, timeoutMs = 8000) {
  const socket = await connectLdap(target, timeoutMs);
  try {
    const response = await requestLdap(socket, bindMessage(1, dn, password), timeoutMs);
    return resultCode(response, 0x61) === 0;
  } finally {
    socket.end();
  }
}

export async function ldapSearchDn(target, bindDn, bindPassword, base, filter, timeoutMs = 8000) {
  const socket = await connectLdap(target, timeoutMs);
  try {
    const bound = await requestLdap(socket, bindMessage(1, bindDn, bindPassword), timeoutMs);
    if (resultCode(bound, 0x61) !== 0) return '';
    const query = searchMessage(2, base, filter);
    if (!query) return '';
    const response = await requestLdap(socket, query, timeoutMs);
    return entryDn(response);
  } finally {
    socket.end();
  }
}

export async function authenticateDirectory({ url, username, password, mode, domain, baseDn, userFilter, bindDn, bindPassword }) {
  const target = parseLdapUrl(url);
  if (!target) return { ok: false, error: 'Directory URL must look like ldap://host or ldaps://host' };
  const user = String(username || '').trim();
  if (!user || !password) return { ok: false, error: 'Username and password are required' };
  try {
    if (mode === 'ad') {
      const name = user.includes('@') ? user : `${user}@${String(domain || '').replace(/^@/, '')}`;
      if (!name.includes('@')) return { ok: false, error: 'Active Directory needs a domain' };
      const ok = await ldapBind(target, name, password);
      return ok ? { ok: true, name: user } : { ok: false, error: 'Directory login was rejected' };
    }
    const filter = applyUserFilter(userFilter || '(uid={{username}})', user);
    const dn = await ldapSearchDn(target, bindDn || '', bindPassword || '', baseDn || '', filter);
    if (!dn) return { ok: false, error: 'No directory account matched' };
    const ok = await ldapBind(target, dn, password);
    return ok ? { ok: true, name: user } : { ok: false, error: 'Directory login was rejected' };
  } catch (err) {
    return { ok: false, error: err.message || 'Directory login failed' };
  }
}
