import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { fetchAlertLog, type AlertLogLine } from '@/lib/api';
import { formatWhen } from '@/lib/format';

export default function AlertHistory() {
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<AlertLogLine[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const rows = await fetchAlertLog(query.trim(), 200);
        if (!cancel) {
          setLines(rows);
          setNote('');
        }
      } catch (err: unknown) {
        if (!cancel) setNote(err instanceof Error ? err.message : 'Could not load alert history');
      }
    }
    const timer = window.setTimeout(pull, 250);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="flex flex-col gap-4">
      <Link to="/alerts" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted">
        <ChevronLeft className="size-4" aria-hidden />
        Alerts
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alert history</h1>
        <p className="mt-1 text-sm text-muted">Opens, notifications, acknowledgements, and recoveries. Search matches the message, device, kind, or rule.</p>
      </div>
      <Input
        aria-label="Search alert history"
        placeholder="Search history"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="w-full max-w-sm"
      />
      {note ? <p className="text-sm text-down">{note}</p> : null}
      {lines.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">No matching history.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {lines.map((line) => (
            <li key={line.id} className="border-b border-line px-4 py-3 text-sm last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-faint">{formatWhen(new Date(line.at).toISOString())}</span>
                <span className="font-mono text-xs uppercase tracking-widest text-muted">{line.kind}</span>
                {line.deviceIp ? (
                  <Link to={`/devices/${encodeURIComponent(line.deviceIp)}`} className="font-mono text-xs text-accent">{line.deviceIp}</Link>
                ) : null}
              </div>
              <p className="mt-1">{line.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
