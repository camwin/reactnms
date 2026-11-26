// One device can answer on every gateway in the scanned prefixes.
// Identity is the SNMP sysName. A blank name, or a name that is just the
// address we probed, stays keyed by that address.

export function deviceKey(device) {
  const ip = String(device?.ip || '').trim();
  const name = String(device?.sysName || '').trim();
  if (!name || name === ip) return `ip:${ip}`;
  return `name:${name.toLowerCase()}`;
}

function pushAddress(device, ip) {
  if (!ip) return;
  if (!Array.isArray(device.addresses)) device.addresses = [];
  if (!device.addresses.includes(ip)) device.addresses.push(ip);
}

export function createDeviceBook(previous) {
  const previousByName = new Map();
  for (const device of previous || []) {
    const key = deviceKey(device);
    if (key.startsWith('name:') && !previousByName.has(key)) previousByName.set(key, device);
  }

  const accepted = new Map();
  const deferred = new Map();

  function add(hit) {
    const key = deviceKey(hit);
    const existing = accepted.get(key);
    if (existing) {
      pushAddress(existing, hit.ip);
      return { type: 'duplicate', ip: hit.ip, of: existing.ip, name: existing.sysName || existing.ip };
    }

    if (key.startsWith('name:')) {
      const prev = previousByName.get(key);
      if (prev && prev.ip !== hit.ip) {
        const alts = deferred.get(key) || [];
        alts.push(hit);
        deferred.set(key, alts);
        return {
          type: 'deferred',
          ip: hit.ip,
          preferred: prev.ip,
          name: prev.sysName || hit.sysName || prev.ip,
        };
      }
    }

    const device = { ...hit, addresses: [hit.ip] };
    const alts = deferred.get(key) || [];
    for (const alt of alts) pushAddress(device, alt.ip);
    deferred.delete(key);
    accepted.set(key, device);
    return { type: 'added', device };
  }

  function finish() {
    const events = [];
    for (const [key, alts] of deferred) {
      if (accepted.has(key)) {
        const device = accepted.get(key);
        for (const alt of alts) pushAddress(device, alt.ip);
        continue;
      }
      const primary = alts[0];
      const device = { ...primary, addresses: [] };
      for (const alt of alts) pushAddress(device, alt.ip);
      const prev = previousByName.get(key);
      const fromIp = prev && prev.ip !== device.ip ? prev.ip : null;
      accepted.set(key, device);
      events.push({ type: 'promoted', device, fromIp });
    }
    deferred.clear();
    return events;
  }

  function devices() {
    return [...accepted.values()];
  }

  return { add, finish, devices };
}

// ifAdminStatus 2 is administratively down ("disabled"). An oper-down
// interface that is still enabled stays tracked so a link-down is visible.
// Oper-up interfaces that were not tracked are added.
const ADMIN_DOWN = 2;
const OPER_UP = 1;

export function visibleDuringScan(found, previous) {
  const foundKeys = new Set(found.map((device) => deviceKey(device)));
  const foundIps = new Set(found.map((device) => device.ip));
  const pending = (previous || []).filter((device) => !foundKeys.has(deviceKey(device)) && !foundIps.has(device.ip));
  return [...found, ...pending];
}

// Names that are not physical ports. VLAN SVIs match ^vlan because ifTable
// has no routed bit. An empty saved list means "ignore nothing".
export const DEFAULT_INTERFACE_IGNORE = [
  '^null',
  '^loopback',
  '^lo\\d',
  '^appgigabitethernet',
  '^vlan',
  '^vl\\d',
  '^tunnel',
  '^tu\\d',
  '^virtual-access',
  '^virtual-template',
  '^nve',
  '^bdi',
  '^stackport',
  '^stacksub',
  '^bluetooth',
  '^internal',
  '^unrouted',
];

// JavaScript has no PCRE inline flags. A leading (?i) or (?-i) is applied to
// the compiled expression. The default flag is case-insensitive.
function applyInlineFlags(spec, flags) {
  const text = String(spec || '').toLowerCase();
  const dash = text.indexOf('-');
  const on = dash === -1 ? text : text.slice(0, dash);
  const off = dash === -1 ? '' : text.slice(dash + 1);
  let next = flags;
  for (const flag of off) {
    if ('ims'.includes(flag)) next = next.replaceAll(flag, '');
  }
  for (const flag of on) {
    if ('ims'.includes(flag) && !next.includes(flag)) next += flag;
  }
  return next;
}

export function compileIgnorePattern(source) {
  let text = String(source || '').trim();
  if (!text) return null;
  let flags = 'i';
  let match;
  while ((match = text.match(/^\(\?([ims-]*)\)/i))) {
    flags = applyInlineFlags(match[1], flags);
    text = text.slice(match[0].length);
  }
  const group = text.match(/^\(\?([ims-]*):([\s\S]*)\)$/i);
  if (group) {
    flags = applyInlineFlags(group[1], flags);
    text = group[2];
  }
  if (!text) return null;
  return new RegExp(text, flags);
}

export function interfaceIgnored(name, patterns) {
  const text = String(name || '');
  for (const raw of patterns || []) {
    const source = String(raw || '').trim();
    if (!source) continue;
    try {
      const pattern = compileIgnorePattern(source);
      if (pattern && pattern.test(text)) return true;
    } catch {
      if (text.toLowerCase().includes(source.toLowerCase())) return true;
    }
  }
  return false;
}

// Rows already stored for a device. Matching names are dropped from the
// tracked set. Indexes with no name are left for the next discovery sync.
export function pruneIgnoredInterfaces(records, patterns) {
  const drop = [];
  for (const row of records || []) {
    if (interfaceIgnored(row?.name, patterns)) drop.push(row);
  }
  return drop;
}

export function syncInterfaceSelection(selected, interfaces, patterns = []) {
  const next = new Set((selected || []).map(String));
  const known = new Set();
  let added = 0;
  let removed = 0;

  for (const iface of interfaces || []) {
    const index = String(iface.index);
    known.add(index);
    const disabled = Number(iface.adminStatus) === ADMIN_DOWN;
    const ignored = interfaceIgnored(iface.name, patterns);
    const up = Number(iface.operStatus) === OPER_UP && !disabled && !ignored;
    if (up && !next.has(index)) {
      next.add(index);
      added += 1;
    } else if ((disabled || ignored) && next.has(index)) {
      next.delete(index);
      removed += 1;
    }
  }

  for (const index of [...next]) {
    if (!known.has(index)) {
      next.delete(index);
      removed += 1;
    }
  }

  const indexes = [...next];
  const changed = added > 0 || removed > 0 || indexes.length !== (selected || []).length;
  return { indexes, added, removed, changed };
}
