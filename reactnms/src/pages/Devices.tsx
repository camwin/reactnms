import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Search } from 'lucide-react';
import { fetchDiscoveryResults, type DiscoveredDevice } from '@/lib/api';

export default function Devices() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancel = false;
    fetchDiscoveryResults()
      .then((data) => {
        if (!cancel) setDevices(data.results || []);
      })
      .catch(() => {
        if (!cancel) setDevices([]);
      });
    return () => {
      cancel = true;
    };
  }, []);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return devices
      .filter((device) => {
        if (!needle) return true;
        return [device.sysName, device.ip, device.sysDescr].join(' ').toLowerCase().includes(needle);
      })
      .sort((a, b) => (a.sysName || a.ip).localeCompare(b.sysName || b.ip));
  }, [devices, query]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-1 text-sm text-muted">{rows.length} shown · from the last discovery scan</p>
      </div>

      <label className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface px-3">
        <Search className="size-4 text-faint" aria-hidden />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Hostname, IP, description"
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
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map((device) => (
            <li key={device.ip} className="border-b border-line last:border-b-0">
              <Link to={`/devices/${encodeURIComponent(device.ip)}`} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-sm">{device.sysName || device.ip}</span>
                  <span className="mt-1 block truncate text-sm text-muted">
                    {device.ip}
                    {device.sysDescr ? ` · ${device.sysDescr}` : ''}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
