import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { fetchCatalogSerials, fetchDiscoveryResults, type DiscoveredDevice, type SerialRow } from '@/lib/api';

function preview(device: DiscoveredDevice, serial: string) {
  const name = device.sysName && device.sysName !== device.ip ? device.sysName : device.ip;
  const detail = [device.ip, device.sysLocation].filter(Boolean).join(' · ');
  const software = serial ? '' : (device.sysDescr || '').split('\n')[0].trim();
  return { name, detail, software, serial };
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [serials, setSerials] = useState<SerialRow[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const [data, catalog] = await Promise.all([fetchDiscoveryResults(), fetchCatalogSerials()]);
        if (cancel) return;
        setDevices(data.results || []);
        setSerials(catalog.serials || []);
      } catch {
        if (!cancel) {
          setDevices([]);
          setSerials([]);
        }
      }
    }
    pull();
    const id = window.setInterval(pull, 15000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const matches = (() => {
    if (!needle) return [];
    const fromDevices = devices
      .map((device) => {
        const haystack = [device.sysName, device.ip, device.sysLocation, device.sysDescr].join(' ').toLowerCase();
        const serial = serials.find((row) => row.ip === device.ip && row.serial.toLowerCase().includes(needle))?.serial || '';
        return haystack.includes(needle) || serial ? { device, serial } : null;
      })
      .filter((item): item is { device: DiscoveredDevice; serial: string } => !!item);
    const seen = new Set(fromDevices.map((item) => item.device.ip));
    const extras = serials
      .filter((row) => row.serial.toLowerCase().includes(needle) && !seen.has(row.ip))
      .map((row) => ({ device: { ip: row.ip, sysName: row.name || row.ip }, serial: row.serial }));
    return [...fromDevices, ...extras].slice(0, 8);
  })();

  function go(ip: string) {
    setQuery('');
    setOpen(false);
    navigate(`/devices/${encodeURIComponent(ip)}`);
  }

  return (
    <div className="relative w-36 sm:w-72" ref={box}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
      <input
        aria-label="Search devices"
        placeholder="Search devices"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'Enter' && matches[0]) {
            event.preventDefault();
            go(matches[0].device.ip);
          }
        }}
        className="h-10 w-full rounded-lg border border-line bg-surface pl-8 pr-3 text-sm text-fg outline-none placeholder:text-faint"
      />
      {open && needle ? (
        <div className="absolute right-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-raised shadow-md">
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted">No devices</p>
          ) : (
            <ul>
              {matches.map(({ device, serial }) => {
                const item = preview(device, serial);
                return (
                  <li key={device.ip}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-2 text-left hover:bg-surface"
                      onClick={() => go(device.ip)}
                    >
                      <span className="max-w-full truncate font-mono text-sm">{item.name}</span>
                      <span className="max-w-full truncate text-xs text-muted">{item.detail}</span>
                      {item.serial ? <span className="max-w-full truncate font-mono text-xs text-faint">Serial {item.serial}</span> : null}
                      {item.software ? <span className="max-w-full truncate text-xs text-faint">{item.software}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
