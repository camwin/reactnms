import { useEffect, useRef, useState } from 'react';
import { ApiError, fetchDiscoveryStatus, type DiscoveryStatus } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatAgo } from '@/lib/format';

export function DiscoveryRibbon() {
  const [job, setJob] = useState<DiscoveryStatus | null>(null);
  const [open, setOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);

  useEffect(() => {
    let cancel = false;
    let timer = 0;
    async function pull() {
      let wait = 4000;
      try {
        const next = await fetchDiscoveryStatus();
        if (!cancel) setJob(next);
        wait = next.running ? 1000 : 4000;
      } catch (err: unknown) {
        if (!cancel && err instanceof ApiError && err.status === 404) setJob(null);
        wait = 8000;
      }
      if (!cancel) timer = window.setTimeout(pull, wait);
    }
    pull();
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (job?.running && !wasRunning.current) setOpen(true);
    wasRunning.current = !!job?.running;
  }, [job?.running]);

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [open, job?.log.length]);

  if (!job || (!job.running && job.log.length === 0 && !job.lastRun)) return null;

  const summary = job.running
    ? `Discovering ${job.currentSubnet || '…'}${job.currentCredential ? ` · ${job.currentCredential}` : ''} · ${job.hostsScanned}/${job.hostsTotal || '…'} · ${job.found} found`
    : job.error
      ? `Discovery stopped · ${job.error}`
      : `Discovery idle · ${job.found} devices · ${formatAgo(job.lastRun)}`;

  return (
    <section className="sticky top-14 z-20 mb-4 rounded-xl border border-line bg-surface" aria-live="polite">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className={cn('size-1.5 shrink-0 rounded-full', job.running ? 'bg-accent live-dot' : job.error ? 'bg-down' : 'bg-faint')} aria-hidden />
        <p className={cn('min-w-0 flex-1 truncate font-mono text-xs', job.error && !job.running ? 'text-down' : 'text-muted')}>{summary}</p>
        {job.log.length > 0 ? (
          <button
            type="button"
            className="min-h-11 shrink-0 px-2 font-mono text-xs text-accent"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            {open ? 'Hide log' : 'Log'}
          </button>
        ) : null}
      </div>
      {open && job.log.length > 0 ? (
        <div ref={logRef} className="max-h-48 overflow-auto border-t border-line bg-bg px-3 py-2 font-mono text-xs leading-5 text-muted">
          {job.log.map((line, index) => (
            <div key={`${line.t}-${index}`} className={line.level === 'error' ? 'text-down' : undefined}>
              <span className="text-faint">{line.t.slice(11, 19)}</span> {line.message}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
