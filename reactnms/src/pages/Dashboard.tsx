import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Metric, Panel } from '@/components/nms/bits';
import { fetchActiveAlerts, fetchDiscoveryResults, fetchEvents, type ActiveAlert, type DeviceEvent, type DiscoveredDevice } from '@/lib/api';
import { formatAgo, formatWhen, interfaceLabel } from '@/lib/format';
import { cn } from '@/lib/cn';

function severityClass(severity: string) {
  if (severity === 'critical') return 'text-down';
  if (severity === 'warning') return 'text-warn';
  return 'text-accent';
}

export default function Dashboard() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<ActiveAlert[]>([]);
  const [events, setEvents] = useState<DeviceEvent[]>([]);

  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const data = await fetchDiscoveryResults();
        if (cancel) return;
        setDevices(data.results || []);
        setLastRun(data.lastRun);
      } catch {
        if (!cancel) setDevices([]);
      }
      try {
        const rows = await fetchActiveAlerts();
        if (!cancel) setAlerts(rows);
      } catch {
        if (!cancel) setAlerts([]);
      }
      try {
        const rows = await fetchEvents('', '', 8);
        if (!cancel) setEvents(rows);
      } catch {
        if (!cancel) setEvents([]);
      }
    }
    pull();
    const id = window.setInterval(pull, 15000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, []);

  const unacked = alerts.filter((alert) => !alert.ackedAt).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-pretty text-muted">
          {devices.length} discovered devices · {alerts.length} active {alerts.length === 1 ? 'alert' : 'alerts'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="Devices" value={String(devices.length)} hint="From the last discovery scan" />
        <Metric label="Active alerts" value={String(alerts.length)} hint={unacked ? `${unacked} unacknowledged` : 'None waiting'} />
        <Metric label="Last discovery" value={formatAgo(lastRun)} hint={lastRun ? 'Scan finished' : 'No scan yet'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Device events"
          action={
            <Link to="/events" className="text-sm text-accent">
              All
            </Link>
          }
        >
          {events.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">
              No operational changes yet. Interface, spanning-tree, neighbor, and reachability changes appear after the poller has a baseline.
            </p>
          ) : (
            <ul>
              {events.map((event) => (
                <li key={event.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link to={`/devices/${encodeURIComponent(event.deviceIp)}`} className="truncate font-mono text-sm text-accent">
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
        </Panel>

        <Panel
          title="Active alerts"
          action={
            <Link to="/alerts" className="text-sm text-accent">
              All
            </Link>
          }
        >
          {alerts.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No active alerts.</p>
          ) : (
            <ul>
              {alerts.slice(0, 8).map((alert) => {
                const iface = interfaceLabel(alert.ifName, alert.ifAlias);
                return (
                  <li key={alert.id} className="border-b border-line px-4 py-3 last:border-b-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn('font-mono text-xs uppercase tracking-widest', severityClass(alert.severity))}>{alert.severity}</span>
                      {alert.muted ? <span className="font-mono text-xs text-faint">Muted</span> : null}
                      {alert.ackMode ? <span className="font-mono text-xs text-muted">Acked</span> : null}
                    </div>
                    <p className="mt-1 text-sm">{alert.message || alert.ruleName}</p>
                    <p className="mt-1 font-mono text-xs text-muted">
                      <Link to={`/devices/${encodeURIComponent(alert.deviceIp)}`} className="text-accent">{alert.hostname || alert.deviceIp}</Link>
                      {iface ? ` · ${iface}` : ''}
                      {alert.startedAt ? ` · since ${formatWhen(new Date(alert.startedAt).toISOString())}` : ''}
                    </p>
                    {alert.procedureUrl ? (
                      <a href={alert.procedureUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center text-sm text-accent">
                        Procedure
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
