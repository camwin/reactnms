import { useEffect, useMemo, useState } from 'react';
import { FilterChip, Panel } from '@/components/nms/bits';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { OpticChart } from '@/components/optic-chart';
import {
  acknowledgeAlert,
  backupDeviceConfig,
  fetchActiveAlerts,
  fetchAlertLog,
  fetchDeviceConfig,
  fetchDeviceErrors,
  fetchDeviceInventory,
  fetchDeviceLogs,
  fetchDeviceNeighbors,
  fetchDeviceOptics,
  fetchDeviceRoutes,
  fetchDeviceVlans,
  type ActiveAlert,
  type AlertLogLine,
  type DeviceConfigBackup,
  type DeviceErrors,
  type DeviceEvent,
  type DeviceLogs,
  type DeviceOptics,
  type InventoryRow,
  type NeighborRow,
  type RouteRow,
  type VlanRow,
} from '@/lib/api';
import { formatEpoch, formatWhen } from '@/lib/format';

function Note({ children }: { children: string }) {
  return <p className="px-4 py-6 text-sm text-muted">{children}</p>;
}

export function RoutingSection({ ip }: { ip: string }) {
  const [rows, setRows] = useState<RouteRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancel = false;
    fetchDeviceRoutes(ip)
      .then((body) => {
        if (cancel) return;
        setRows(body.routes || []);
        setError(body.error || '');
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read routes');
      });
    return () => {
      cancel = true;
    };
  }, [ip]);
  if (!rows && !error) return <Note>Reading the route table…</Note>;
  if (error && !rows?.length) return <Note>{error}</Note>;
  if (!rows?.length) return <Note>No routes returned.</Note>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-line font-mono text-xs uppercase tracking-widest text-faint">
            <th className="px-4 py-2">Destination</th>
            <th className="px-4 py-2">Mask</th>
            <th className="px-4 py-2">Next hop</th>
            <th className="px-4 py-2">Interface</th>
            <th className="px-4 py-2">Protocol</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.dest}|${row.mask}|${row.nextHop}|${row.ifIndex}`} className="border-b border-line last:border-b-0">
              <td className="px-4 py-2 font-mono text-sm">{row.dest}</td>
              <td className="px-4 py-2 font-mono text-sm">{row.mask}</td>
              <td className="px-4 py-2 font-mono text-sm">{row.nextHop}</td>
              <td className="px-4 py-2 font-mono text-sm">{row.ifIndex}</td>
              <td className="px-4 py-2 font-mono text-sm">{row.proto}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AlertsSection({ ip }: { ip: string }) {
  const [activeOnly, setActiveOnly] = useState(false);
  const [history, setHistory] = useState<AlertLogLine[] | null>(null);
  const [rows, setRows] = useState<ActiveAlert[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancel = false;
    setError('');
    const load = activeOnly
      ? fetchActiveAlerts().then((alerts) => {
          if (!cancel) setRows(alerts.filter((alert) => alert.deviceIp === ip));
        })
      : fetchAlertLog('', 200, ip).then((lines) => {
          if (!cancel) setHistory(lines);
        });
    load.catch((err: unknown) => {
      if (!cancel) setError(err instanceof Error ? err.message : 'Could not load alerts');
    });
    return () => {
      cancel = true;
    };
  }, [ip, reload, activeOnly]);
  const waiting = activeOnly ? !rows && !error : !history && !error;
  return (
    <div>
      <label className="inline-flex min-h-11 items-center gap-2 px-4 text-sm">
        <Checkbox checked={activeOnly} onCheckedChange={(checked) => setActiveOnly(checked === true)} />
        Active alerts
      </label>
      {waiting ? <Note>Loading alerts…</Note> : null}
      {error ? <Note>{error}</Note> : null}
      {!waiting && !error && activeOnly && !rows?.length ? <Note>No active alerts for this device.</Note> : null}
      {!waiting && !error && !activeOnly && !history?.length ? <Note>No alert history for this device.</Note> : null}
      {!error && activeOnly && rows?.length ? (
        <ul>
          {rows.map((alert) => (
            <li key={alert.id} className="border-b border-line px-4 py-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs uppercase text-faint">{alert.severity}</span>
                <strong className="text-sm">{alert.message}</strong>
              </div>
              <p className="mt-1 text-sm text-muted">Since {formatEpoch(alert.startedAt)}{alert.muted ? ' · muted' : ''}</p>
              {alert.ackMode ? <p className="mt-1 text-sm text-muted">Acknowledged until {alert.ackMode === 'clear' ? 'clear' : 'the metric worsens'}</p> : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button tone="line" onClick={() => acknowledgeAlert(alert.id, 'clear').then(() => setReload((value) => value + 1)).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ack failed'))}>
                    Acknowledge until clear
                  </Button>
                  <Button tone="line" onClick={() => acknowledgeAlert(alert.id, 'worsens').then(() => setReload((value) => value + 1)).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ack failed'))}>
                    Acknowledge until metric worsens
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {!error && !activeOnly && history?.length ? (
        <ul>
          {history.map((line) => (
            <li key={line.id} className="border-b border-line px-4 py-3 text-sm last:border-b-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-faint">{formatWhen(new Date(line.at).toISOString())}</span>
                <span className="font-mono text-xs uppercase tracking-widest text-muted">{line.kind}</span>
              </div>
              <p className="mt-1">{line.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function VlanSection({ ip }: { ip: string }) {
  const [rows, setRows] = useState<VlanRow[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    let cancel = false;
    fetchDeviceVlans(ip)
      .then((body) => {
        if (cancel) return;
        setRows(body.vlans || []);
        setError(body.error || '');
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read VLANs');
      });
    return () => {
      cancel = true;
    };
  }, [ip]);
  if (!rows && !error) return <Note>Reading VLANs…</Note>;
  if (error && !rows?.length) return <Note>{error}</Note>;
  if (!rows?.length) return <Note>No VLANs returned.</Note>;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? rows.filter((vlan) => vlan.id.toLowerCase().includes(needle) || vlan.name.toLowerCase().includes(needle))
    : rows;
  return (
    <div>
      <div className="border-b border-line px-4 py-3">
        <Input aria-label="Search VLANs" placeholder="Search VLAN ID or name" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {shown.length === 0 ? <Note>No VLANs match.</Note> : (
        <ul>
          {shown.map((vlan) => (
            <li key={`${vlan.source}|${vlan.id}`} className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2 last:border-b-0">
              <span className="font-mono text-sm">{vlan.id}{vlan.name ? ` · ${vlan.name}` : ''}</span>
              <span className="font-mono text-xs uppercase text-faint">{vlan.source}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function NeighborsSection({ ip }: { ip: string }) {
  const [cdp, setCdp] = useState<NeighborRow[]>([]);
  const [lldp, setLldp] = useState<NeighborRow[]>([]);
  const [flags, setFlags] = useState({ cdpOk: true, lldpOk: true });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [protocol, setProtocol] = useState<'all' | 'cdp' | 'lldp'>('all');
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    fetchDeviceNeighbors(ip, reload > 0)
      .then((body) => {
        if (cancel) return;
        setCdp(body.cdp || []);
        setLldp(body.lldp || []);
        setFlags({ cdpOk: body.cdpOk, lldpOk: body.lldpOk });
        setError(body.error || '');
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read neighbors');
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [ip, reload]);

  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = [
      ...(protocol === 'lldp' ? [] : cdp.map((row) => ({ ...row, protocol: 'cdp' }))),
      ...(protocol === 'cdp' ? [] : lldp.map((row) => ({ ...row, protocol: 'lldp' }))),
    ];
    if (!needle) return list;
    return list.filter((row) => `${row.remoteName} ${row.remotePort} ${row.remoteAddr} ${row.localIf}`.toLowerCase().includes(needle));
  }, [cdp, lldp, protocol, needle]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <FilterChip active={protocol === 'all'} onClick={() => setProtocol('all')}>All</FilterChip>
        <FilterChip active={protocol === 'cdp'} onClick={() => setProtocol('cdp')}>CDP</FilterChip>
        <FilterChip active={protocol === 'lldp'} onClick={() => setProtocol('lldp')}>LLDP</FilterChip>
        <Input aria-label="Filter neighbors" placeholder="Filter name, port, or address" value={query} onChange={(event) => setQuery(event.target.value)} className="w-64" />
        <Button tone="line" onClick={() => setReload((value) => value + 1)}>Refresh</Button>
      </div>
      {loading ? <Note>Reading CDP and LLDP…</Note> : null}
      {!loading && error ? <Note>{error}</Note> : null}
      {!loading && !error && !flags.cdpOk && !flags.lldpOk ? <Note>Neither CDP nor LLDP answered.</Note> : null}
      {!loading && !rows.length && (flags.cdpOk || flags.lldpOk) ? <Note>No neighbors match.</Note> : null}
      {rows.length ? (
        <ul>
          {rows.map((row, index) => (
            <li key={`${row.protocol}|${row.localIf}|${row.remoteName}|${row.remotePort}|${index}`} className="border-b border-line px-4 py-2 last:border-b-0">
              <span className="font-mono text-xs uppercase text-faint">{row.protocol}</span>{' '}
              <span className="font-mono text-sm">{row.remoteName || row.remoteAddr || 'unknown'}</span>
              <span className="text-sm text-muted">
                {row.remotePort ? ` port ${row.remotePort}` : ''}
                {row.localIf ? ` · local ${row.localIf}` : ''}
                {row.remoteAddr ? ` · ${row.remoteAddr}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function InventorySection({ ip }: { ip: string }) {
  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancel = false;
    fetchDeviceInventory(ip)
      .then((body) => {
        if (cancel) return;
        setRows(body.rows || []);
        setError(body.error || '');
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read inventory');
      });
    return () => {
      cancel = true;
    };
  }, [ip]);
  if (!rows && !error) return <Note>Reading inventory…</Note>;
  if (error && !rows?.length) return <Note>{error}</Note>;
  if (!rows?.length) return <Note>No inventory rows returned.</Note>;
  return (
    <ul>
      {rows.map((row, index) => (
        <li key={`${row.serial}|${row.name}|${index}`} className="border-b border-line px-4 py-3 last:border-b-0">
          <strong className="font-mono text-sm">{row.name || row.descr || 'component'}</strong>
          <p className="mt-1 text-sm text-muted">
            {[row.manufacturer, row.model, row.serial ? `S/N ${row.serial}` : ''].filter(Boolean).join(' · ') || row.descr}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function LogsSection({ ip }: { ip: string }) {
  const [logs, setLogs] = useState<DeviceLogs | null>(null);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'all' | 'events' | 'syslog'>('all');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    let cancel = false;
    fetchDeviceLogs(ip, query)
      .then((body) => {
        if (!cancel) setLogs(body);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not load logs');
      });
    return () => {
      cancel = true;
    };
  }, [ip, query]);
  const events = kind === 'syslog' ? [] : logs?.events || [];
  const syslog = kind === 'events' ? [] : logs?.syslog || [];
  const rows = [
    ...events.map((event) => ({ id: `e${event.id}`, at: event.at, label: `event · ${event.kind}`, text: event.summary, who: '' })),
    ...syslog.map((row) => ({ id: `s${row.id}`, at: row.at, label: `syslog · ${row.severityName}`, text: row.message, who: row.host || row.sourceIp })),
  ].sort((a, b) => b.at - a.at);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <FilterChip active={kind === 'all'} onClick={() => setKind('all')}>All</FilterChip>
        <FilterChip active={kind === 'events'} onClick={() => setKind('events')}>Events</FilterChip>
        <FilterChip active={kind === 'syslog'} onClick={() => setKind('syslog')}>Syslog</FilterChip>
        <Input aria-label="Filter logs" placeholder="Search logs" value={draft} onChange={(event) => setDraft(event.target.value)} className="w-64" />
      </div>
      {error ? <Note>{error}</Note> : null}
      {!logs && !error ? <Note>Loading logs…</Note> : null}
      {logs && !rows.length ? <Note>No matching logs.</Note> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="border-b border-line px-4 py-2 last:border-b-0">
            <span className="font-mono text-xs uppercase text-faint">{row.label}</span>
            {row.who ? <span className="ml-2 font-mono text-sm">{row.who}</span> : null}
            <span className="ml-2 text-sm">{row.text}</span>
            <span className="ml-2 text-sm text-muted">{formatEpoch(row.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ConfigSection({ ip }: { ip: string }) {
  const [config, setConfig] = useState<DeviceConfigBackup | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let cancel = false;
    fetchDeviceConfig(ip)
      .then((body) => {
        if (!cancel) setConfig(body);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not load the saved config');
      });
    return () => {
      cancel = true;
    };
  }, [ip]);

  async function backup() {
    setRunning(true);
    setError('');
    try {
      const body = await backupDeviceConfig(ip);
      setConfig(body);
      if (!body.ok && body.error) setError(body.error);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <Button tone="solid" onClick={backup} disabled={running}>{running ? 'Backing up…' : 'Back up now'}</Button>
        <span className="text-sm text-muted">
          {config?.deviceType ? `Device type ${config.deviceType}. ` : ''}
          {config?.savedAt ? `Saved ${formatEpoch(config.savedAt)}.` : 'No backup stored yet.'}
        </span>
      </div>
      {error ? <Note>{error}</Note> : null}
      {!config && !error ? <Note>Loading the saved configuration…</Note> : null}
      {config?.body ? (
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs">{config.body}</pre>
      ) : null}
    </div>
  );
}

function EventList({ rows }: { rows: DeviceEvent[] }) {
  if (!rows.length) return null;
  return (
    <ul>
      {rows.map((event) => (
        <li key={event.id} className="border-b border-line px-4 py-3 text-sm last:border-b-0">
          <div className="font-mono text-xs text-faint">{formatWhen(new Date(event.at).toISOString())}</div>
          <p className="mt-1">{event.summary}</p>
        </li>
      ))}
    </ul>
  );
}

export function ErrorsSection({ ip }: { ip: string }) {
  const [body, setBody] = useState<DeviceErrors | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancel = false;
    fetchDeviceErrors(ip)
      .then((next) => {
        if (!cancel) setBody(next);
      })
      .catch((err: unknown) => {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read errors');
      });
    return () => {
      cancel = true;
    };
  }, [ip]);
  if (!body && !error) return <Note>Reading errors…</Note>;
  if (error && !body) return <Note>{error}</Note>;
  if (!body) return null;
  const empty = !body.interfaces.length && !body.syslog.length && !body.reachability.length && !body.link.length && !body.switching.length;
  return (
    <div className="flex flex-col gap-4 py-3">
      {body.error ? <p className="px-4 text-sm text-down">{body.error}</p> : null}
      {empty ? <Note>No interface, syslog, reachability, link, or spanning-tree errors.</Note> : null}
      {body.interfaces.length ? (
        <section>
          <h3 className="px-4 font-mono text-xs uppercase tracking-widest text-faint">Interface</h3>
          <ul>
            {body.interfaces.map((row) => (
              <li key={row.index} className="border-b border-line px-4 py-2 text-sm">
                <span className="font-mono">{row.name}</span>
                <span className="mt-1 block text-muted">
                  In errors {row.inErrors.toLocaleString()} · In discards {row.inDiscards.toLocaleString()} · Out errors {row.outErrors.toLocaleString()} · Out discards {row.outDiscards.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {body.syslog.length ? (
        <section>
          <h3 className="px-4 font-mono text-xs uppercase tracking-widest text-faint">Syslog</h3>
          <ul>
            {body.syslog.map((row) => (
              <li key={row.id} className="border-b border-line px-4 py-2 text-sm">
                <span className="font-mono text-xs uppercase text-down">{row.severityName}</span>
                <span className="ml-2 text-muted">{row.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {body.reachability.length ? <section><h3 className="px-4 font-mono text-xs uppercase tracking-widest text-faint">Reachability</h3><EventList rows={body.reachability} /></section> : null}
      {body.link.length ? <section><h3 className="px-4 font-mono text-xs uppercase tracking-widest text-faint">Link</h3><EventList rows={body.link} /></section> : null}
      {body.switching.length ? <section><h3 className="px-4 font-mono text-xs uppercase tracking-widest text-faint">Switching</h3><EventList rows={body.switching} /></section> : null}
    </div>
  );
}

export function OpticsSection({ ip }: { ip: string }) {
  const [body, setBody] = useState<DeviceOptics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancel = false;
    async function pull() {
      try {
        const next = await fetchDeviceOptics(ip);
        if (!cancel) {
          setBody(next);
          setError(next.error || '');
        }
      } catch (err: unknown) {
        if (!cancel) setError(err instanceof Error ? err.message : 'Could not read optics');
      }
    }
    pull();
    const id = window.setInterval(pull, 30000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [ip]);
  if (!body && !error) return <Note>Reading optical levels…</Note>;
  if (error && !body?.optics.length) return <Note>{error}</Note>;
  const names = body?.optics.map((optic) => optic.name) || [];
  return (
    <div className="flex flex-col gap-3 py-3">
      {names.map((name) => {
        const points = (body?.history || []).filter((sample) => sample.name === name).map((sample) => ({ t: sample.t, rx: sample.rx, tx: sample.tx }));
        const current = body?.optics.find((optic) => optic.name === name);
        return (
          <section key={name} className="px-4">
            <h3 className="font-mono text-sm">{name}</h3>
            <p className="mt-1 font-mono text-xs text-muted">
              Rx {current?.rx == null ? '—' : `${current.rx.toFixed(2)} dBm`} · Tx {current?.tx == null ? '—' : `${current.tx.toFixed(2)} dBm`}
            </p>
            {points.length < 2 ? <p className="mt-2 text-sm text-muted">Collecting data… ({points.length}/2)</p> : <OpticChart points={points} />}
          </section>
        );
      })}
    </div>
  );
}

export function DeviceSection({ ip, tab }: { ip: string; tab: string }) {
  if (tab === 'routing') return <Panel title="Routing"><RoutingSection ip={ip} /></Panel>;
  if (tab === 'alerts') return <Panel title="Alerts"><AlertsSection ip={ip} /></Panel>;
  if (tab === 'errors') return <Panel title="Errors"><ErrorsSection ip={ip} /></Panel>;
  if (tab === 'optics') return <Panel title="Optics"><OpticsSection ip={ip} /></Panel>;
  if (tab === 'vlans') return <Panel title="VLANs"><VlanSection ip={ip} /></Panel>;
  if (tab === 'neighbors') return <Panel title="Neighbors"><NeighborsSection ip={ip} /></Panel>;
  if (tab === 'inventory') return <Panel title="Inventory"><InventorySection ip={ip} /></Panel>;
  if (tab === 'logs') return <Panel title="Logs"><LogsSection ip={ip} /></Panel>;
  if (tab === 'config') return <Panel title="Config"><ConfigSection ip={ip} /></Panel>;
  return null;
}
