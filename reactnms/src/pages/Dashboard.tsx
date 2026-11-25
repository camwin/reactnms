import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Metric, Panel } from '@/components/nms/bits';
import { fetchAlertRules, fetchDiscoveryResults, type AlertRule, type DiscoveredDevice } from '@/lib/api';
import { formatAgo } from '@/lib/format';

export default function Dashboard() {
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);
  const [rules, setRules] = useState<AlertRule[]>([]);

  useEffect(() => {
    let cancel = false;
    fetchDiscoveryResults()
      .then((data) => {
        if (cancel) return;
        setDevices(data.results || []);
        setLastRun(data.lastRun);
      })
      .catch(() => {
        if (!cancel) setDevices([]);
      });
    fetchAlertRules()
      .then((data) => {
        if (!cancel) setRules(data);
      })
      .catch(() => {
        if (!cancel) setRules([]);
      });
    return () => {
      cancel = true;
    };
  }, []);

  const enabled = rules.filter((rule) => rule.enabled !== false).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-pretty text-muted">
          {devices.length} discovered devices · {enabled} enabled alert {enabled === 1 ? 'rule' : 'rules'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="Devices" value={String(devices.length)} hint="From the last discovery scan" />
        <Metric label="Alert rules" value={String(enabled)} hint={`${rules.length} defined`} />
        <Metric label="Last discovery" value={formatAgo(lastRun)} hint={lastRun ? 'Scan finished' : 'No scan yet'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Devices"
          action={
            <Link to="/devices" className="text-sm text-accent">
              All
            </Link>
          }
        >
          {devices.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">
              None discovered.{' '}
              <Link to="/discovery" className="text-accent">
                Run a scan
              </Link>
            </p>
          ) : (
            <ul>
              {devices.slice(0, 8).map((device) => (
                <li key={device.ip} className="border-b border-line last:border-b-0">
                  <Link to={`/devices/${encodeURIComponent(device.ip)}`} className="block px-4 py-3">
                    <span className="block truncate font-mono text-sm">{device.sysName || device.ip}</span>
                    <span className="mt-1 block truncate font-mono text-xs text-muted">{device.ip}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Alert rules"
          action={
            <Link to="/alerts" className="text-sm text-accent">
              All
            </Link>
          }
        >
          {rules.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">
              No rules.{' '}
              <Link to="/alerts" className="text-accent">
                Create one
              </Link>
            </p>
          ) : (
            <ul>
              {rules.slice(0, 5).map((rule) => (
                <li key={rule.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-sm font-medium">{rule.name}</span>
                    <span className={rule.enabled === false ? 'font-mono text-xs text-faint' : 'font-mono text-xs text-accent'}>
                      {rule.enabled === false ? 'Off' : 'On'}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted">
                    {rule.device} · {rule.metric} {rule.op === 'gt' ? '>' : '<'} {rule.threshold} {rule.unit}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
