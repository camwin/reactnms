import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fetchDiscoveryResults, fetchEvents, type DeviceEvent, type DiscoveredDevice } from '@/lib/api';
import { formatWhen } from '@/lib/format';

const ALL = '__all__';

function deviceLabel(device: DiscoveredDevice) {
  return device.sysName && device.sysName !== device.ip ? `${device.sysName} · ${device.ip}` : device.ip;
}

export default function Events() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [device, setDevice] = useState(ALL);
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<DeviceEvent[]>([]);
  const [note, setNote] = useState('');

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

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const rows = await fetchEvents(device === ALL ? '' : device, query.trim(), 200);
        if (!cancel) {
          setEvents(rows);
          setNote('');
        }
      } catch (err: unknown) {
        if (!cancel) setNote(err instanceof Error ? err.message : 'Could not load events');
      }
    }
    const timer = window.setTimeout(pull, 250);
    const id = window.setInterval(pull, 15000);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
      window.clearInterval(id);
    };
  }, [device, query]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
        <p className="mt-1 text-sm text-muted">
          Operational changes seen between polls: interface state, spanning-tree, neighbors, reachability, and identity. The first observation of a device is a baseline.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          ariaLabel="Device filter"
          value={device}
          onValueChange={setDevice}
          options={[{ value: ALL, label: 'All devices' }, ...devices.map((item) => ({ value: item.ip, label: deviceLabel(item) }))]}
        />
        <Input
          aria-label="Search events"
          placeholder="Search events"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full max-w-sm"
        />
      </div>
      {note ? <p className="text-sm text-down">{note}</p> : null}
      {events.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">No matching events.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {events.map((event) => (
            <li key={event.id} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link to={`/devices/${encodeURIComponent(event.deviceIp)}`} className="font-mono text-sm text-accent">
                  {event.hostname || event.deviceIp}
                </Link>
                <span className="font-mono text-xs text-faint">{formatWhen(new Date(event.at).toISOString())}</span>
              </div>
              <p className="mt-1 text-sm">{event.summary}</p>
              <p className="mt-1 font-mono text-xs uppercase tracking-widest text-muted">{event.kind}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
