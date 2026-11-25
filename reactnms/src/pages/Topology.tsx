import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchDiscoveryResults, type DiscoveredDevice } from '@/lib/api';
import { cn } from '@/lib/cn';

function shortName(device: DiscoveredDevice) {
  const raw = (device.sysName || device.ip).split('.')[0];
  return raw.length > 16 ? `${raw.slice(0, 15)}…` : raw;
}

function layoutMap(devices: DiscoveredDevice[]) {
  const groups = new Map<string, DiscoveredDevice[]>();
  for (const device of devices) {
    const key = device.subnet || 'Discovered';
    const list = groups.get(key) || [];
    list.push(device);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => (a.sysName || a.ip).localeCompare(b.sysName || b.ip));
  }

  const colW = 230;
  const rowH = 76;
  const padX = 36;
  const padTop = 46;
  const gap = 20;
  let width = 760;
  let cursor = 16;
  const frames: { subnet: string; x: number; y: number; w: number; h: number }[] = [];
  const nodes: { device: DiscoveredDevice; x: number; y: number; label: string }[] = [];

  for (const [subnet, list] of groups) {
    const cols = Math.min(4, Math.max(1, list.length));
    const rows = Math.ceil(list.length / cols);
    const w = Math.max(320, padX * 2 + cols * colW);
    const h = padTop + rows * rowH + 16;
    width = Math.max(width, w + 32);
    frames.push({ subnet, x: 16, y: cursor, w, h });
    list.forEach((device, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      nodes.push({
        device,
        x: 16 + padX + col * colW + 26,
        y: cursor + padTop + row * rowH + 22,
        label: shortName(device),
      });
    });
    cursor += h + gap;
  }

  return { frames, nodes, width, height: Math.max(240, cursor) };
}

export default function Topology() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const data = await fetchDiscoveryResults();
        if (!cancel) setDevices(data.results || []);
      } catch {
        if (!cancel) setDevices([]);
      }
    }
    pull();
    const id = window.setInterval(pull, 5000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, []);

  const map = useMemo(() => layoutMap(devices), [devices]);
  const current = devices.find((device) => device.ip === selected) || null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Topology</h1>
        <p className="mt-1 text-sm text-muted">
          Devices from the last discovery, grouped by prefix. Adjacencies are not polled yet.
        </p>
      </div>

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
              className="h-auto w-full min-w-[720px]"
              role="group"
              aria-label="Discovered devices"
            >
              {map.frames.map((frame) => (
                <g key={frame.subnet}>
                  <rect
                    x={frame.x}
                    y={frame.y}
                    width={frame.w}
                    height={frame.h}
                    rx={12}
                    className="fill-bg stroke-line"
                  />
                  <text x={frame.x + 16} y={frame.y + 26} className="fill-faint font-mono" fontSize="13">
                    {frame.subnet}
                  </text>
                </g>
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
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={on ? 26 : 20}
                      className={cn('fill-raised stroke-accent', on && 'stroke-[4]')}
                      strokeWidth={on ? 4 : 2.5}
                    />
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
          <div className="border-t border-line px-4 py-3 font-mono text-xs text-accent">Discovered</div>
        </div>
      )}

      <section className="rounded-xl border border-line bg-surface px-4 py-4">
        {current ? (
          <div className="flex flex-col gap-2">
            <h2 className="font-mono text-lg font-semibold">{current.sysName || current.ip}</h2>
            <p className="font-mono text-sm text-muted">
              {current.ip}
              {current.subnet ? ` · ${current.subnet}` : ''}
              {current.credentialName ? ` · ${current.credentialName}` : ''}
            </p>
            {current.sysDescr ? <p className="text-sm text-muted">{current.sysDescr}</p> : null}
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
