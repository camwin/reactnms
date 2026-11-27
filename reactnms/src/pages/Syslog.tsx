import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fetchSyslog, type SyslogRow } from '@/lib/api';
import { formatWhen } from '@/lib/format';

const LEVELS = [
  { value: 'all', label: 'All severities' },
  { value: 'error', label: 'Error and above' },
  { value: '4', label: 'Warning' },
  { value: '5', label: 'Notice' },
  { value: '6', label: 'Info' },
  { value: '7', label: 'Debug' },
];

export default function SyslogPage() {
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState('all');
  const [rows, setRows] = useState<SyslogRow[]>([]);
  const [status, setStatus] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancel = false;
    const level = severity === 'all' ? '' : severity;
    fetchSyslog(query.trim(), level)
      .then((body) => {
        if (cancel) return;
        setRows(body.rows || []);
        setStatus(body.status || '');
        setEnabled(!!body.enabled);
        setNote('');
      })
      .catch((err: unknown) => {
        if (!cancel) setNote(err instanceof Error ? err.message : 'Could not load syslog');
      });
    return () => {
      cancel = true;
    };
  }, [query, severity]);

  const listening = status.startsWith('listening');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Syslog</h1>
        <p className="mt-1 text-sm text-muted">
          {listening ? status : 'The listener stays off until it is enabled in Settings.'}
          {enabled && !listening && status ? ` ${status}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Filter syslog" placeholder="Filter host, address, or message" value={query} onChange={(event) => setQuery(event.target.value)} className="w-72" />
        <Select ariaLabel="Severity" value={severity} onValueChange={setSeverity} options={LEVELS} />
        <Link to="/settings" className="text-sm text-accent">Syslog settings</Link>
      </div>
      {note ? <p className="text-sm text-down">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-sm text-muted">No syslog messages.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map((row) => (
            <li key={row.id} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-faint">{formatWhen(new Date(row.at).toISOString())}</span>
                <span className="font-mono text-xs uppercase tracking-widest text-muted">{row.severityName}</span>
                <Link to={`/devices/${encodeURIComponent(row.sourceIp)}`} className="font-mono text-xs text-accent">{row.host || row.sourceIp}</Link>
              </div>
              <p className="mt-1 text-sm">{row.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
