import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Settings } from 'lucide-react';
import { Metric, Panel, StatusPill } from '@/components/nms/bits';
import { RateChart } from '@/components/rate-chart';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import {
  ApiError,
  fetchDevice,
  fetchSelections,
  fetchStats,
  fetchTraffic,
  type DevicePoll,
  type DeviceStats,
  type TrafficPoint,
  type TrafficRange,
} from '@/lib/api';
import { formatSnmpUptime } from '@/lib/format';

const RANGES: { value: TrafficRange; label: string }[] = [
  { value: '1h', label: 'Last hour (raw)' },
  { value: '6h', label: 'Last 6h (1m)' },
  { value: '24h', label: 'Last 24h (1m)' },
];

export default function DeviceDetail() {
  const { ip } = useParams<{ ip: string }>();
  const [device, setDevice] = useState<DevicePoll | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<Record<string, TrafficPoint[]>>({});
  const [range, setRange] = useState<TrafficRange>('1h');
  const [realtime, setRealtime] = useState(true);
  const [stats, setStats] = useState<DeviceStats | null>(null);
  const [chartNote, setChartNote] = useState('');

  useEffect(() => {
    if (!ip) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    let cancel = false;
    setLoading(true);
    setError('');
    setDevice(null);
    fetchDevice(ip, controller.signal)
      .then((data) => {
        if (!cancel) setDevice(data);
      })
      .catch((err: unknown) => {
        if (cancel) return;
        if (err instanceof DOMException && err.name === 'AbortError') setError('Request timed out');
        else if (err instanceof ApiError) setError(err.message);
        else if (err instanceof Error && err.name === 'AbortError') setError('Request timed out');
        else if (err instanceof Error) setError(err.message);
        else setError('Could not load device');
      })
      .finally(() => {
        window.clearTimeout(timer);
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [ip]);

  useEffect(() => {
    if (!ip) return;
    let cancel = false;
    fetchSelections(ip)
      .then((rows) => {
        if (!cancel) setSelected((rows || []).map(String));
      })
      .catch(() => {
        if (!cancel) setSelected([]);
      });
    fetchStats(ip)
      .then((next) => {
        if (!cancel) setStats(next);
      })
      .catch(() => {
        if (!cancel) setStats(null);
      });
    return () => {
      cancel = true;
    };
  }, [ip]);

  const selectedKey = selected.join(',');

  useEffect(() => {
    if (!ip || !selectedKey || !realtime) return;
    const host = ip;
    const indexes = selectedKey.split(',');
    let cancel = false;
    async function load() {
      try {
        const series = await fetchTraffic(host, indexes, range);
        if (!cancel) setHistory(series);
      } catch {
        /* keep the last series on a transient poll error */
      }
    }
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [ip, selectedKey, range, realtime]);

  async function refresh() {
    if (!ip || selected.length === 0) return;
    try {
      setHistory(await fetchTraffic(ip, selected, range));
    } catch (err: unknown) {
      setChartNote(err instanceof Error ? err.message : 'Refresh failed');
    }
  }

  if (loading) return <div className="px-1 py-6 text-sm text-muted">Loading device…</div>;

  if (error || !device || !ip) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/devices" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted">
          <ChevronLeft className="size-4" aria-hidden />
          Devices
        </Link>
        <div className="rounded-xl border border-down/40 bg-down/10 px-4 py-4">
          <h1 className="text-xl font-semibold text-down">Could not load device</h1>
          <p className="mt-2 text-sm text-down">{error || 'No response'}</p>
        </div>
      </div>
    );
  }

  const names: Record<string, string> = {};
  for (const iface of device.interfaces || []) {
    const base = iface.name || `if${iface.index}`;
    names[String(iface.index)] = iface.customDesc ? `${base} — ${iface.customDesc}` : base;
  }

  const facts = [
    ['Description', device.sysDescr || '—'],
    ['Location', device.sysLocation || '—'],
    ['Contact', device.sysContact || '—'],
    ['Management', device.ip],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/devices" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted">
          <ChevronLeft className="size-4" aria-hidden />
          Devices
        </Link>
        <Button asChild tone="line">
          <Link to={`/devices/${encodeURIComponent(ip)}/settings`}>
            <Settings className="size-4" />
            Interface settings
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{device.sysName || device.ip}</h1>
          <p className="mt-1 font-mono text-sm text-muted">{device.ip}</p>
          {device.credential ? <p className="mt-1 font-mono text-xs text-faint">{device.credential}</p> : null}
        </div>
        <StatusPill status="up" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Uptime" value={formatSnmpUptime(device.sysUpTime)} />
        <Metric label="Interfaces" value={String(device.interfaces?.length || 0)} />
        <Metric label="Selected" value={String(selected.length)} hint="Polled into history" />
        <Metric
          label="Samples"
          value={stats ? stats.rawSamples.toLocaleString() : '—'}
          hint={stats ? `${(stats.dbSizeBytes / 1024).toFixed(1)} KB database` : 'History unavailable'}
        />
      </div>

      {selected.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">
          No interfaces selected.{' '}
          <Link to={`/devices/${encodeURIComponent(ip)}/settings`} className="text-accent">
            Configure
          </Link>
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select ariaLabel="History range" value={range} onValueChange={(value) => setRange(value as TrafficRange)} options={RANGES} />
            <label className="inline-flex min-h-11 items-center gap-2 text-sm">
              <Checkbox checked={realtime} onCheckedChange={(checked) => setRealtime(checked === true)} />
              Realtime
            </label>
            <Button tone="line" onClick={refresh}>
              Refresh now
            </Button>
            {chartNote ? <span className="text-sm text-down">{chartNote}</span> : null}
          </div>
          {selected.map((index) => {
            const points = history[index] || [];
            return (
              <Panel key={index} title={names[index] || `Interface ${index}`}>
                <div className="px-4 py-3">
                  <div className="mb-2 font-mono text-xs text-faint">{points.length} points</div>
                  {points.length < 2 ? (
                    <p className="text-sm text-muted">Collecting data… ({points.length}/2)</p>
                  ) : (
                    <RateChart points={points} />
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <Panel title="Identity">
        <dl className="grid gap-px bg-line sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="bg-surface px-4 py-3">
              <dt className="font-mono text-xs uppercase tracking-widest text-faint">{label}</dt>
              <dd className="mt-1 break-words font-mono text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
