type SiteLike = { name: string; devices: { ip: string }[] };
type LinkLike = { a: string; b: string };

function internalLinks<L extends LinkLike>(sites: SiteLike[], links: L[]) {
  const ips = new Set(sites.flatMap((site) => site.devices.map((device) => device.ip)));
  return links.filter((link) => ips.has(link.a) && ips.has(link.b));
}

// Selected site shows its devices. The core shows only itself. Any other
// site shows its devices plus the shortest neighbor path to the core.
export function coreView<S extends SiteLike, L extends LinkLike>(sites: S[], links: L[], selectedName: string, coreName: string) {
  const selected = (sites || []).find((site) => site.name === selectedName);
  if (!selected) return { sites: [] as S[], links: [] as L[], note: '' };
  if (!coreName || coreName === selectedName) {
    return {
      sites: [selected],
      links: internalLinks([selected], links || []),
      note: coreName === selectedName ? 'Core' : '',
    };
  }
  const core = (sites || []).find((site) => site.name === coreName);
  if (!core) return { sites: [selected], links: internalLinks([selected], links || []), note: 'The core site is not on the map.' };

  const graph = new Map<string, string[]>();
  for (const link of links || []) {
    for (const [from, to] of [[link.a, link.b], [link.b, link.a]] as const) {
      const next = graph.get(from) || [];
      next.push(to);
      graph.set(from, next);
    }
  }
  const starts = new Set(selected.devices.map((device) => device.ip));
  const goals = new Set(core.devices.map((device) => device.ip));
  const parent = new Map<string, string>();
  const queue: string[] = [];
  for (const ip of starts) {
    parent.set(ip, '');
    queue.push(ip);
  }
  let found = '';
  while (queue.length && !found) {
    const ip = queue.shift() || '';
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
  const shown: S[] = [];
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
    links: (links || []).filter((link) => keep.has(link.a) && keep.has(link.b)),
    note: found ? `Path from ${selectedName} to the core` : `No neighbor path from ${selectedName} to the core`,
  };
}
