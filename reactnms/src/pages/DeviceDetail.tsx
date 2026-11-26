import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Settings } from 'lucide-react';
import { FilterChip, Metric, Panel, StatusPill } from '@/components/nms/bits';
import { RateChart } from '@/components/rate-chart';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import {
  ApiError,
  discoverDevice,
  fetchDevice,
  fetchSelections,
  fetchStats,
  fetchTraffic,
  type DevicePoll,
  type DeviceStats,
  type TrafficPoint,
  type TrafficRange,
} from '@/lib/api';
import { formatSnmpUptime, formatWhen } from '@/lib/format';
import { DeviceSection } from '@/pages/device-sections';

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
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [tab, setTab] = useState('interfaces');

  async function discover() {
    if (!ip) return;
    setDiscovering(true);
    setDiscoverNote('');
    try {
      await discoverDevice(ip);
      setReloadKey((value) => value + 1);
      setDiscoverNote('Device rediscovered');
    } catch (err: unknown) {
      setDiscoverNote(err instanceof Error ? err.message : 'Discover failed');
    } finally {
      setDiscovering(false);
    }
  }

  useEffect(() => {
    if (!ip) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 20000);
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
  }, [ip, reloadKey]);

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
  }, [ip, reloadKey]);

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
        <div className="flex flex-wrap items-center gap-2">
          <Button tone="line" onClick={discover} disabled={discovering}>{discovering ? 'Discovering…' : 'Discover device'}</Button>
          {discoverNote ? <span className="text-sm text-muted">{discoverNote}</span> : null}
        </div>
      </div>
    );
  }

  const names: Record<string, string> = {};
  for (const iface of device.interfaces || []) {
    const base = iface.name || `if${iface.index}`;
    const alias = (iface.alias || '').trim();
    names[String(iface.index)] = alias ? `${base} — ${alias}` : base;
  }

  const tabs = [
    { id: 'interfaces', label: 'Interfaces' },
    ...(device.router ? [{ id: 'routing', label: 'Routing' }] : []),
    { id: 'alerts', label: 'Alerts' },
    { id: 'vlans', label: 'VLANs' },
    { id: 'neighbors', label: 'Neighbors' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'logs', label: 'Logs' },
    ...(device.configEnabled ? [{ id: 'config', label: 'Config' }] : []),
  ];
  const currentTab = tabs.some((item) => item.id === tab) ? tab : 'interfaces';
  const otherAddresses = (device.addresses || []).filter((address) => address && address !== device.ip);
  const facts = [
    ['Description', device.sysDescr || '—'],
    ['Location', device.sysLocation || '—'],
    ['Contact', device.sysContact || '—'],
    ['Management', device.ip],
    ['Last discovered', device.discoveredAt ? formatWhen(device.discoveredAt) : '—'],
    ...(otherAddresses.length ? [['Other addresses', otherAddresses.join(', ')]] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/devices" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted">
          <ChevronLeft className="size-4" aria-hidden />
          Devices
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Button tone="line" onClick={discover} disabled={discovering}>{discovering ? 'Discovering…' : 'Discover device'}</Button>
          <Button asChild tone="line">
            <Link to={`/devices/${encodeURIComponent(ip)}/settings`}>
              <Settings className="size-4" />
              Device settings
            </Link>
          </Button>
        </div>
      </div>
      {discoverNote ? <p className="text-sm text-muted">{discoverNote}</p> : null}

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

      <div className="flex gap-2 overflow-x-auto">
        {tabs.map((item) => (
          <FilterChip key={item.id} active={currentTab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
          </FilterChip>
        ))}
      </div>

      {currentTab !== 'interfaces' ? <DeviceSection ip={ip} tab={currentTab} /> : selected.length === 0 ? (
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
    </div>
  );
}
