export const NO_LOCATION = 'No location';
export const CDP_TABLE = '1.3.6.1.4.1.9.9.23.1.2.1';
export const LLDP_TABLE = '1.0.8802.1.1.2.1.4.1';

export function siteName(device) {
  const location = String(device?.sysLocation || '').trim();
  return location || NO_LOCATION;
}

export function shortHost(name) {
  const text = String(name || '').trim().toLowerCase();
  if (!text) return '';
  return text.split('.')[0];
}

function textOf(value) {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8').replace(/\0+$/g, '').trim();
  return String(value).replace(/\0+$/g, '').trim();
}

export function formatSnmpAddr(value) {
  if (Buffer.isBuffer(value)) {
    const bytes = [...value];
    if (bytes.length === 4) return bytes.join('.');
    if (bytes.length > 4 && bytes[0] === 1) return bytes.slice(1, 5).join('.');
    const asText = textOf(value);
    const found = asText.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    return found ? found[1] : '';
  }
  const text = textOf(value);
  const found = text.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  return found ? found[1] : '';
}

function rowValue(row, column) {
  if (!row || typeof row !== 'object') return undefined;
  return row[column] ?? row[String(column)];
}

export function parseCdp(table) {
  const neighbors = [];
  for (const [index, row] of Object.entries(table || {})) {
    const remoteName = textOf(rowValue(row, 6));
    const remoteAddr = formatSnmpAddr(rowValue(row, 4));
    if (!remoteName && !remoteAddr) continue;
    neighbors.push({
      localIf: String(index).split('.')[0],
      remoteName,
      remotePort: textOf(rowValue(row, 7)),
      remoteAddr,
      protocol: 'cdp',
    });
  }
  return neighbors;
}

export function parseLldp(table) {
  const neighbors = [];
  for (const [index, row] of Object.entries(table || {})) {
    const remoteName = textOf(rowValue(row, 9));
    if (!remoteName) continue;
    const parts = String(index).split('.');
    neighbors.push({
      localIf: parts.length >= 2 ? parts[1] : parts[0],
      remoteName,
      remotePort: textOf(rowValue(row, 7)),
      remoteAddr: '',
      protocol: 'lldp',
    });
  }
  return neighbors;
}

function indexDevices(devices) {
  const byAddr = new Map();
  const byName = new Map();
  for (const device of devices || []) {
    if (!device?.ip) continue;
    byAddr.set(device.ip, device);
    for (const address of device.addresses || []) {
      if (address) byAddr.set(address, device);
    }
    const name = shortHost(device.sysName);
    if (!name || name === shortHost(device.ip)) continue;
    const list = byName.get(name) || [];
    list.push(device);
    byName.set(name, list);
  }
  return { byAddr, byName };
}

function resolveNeighbor(neighbor, selfIp, byAddr, byName) {
  if (neighbor.remoteAddr && byAddr.has(neighbor.remoteAddr)) {
    const found = byAddr.get(neighbor.remoteAddr);
    if (found.ip !== selfIp) return found;
  }
  const name = shortHost(neighbor.remoteName);
  const list = name ? byName.get(name) : null;
  if (!list) return null;
  return list.find((device) => device.ip !== selfIp) || null;
}

// reports: [{ ip, cdp: Neighbor[], lldp: Neighbor[] }]
// A device with any CDP neighbor does not also contribute LLDP.
export function buildLinks(devices, reports) {
  const { byAddr, byName } = indexDevices(devices);
  const edges = new Map();
  for (const report of reports || []) {
    const local = byAddr.get(report.ip);
    if (!local) continue;
    const cdp = report.cdp || [];
    const use = cdp.length ? cdp : report.lldp || [];
    const protocol = cdp.length ? 'cdp' : 'lldp';
    for (const neighbor of use) {
      const remote = resolveNeighbor(neighbor, local.ip, byAddr, byName);
      if (!remote) continue;
      const [a, b] = [local.ip, remote.ip].sort();
      const key = `${a}|${b}`;
      const edge = {
        a,
        b,
        protocol,
        aPort: local.ip === a ? neighbor.localIf || '' : neighbor.remotePort || '',
        bPort: local.ip === b ? neighbor.localIf || '' : neighbor.remotePort || '',
      };
      const prev = edges.get(key);
      if (!prev || (protocol === 'cdp' && prev.protocol !== 'cdp')) edges.set(key, edge);
    }
  }
  return [...edges.values()];
}

function linkEnds(link) {
  return [link.a, link.b];
}

// Selected site shows its devices. The core shows only itself. Any other
// site shows its devices plus the shortest neighbor path to the core.
export function coreView(sites, links, selectedName, coreName) {
  const selected = (sites || []).find((site) => site.name === selectedName);
  if (!selected) return { sites: [], links: [], note: '' };
  const internal = (list) => {
    const ips = new Set(list.flatMap((site) => site.devices.map((device) => device.ip)));
    return (links || []).filter((link) => ips.has(link.a) && ips.has(link.b));
  };
  if (!coreName || coreName === selectedName) {
    return {
      sites: [selected],
      links: internal([selected]),
      note: coreName === selectedName ? 'Core' : '',
    };
  }
  const core = (sites || []).find((site) => site.name === coreName);
  if (!core) return { sites: [selected], links: internal([selected]), note: 'The core site is not on the map.' };

  const graph = new Map();
  for (const link of links || []) {
    for (const [from, to] of [[link.a, link.b], [link.b, link.a]]) {
      const next = graph.get(from) || [];
      next.push(to);
      graph.set(from, next);
    }
  }
  const starts = new Set(selected.devices.map((device) => device.ip));
  const goals = new Set(core.devices.map((device) => device.ip));
  const parent = new Map();
  const queue = [];
  for (const ip of starts) {
    parent.set(ip, '');
    queue.push(ip);
  }
  let found = '';
  while (queue.length && !found) {
    const ip = queue.shift();
    if (goals.has(ip) && !starts.has(ip)) {
      found = ip;
      break;
    }
    for (const next of graph.get(ip) || []) {
      if (parent.has(next)) continue;
      parent.set(next, ip);
      queue.push(next);
    }
  }
  const keep = new Set(starts);
  if (found) {
    let cursor = found;
    while (cursor) {
      keep.add(cursor);
      cursor = parent.get(cursor) || '';
    }
  }
  const shown = [];
  for (const site of sites || []) {
    const devices = site.devices.filter((device) => keep.has(device.ip));
    if (devices.length) shown.push({ ...site, devices });
  }
  shown.sort((a, b) => {
    if (a.name === selectedName) return -1;
    if (b.name === selectedName) return 1;
    if (a.name === coreName) return 1;
    if (b.name === coreName) return -1;
    return a.name.localeCompare(b.name);
  });
  return {
    sites: shown,
    links: (links || []).filter((link) => linkEnds(link).every((ip) => keep.has(ip))),
    note: found ? `Path from ${selectedName} to the core` : `No neighbor path from ${selectedName} to the core`,
  };
}
