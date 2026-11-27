import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { fetchTopology, saveTopologyDefault, scanTopology, type DiscoveredDevice, type TopologyLink, type TopologyView } from '@/lib/api';
import { coreView } from '@/lib/core-view';
import { formatAgo } from '@/lib/format';
import { cn } from '@/lib/cn';

function shortName(device: DiscoveredDevice) {
  const raw = (device.sysName || device.ip).split('.')[0];
  return raw.length > 16 ? `${raw.slice(0, 15)}…` : raw;
}

function layoutMap(view: TopologyView) {
  const colW = 200;
  const rowH = 64;
  const padX = 28;
  const padTop = 40;
  const gap = 16;
  const built: { site: string; w: number; h: number; nodes: { device: DiscoveredDevice; x: number; y: number; label: string }[] }[] = [];
  let maxW = 560;

  for (const site of view.sites) {
    const list = site.devices;
    const cols = Math.min(4, Math.max(1, list.length));
    const rows = Math.ceil(list.length / cols);
    const w = Math.max(280, padX * 2 + cols * colW);
    const h = padTop + rows * rowH + 12;
    maxW = Math.max(maxW, w);
    const local: { device: DiscoveredDevice; x: number; y: number; label: string }[] = [];
    list.forEach((device, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      local.push({
        device,
        x: padX + col * colW + 22,
        y: padTop + row * rowH + 18,
        label: shortName(device),
      });
    });
    built.push({ site: site.name, w, h, nodes: local });
  }

  const canvas = maxW + 48;
  let cursor = 20;
  const frames: { site: string; x: number; y: number; w: number; h: number }[] = [];
  const nodes: { device: DiscoveredDevice; x: number; y: number; label: string }[] = [];
  for (const site of built) {
    const x = (canvas - site.w) / 2;
    frames.push({ site: site.site, x, y: cursor, w: site.w, h: site.h });
    for (const node of site.nodes) {
      nodes.push({ ...node, x: x + node.x, y: cursor + node.y });
    }
    cursor += site.h + gap;
  }

  const at = new Map(nodes.map((node) => [node.device.ip, node]));
  const lines = view.links.flatMap((link) => {
    const from = at.get(link.a);
    const to = at.get(link.b);
    if (!from || !to) return [];
    return [{ ...link, x1: from.x, y1: from.y, x2: to.x, y2: to.y }];
  });

  const contentWidth = canvas;
  const contentHeight = Math.max(220, cursor);
  const zoom = 0.08;
  const marginX = Math.round(contentWidth * zoom);
  const marginY = Math.round(contentHeight * zoom);
  const shift = <T extends { x: number; y: number }>(item: T): T => ({ ...item, x: item.x + marginX, y: item.y + marginY });
  return {
    frames: frames.map(shift),
    nodes: nodes.map(shift),
    lines: lines.map((line) => ({ ...line, x1: line.x1 + marginX, y1: line.y1 + marginY, x2: line.x2 + marginX, y2: line.y2 + marginY })),
    width: contentWidth + marginX * 2,
    height: contentHeight + marginY * 2,
  };
}

const ALL = '__all__';

export default function Topology() {
  const [view, setView] = useState<TopologyView>({ sites: [], links: [], scanning: false, scanned: 0, total: 0, updatedAt: null, error: null, defaultSite: '', core: '' });
  const [selected, setSelected] = useState<string | null>(null);
  const [site, setSite] = useState(ALL);
  const [note, setNote] = useState('');
  const appliedDefault = useRef(false);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const data = await fetchTopology();
        if (cancel) return;
        setView(data);
        setNote('');
        if (!appliedDefault.current) {
          appliedDefault.current = true;
          const core = data.core || data.defaultSite || '';
          if (core && data.sites.some((item) => item.name === core)) setSite(core);
        }
      } catch {
        if (!cancel) setNote('Could not load topology');
      }
    }
    pull();
    const id = window.setInterval(pull, view.scanning ? 3000 : 15000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [view.scanning]);

  const siteValue = site !== ALL && view.sites.some((item) => item.name === site) ? site : ALL;
  const coreName = view.core || view.defaultSite || '';
  const shown = useMemo(() => {
    if (siteValue === ALL) return { ...view, note: '' };
    const next = coreView(view.sites, view.links, siteValue, coreName);
    return { ...view, sites: next.sites, links: next.links, note: next.note };
  }, [view, siteValue, coreName]);
  const devices = shown.sites.flatMap((item) => item.devices);
  const map = useMemo(() => layoutMap(shown), [shown]);
  const current = devices.find((device) => device.ip === selected) || null;
  const neighbors = shown.links.filter((link) => link.a === selected || link.b === selected);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Topology</h1>
          <p className="mt-1 text-sm text-muted">
            Devices grouped by SNMP location. The core site shows only itself. Every other site shows the shortest neighbor path back to the core. Links come from CDP, and from LLDP only when a device has no CDP neighbors.
            {view.updatedAt ? ` Last read ${formatAgo(view.updatedAt)}.` : ''}
            {view.scanning ? ` Reading neighbors ${view.scanned}/${view.total}.` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            ariaLabel="Site"
            value={siteValue}
            onValueChange={setSite}
            options={[{ value: ALL, label: 'All sites' }, ...view.sites.map((item) => ({ value: item.name, label: item.name }))]}
          />
          {siteValue !== ALL ? (
            <Button
              tone="line"
              disabled={coreName === siteValue}
              onClick={() => {
                saveTopologyDefault(siteValue).then(setView).catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not save the core site'));
              }}
            >
              {coreName === siteValue ? 'Core' : 'Make core'}
            </Button>
          ) : null}
          {coreName ? (
            <Button
              tone="ghost"
              onClick={() => {
                saveTopologyDefault('').then(setView).catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not clear the core site'));
              }}
            >
              Clear core
            </Button>
          ) : null}
          <Button
            tone="line"
            onClick={() => {
              setNote('');
              scanTopology().then(setView).catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Scan failed'));
            }}
          >
            {view.scanning ? 'Reading neighbors' : 'Rescan neighbors'}
          </Button>
        </div>
      </div>
      {shown.note ? <p className="text-sm text-muted">{shown.note}</p> : null}
      {note || view.error ? <p className="text-sm text-down">{note || view.error}</p> : null}

      {devices.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-sm text-muted">
          No devices discovered.{' '}
          <Link to="/discovery" className="text-accent">
            Run a scan
          </Link>
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="max-h-[70vh] overflow-auto">
            <svg
              viewBox={`0 0 ${map.width} ${map.height}`}
              className="h-auto w-full"
              role="group"
              aria-label="Sites and neighbor links"
            >
              {map.frames.map((frame) => (
                <g key={frame.site}>
                  <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx={12} className="fill-bg stroke-line" />
                  <text x={frame.x + 16} y={frame.y + 26} className="fill-faint font-mono" fontSize="13">
                    {frame.site}
                  </text>
                </g>
              ))}
              {map.lines.map((line) => (
                <line
                  key={`${line.a}|${line.b}`}
                  x1={line.x1}
                  y1={line.y1}
                  x2={line.x2}
                  y2={line.y2}
                  className={line.protocol === 'cdp' ? 'stroke-accent' : 'stroke-warn'}
                  strokeWidth={selected && (line.a === selected || line.b === selected) ? 3 : 1.5}
                />
              ))}
              {map.nodes.map((node) => {
                const on = selected === node.device.ip;
                const labelWidth = Math.max(48, node.label.length * 8.4 + 16);
                return (
                  <g
                    key={node.device.ip}
                    role="button"
                    tabIndex={0}
                    aria-label={node.device.sysName || node.device.ip}
                    aria-pressed={on}
                    className="cursor-pointer"
                    onClick={() => setSelected(node.device.ip)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelected(node.device.ip);
                      }
                    }}
                  >
                    <circle cx={node.x} cy={node.y} r={on ? 26 : 20} className={cn('fill-raised stroke-accent', on && 'stroke-[4]')} strokeWidth={on ? 4 : 2.5} />
                    <circle cx={node.x} cy={node.y} r={4.5} className="fill-accent" />
                    <rect x={node.x + 24} y={node.y - 12} width={labelWidth} height={24} rx={5} className="fill-raised" />
                    <text x={node.x + 32} y={node.y + 5} className="fill-fg font-mono" fontSize="13">
                      {node.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="border-t border-line px-4 py-3 font-mono text-xs text-muted">
            <span className="text-accent">CDP</span>
            <span> · </span>
            <span className="text-warn">LLDP</span>
          </div>
        </div>
      )}

      <section className="rounded-xl border border-line bg-surface px-4 py-4">
        {current ? (
          <div className="flex flex-col gap-2">
            <h2 className="font-mono text-lg font-semibold">{current.sysName || current.ip}</h2>
            <p className="font-mono text-sm text-muted">
              {current.ip}
              {current.sysLocation ? ` · ${current.sysLocation}` : ' · No location'}
            </p>
            {current.sysDescr ? <p className="text-sm text-muted">{current.sysDescr}</p> : null}
            {neighbors.length ? (
              <ul className="text-sm">
                {neighbors.map((link) => (
                  <Neighbor key={`${link.a}|${link.b}`} link={link} self={current.ip} devices={devices} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No CDP or LLDP neighbor in the last read.</p>
            )}
            <Link to={`/devices/${encodeURIComponent(current.ip)}`} className="inline-flex min-h-11 items-center text-sm text-accent">
              Open device
            </Link>
          </div>
        ) : (
          <p className="text-sm text-muted">Select a node.</p>
        )}
      </section>
    </div>
  );
}

function Neighbor({ link, self, devices }: { link: TopologyLink; self: string; devices: DiscoveredDevice[] }) {
  const otherIp = link.a === self ? link.b : link.a;
  const other = devices.find((device) => device.ip === otherIp);
  const port = link.a === self ? link.aPort : link.bPort;
  return (
    <li className="border-b border-line py-2 last:border-b-0">
      <span className="font-mono uppercase text-xs text-faint">{link.protocol}</span>{' '}
      {other?.sysName || otherIp}
      {port ? ` via ${port}` : ''}
    </li>
  );
}
