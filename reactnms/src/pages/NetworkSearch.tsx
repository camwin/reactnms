import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fetchNetworkSearch, type NetworkSearchRow } from '@/lib/api';

const KINDS = [
  { value: 'vlan', label: 'VLAN' },
  { value: 'ip', label: 'IP address' },
  { value: 'serial', label: 'Serial number' },
];

function deviceName(row: NetworkSearchRow) {
  return row.hostname && row.hostname !== row.ip ? row.hostname : row.ip;
}

export default function NetworkSearch() {
  const [kind, setKind] = useState('vlan');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<NetworkSearchRow[]>([]);
  const [note, setNote] = useState('');
  const [searched, setSearched] = useState(false);

  function run() {
    const q = query.trim();
    if (!q) return;
    setNote('');
    fetchNetworkSearch(kind, q)
      .then((body) => {
        setRows(body.rows || []);
        setSearched(true);
        if (body.catalogEmpty && kind === 'vlan') {
          setNote('VLAN results appear after a device VLAN tab is opened or the background read.');
        } else if (body.catalogEmpty && kind === 'serial') {
          setNote('Serial results appear after a device inventory tab is opened or the background read.');
        } else if (!(body.rows || []).length) {
          setNote('No matches.');
        }
      })
      .catch((err: unknown) => {
        setRows([]);
        setSearched(true);
        setNote(err instanceof Error ? err.message : 'Search failed');
      });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Network Search</h1>
        <p className="mt-1 text-sm text-muted">Search VLAN IDs, management and discovered addresses, and serial numbers.</p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        <Select ariaLabel="Search kind" value={kind} onValueChange={setKind} options={KINDS} />
        <Input
          aria-label="Network search"
          placeholder={kind === 'vlan' ? 'VLAN ID or name' : kind === 'serial' ? 'Serial number' : 'IP address'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-72"
        />
        <Button type="submit" tone="solid">Search</Button>
      </form>
      {note ? <p className="text-sm text-muted">{note}</p> : null}
      {searched && rows.length ? (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map((row, index) => (
            <li key={`${row.ip}|${row.id || ''}|${row.serial || ''}|${row.match || ''}|${index}`} className="border-b border-line px-4 py-3 last:border-b-0">
              <Link to={`/devices/${encodeURIComponent(row.ip)}`} className="font-mono text-sm text-accent">
                {deviceName(row)}
              </Link>
              <p className="mt-1 text-sm text-muted">
                {row.ip}
                {kind === 'vlan' ? ` · VLAN ${row.id || ''}${row.name ? ` ${row.name}` : ''}` : ''}
                {kind === 'ip' && row.match && row.match !== row.ip ? ` · ${row.match}` : ''}
                {kind === 'ip' && row.location ? ` · ${row.location}` : ''}
                {kind === 'serial' ? ` · ${row.serial || ''}${row.model ? ` · ${row.model}` : ''}` : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
