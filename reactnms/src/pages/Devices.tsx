import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchDiscoveryResults, fetchDiscoveryStatus, type DiscoveredDevice } from '@/lib/api';
import { formatAgo, formatWhen } from '@/lib/format';

const PAGE_SIZE = 25;

type SortKey = 'hostname' | 'ip' | 'software' | 'location' | 'discovered';
type SortDir = 'asc' | 'desc';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'hostname', label: 'Hostname' },
  { key: 'ip', label: 'IP' },
  { key: 'software', label: 'OS / software' },
  { key: 'location', label: 'Location' },
  { key: 'discovered', label: 'Last discovered' },
];

function hostname(device: DiscoveredDevice) {
  return device.sysName || device.ip;
}

function software(device: DiscoveredDevice) {
  return (device.sysDescr || '').split('\n')[0].trim();
}

function ipKey(ip: string) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return ip;
  return parts.map((part) => String(part).padStart(3, '0')).join('.');
}

function compareText(a: string, b: string, dir: SortDir) {
  const aBlank = a.trim() === '';
  const bBlank = b.trim() === '';
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  const base = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? base : -base;
}

function compareDiscovered(a: string | undefined, b: string | undefined, dir: SortDir) {
  const at = a ? Date.parse(a) : Number.NaN;
  const bt = b ? Date.parse(b) : Number.NaN;
  const aBad = Number.isNaN(at);
  const bBad = Number.isNaN(bt);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  const base = at - bt;
  return dir === 'asc' ? base : -base;
}

export default function Devices() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [running, setRunning] = useState(false);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('hostname');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancel = false;
    let timer = 0;
    async function pull() {
      let wait = 15000;
      try {
        const data = await fetchDiscoveryResults();
        if (cancel) return;
        setDevices(data.results || []);
      } catch {
        /* keep the list already on screen */
      }
      try {
        const status = await fetchDiscoveryStatus();
        if (cancel) return;
        setRunning(status.running);
        wait = status.running ? 3000 : 15000;
      } catch {
        if (!cancel) setRunning(false);
      }
      if (!cancel) timer = window.setTimeout(pull, wait);
    }
    pull();
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = devices.filter((device) => {
      if (!needle) return true;
      return [hostname(device), device.ip, software(device), device.sysLocation].join(' ').toLowerCase().includes(needle);
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortKey === 'hostname') return compareText(hostname(a), hostname(b), sortDir);
      if (sortKey === 'ip') return compareText(ipKey(a.ip), ipKey(b.ip), sortDir);
      if (sortKey === 'software') return compareText(software(a), software(b), sortDir);
      if (sortKey === 'location') return compareText(a.sysLocation || '', b.sysLocation || '', sortDir);
      return compareDiscovered(a.discoveredAt, b.discoveredAt, sortDir);
    });
    return sorted;
  }, [devices, query, sortKey, sortDir]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = rows.length === 0 ? 0 : safePage * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  function onSort(key: SortKey) {
    setPage(0);
    if (sortKey === key) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-1 text-sm text-muted">
          {rows.length} shown
          {running ? ' · discovery is still running' : ''}
        </p>
      </div>

      <label className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3">
        <Search className="size-4 text-faint" aria-hidden />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder="Hostname, IP, software, location"
          className="h-11 w-full bg-transparent font-mono text-sm text-fg outline-none placeholder:text-faint"
        />
      </label>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-sm text-muted">
          {devices.length === 0 ? (
            <>
              No devices yet.{' '}
              <Link to="/discovery" className="text-accent">
                Run discovery
              </Link>
            </>
          ) : (
            'Nothing matches that search.'
          )}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[52rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  {COLUMNS.map((column) => (
                    <th key={column.key} scope="col" aria-sort={sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-4">
                      <button
                        type="button"
                        onClick={() => onSort(column.key)}
                        className="inline-flex min-h-11 items-center gap-1 font-mono text-xs uppercase tracking-widest text-faint"
                      >
                        {column.label}
                        {sortKey === column.key ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((device) => (
                  <tr
                    key={device.ip}
                    className="cursor-pointer border-b border-line last:border-b-0 hover:bg-raised"
                    onClick={() => navigate(`/devices/${encodeURIComponent(device.ip)}`)}
                  >
                    <td className="px-4 py-3">
                      <Link to={`/devices/${encodeURIComponent(device.ip)}`} className="font-mono text-sm" onClick={(event) => event.stopPropagation()}>
                        {hostname(device)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm text-muted">{device.ip}</td>
                    <td className="max-w-xs truncate px-4 py-3 text-sm text-muted" title={device.sysDescr || undefined}>
                      {software(device) || '—'}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-sm text-muted">{device.sysLocation || '—'}</td>
                    <td className="px-4 py-3 text-sm text-muted" title={device.discoveredAt ? formatWhen(device.discoveredAt) : undefined}>
                      {formatAgo(device.discoveredAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {start + 1}–{start + pageRows.length} of {rows.length}
            </p>
            <div className="flex gap-2">
              <Button tone="line" onClick={() => setPage(safePage - 1)} disabled={safePage === 0}>
                Previous
              </Button>
              <Button tone="line" onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1}>
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
