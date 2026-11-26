export const SYS_SERVICES_OID = '1.3.6.1.2.1.1.7.0';
export const IP_FORWARDING_OID = '1.3.6.1.2.1.4.1.0';
export const ROUTE_TABLE = '1.3.6.1.2.1.4.21';
export const ROUTE_COLUMNS = [7, 11, 9, 2];
export const CIDR_ROUTE_TABLE = '1.3.6.1.2.1.4.24.4';
export const CIDR_ROUTE_COLUMNS = [7, 5];
export const INET_ROUTE_TABLE = '1.3.6.1.2.1.4.24.7';
export const INET_ROUTE_COLUMNS = [9, 7];
export const QBRIDGE_VLAN_TABLE = '1.3.6.1.2.1.17.7.1.4.3';
export const VTP_VLAN_TABLE = '1.3.6.1.4.1.9.9.46.1.3.1';
export const VTP_VLAN_COLUMNS = [4];
export const JUNIPER_VLAN_TABLE = '1.3.6.1.4.1.2636.3.40.1.5.1.5';
export const JUNIPER_VLAN_COLUMNS = [2, 5];
export const JUNIPER_LEGACY_VLAN_TABLE = '1.3.6.1.4.1.2636.3.40.1.5.1.1';
export const JUNIPER_LEGACY_VLAN_COLUMNS = [2, 1];
export const ENTITY_TABLE = '1.3.6.1.2.1.47.1.1.1';
export const ENTITY_COLUMNS = [2, 7, 5, 11, 13, 12];
export const ENTITY_PORT = 10;

const ROUTE_PROTOS = {
  1: 'other',
  2: 'local',
  3: 'netmgmt',
  4: 'icmp',
  8: 'rip',
  9: 'is-is',
  13: 'ospf',
  14: 'bgp',
  16: 'eigrp',
};

function cell(row, column) {
  if (!row) return undefined;
  return row[column] ?? row[String(column)];
}

function text(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/g, '').trim();
  return String(value).replace(/\0+$/g, '').trim();
}

function snmpIp(value) {
  if (Buffer.isBuffer(value) && value.length === 4) return [...value].join('.');
  const raw = text(value);
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw) ? raw : '';
}

function indexTail(index) {
  const parts = String(index || '').split('.').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function prefixToMask(bits) {
  const n = Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > 32) return '';
  if (n === 0) return '0.0.0.0';
  const mask = (0xffffffff << (32 - n)) >>> 0;
  return [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.');
}

function routeProto(value) {
  const proto = Number(value || 0);
  return ROUTE_PROTOS[proto] || (proto ? String(proto) : '');
}

function ipv4Parts(parts) {
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function formatInet(type, bytes) {
  if (type === 1 && bytes.length === 4) return bytes.join('.');
  if (type === 2 && bytes.length === 16) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
    return groups.join(':');
  }
  return '';
}

function takeBytes(parts, start) {
  const len = parts[start];
  if (!Number.isInteger(len) || len < 0 || start + 1 + len > parts.length) return null;
  return { bytes: parts.slice(start + 1, start + 1 + len), next: start + 1 + len };
}

function parseInetIndex(index) {
  const parts = String(index || '').split('.').map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  const destType = parts[0];
  const dest = takeBytes(parts, 1);
  if (!dest) return null;
  const pfxLen = parts[dest.next];
  const policyLen = parts[dest.next + 1];
  if (!Number.isInteger(pfxLen) || !Number.isInteger(policyLen) || policyLen < 0) return null;
  let cursor = dest.next + 2 + policyLen;
  if (cursor > parts.length) return null;
  const hopType = parts[cursor];
  const hop = takeBytes(parts, cursor + 1);
  if (!Number.isInteger(hopType) || !hop) return null;
  const destText = formatInet(destType, dest.bytes);
  const hopText = formatInet(hopType, hop.bytes);
  if (!destText && !hopText) return null;
  return {
    dest: destText,
    mask: destType === 1 ? prefixToMask(pfxLen) : `/${pfxLen}`,
    nextHop: hopText,
  };
}

export function isRouter(ipForwarding, sysServices) {
  if (Number(ipForwarding) === 1) return true;
  const bits = Number(sysServices);
  return Number.isFinite(bits) && (bits & 0x04) !== 0;
}

export function parseRoutes(table, limit = 250) {
  const routes = [];
  for (const [index, row] of Object.entries(table || {})) {
    const fromIndex = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(index) ? index : '';
    const dest = snmpIp(cell(row, 1)) || fromIndex;
    if (!dest) continue;
    routes.push({
      dest,
      mask: snmpIp(cell(row, 11)),
      nextHop: snmpIp(cell(row, 7)),
      ifIndex: text(cell(row, 2)),
      type: Number(cell(row, 8) || 0),
      proto: routeProto(cell(row, 9)),
    });
    if (routes.length >= limit) break;
  }
  return routes;
}

export function parseCidrRoutes(table, limit = 250) {
  const routes = [];
  for (const [index, row] of Object.entries(table || {})) {
    const parts = String(index).split('.').map((part) => Number(part));
    if (parts.length < 13 || !ipv4Parts(parts.slice(0, 4)) || !ipv4Parts(parts.slice(4, 8)) || !ipv4Parts(parts.slice(9, 13))) continue;
    routes.push({
      dest: parts.slice(0, 4).join('.'),
      mask: parts.slice(4, 8).join('.'),
      nextHop: parts.slice(9, 13).join('.'),
      ifIndex: text(cell(row, 5)),
      type: Number(cell(row, 6) || 0),
      proto: routeProto(cell(row, 7)),
    });
    if (routes.length >= limit) break;
  }
  return routes;
}

export function parseInetRoutes(table, limit = 250) {
  const routes = [];
  for (const [index, row] of Object.entries(table || {})) {
    const parsed = parseInetIndex(index);
    if (!parsed) continue;
    routes.push({
      dest: parsed.dest,
      mask: parsed.mask,
      nextHop: parsed.nextHop,
      ifIndex: text(cell(row, 7)),
      type: 0,
      proto: routeProto(cell(row, 9)),
    });
    if (routes.length >= limit) break;
  }
  return routes;
}

export function parseQbridgeVlans(table, limit = 1024) {
  const vlans = [];
  for (const [index, row] of Object.entries(table || {})) {
    vlans.push({ id: indexTail(index), name: text(cell(row, 1)), source: 'qbridge' });
    if (vlans.length >= limit) break;
  }
  return vlans.filter((vlan) => vlan.id);
}

export function parseVtpVlans(table, limit = 1024) {
  const vlans = [];
  for (const [index, row] of Object.entries(table || {})) {
    vlans.push({
      id: indexTail(index),
      name: text(cell(row, 4)),
      state: Number(cell(row, 3) || 0),
      source: 'vtp',
    });
    if (vlans.length >= limit) break;
  }
  return vlans.filter((vlan) => vlan.id);
}

export function parseJuniperVlans(table, limit = 1024) {
  const vlans = [];
  for (const [index, row] of Object.entries(table || {})) {
    const tag = text(cell(row, 5));
    vlans.push({ id: tag || indexTail(index), name: text(cell(row, 2)), source: 'juniper' });
    if (vlans.length >= limit) break;
  }
  return vlans.filter((vlan) => vlan.id);
}

export function parseJuniperLegacyVlans(table, limit = 1024) {
  const vlans = [];
  for (const [index, row] of Object.entries(table || {})) {
    const id = text(cell(row, 2)) || indexTail(index);
    vlans.push({ id, name: text(cell(row, 1)), source: 'juniper' });
    if (vlans.length >= limit) break;
  }
  return vlans.filter((vlan) => vlan.id);
}

export function parseInventory(table, limit = 200) {
  const rows = [];
  for (const [index, row] of Object.entries(table || {})) {
    rows.push({
      index: String(index),
      descr: text(cell(row, 2)),
      classId: Number(cell(row, 5) || 0),
      name: text(cell(row, 7)),
      serial: text(cell(row, 11)),
      manufacturer: text(cell(row, 12)),
      model: text(cell(row, 13)),
    });
  }
  const physical = rows.filter((row) => row.classId !== ENTITY_PORT);
  const chosen = physical.length ? physical : rows;
  return chosen.filter((row) => row.descr || row.name || row.serial || row.model).slice(0, limit);
}
