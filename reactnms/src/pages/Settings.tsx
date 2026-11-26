import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/nms/bits';
import { NetboxChoiceField } from '@/components/nms/netbox-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  DEVICE_TYPE_CHOICES,
  fetchDiscoveryConfig,
  fetchNetboxOptions,
  fetchPoller,
  saveDiscoveryConfig,
  saveServiceAccount,
  saveSyslog,
  type DeviceTypeChoice,
  type NetboxChoice,
  type PollerSummary,
  type SnmpCredential,
} from '@/lib/api';
import { formatDuration, formatEpoch, formatWhen } from '@/lib/format';

export default function Settings() {
  const [netboxUrl, setNetboxUrl] = useState('');
  const [netboxToken, setNetboxToken] = useState('');
  const [netboxTag, setNetboxTag] = useState('');
  const [netboxRole, setNetboxRole] = useState('');
  const [netboxRegion, setNetboxRegion] = useState('');
  const [regions, setRegions] = useState<NetboxChoice[]>([]);
  const [roles, setRoles] = useState<NetboxChoice[]>([]);
  const [tags, setTags] = useState<NetboxChoice[]>([]);
  const [catalog, setCatalog] = useState('');
  const [credentials, setCredentials] = useState<SnmpCredential[]>([]);
  const [status, setStatus] = useState('');
  const [credName, setCredName] = useState('');
  const [credVersion, setCredVersion] = useState<'2c' | '3'>('2c');
  const [credCommunity, setCredCommunity] = useState('public');
  const [credUser, setCredUser] = useState('');
  const [credAuth, setCredAuth] = useState('');
  const [credPriv, setCredPriv] = useState('');
  const [ignoreText, setIgnoreText] = useState('');
  const [poller, setPoller] = useState<PollerSummary | null>(null);
  const [accountEnabled, setAccountEnabled] = useState(false);
  const [accountUser, setAccountUser] = useState('');
  const [accountType, setAccountType] = useState('cisco_ios');
  const [accountCustom, setAccountCustom] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountEnable, setAccountEnable] = useState('');
  const [clearEnable, setClearEnable] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);
  const [enableSet, setEnableSet] = useState(false);
  const [deviceTypes, setDeviceTypes] = useState<DeviceTypeChoice[]>(DEVICE_TYPE_CHOICES);
  const [accountNote, setAccountNote] = useState('');
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupCron, setBackupCron] = useState('0 2 * * *');
  const [backupLastRun, setBackupLastRun] = useState<string | null>(null);
  const [backupLastError, setBackupLastError] = useState('');
  const [syslogEnabled, setSyslogEnabled] = useState(false);
  const [syslogPort, setSyslogPort] = useState('5514');
  const [syslogDays, setSyslogDays] = useState('14');
  const [syslogRows, setSyslogRows] = useState('100000');
  const [syslogStatus, setSyslogStatus] = useState('stopped');
  const [syslogNote, setSyslogNote] = useState('');

  useEffect(() => {
    let cancel = false;
    fetchDiscoveryConfig()
      .then((cfg) => {
        if (cancel) return;
        setNetboxUrl(cfg.netbox?.url || '');
        setNetboxToken(cfg.netbox?.token || '');
        setNetboxTag(cfg.netbox?.tag || '');
        setNetboxRole(cfg.netbox?.role || '');
        setNetboxRegion(cfg.netbox?.region || '');
        setCredentials(cfg.credentials || []);
        setIgnoreText((cfg.interfaceIgnore || []).join('\n'));
        const account = cfg.serviceAccount;
        if (account) {
          const choices = account.deviceTypes?.length ? account.deviceTypes : DEVICE_TYPE_CHOICES;
          setDeviceTypes(choices);
          const known = new Set(choices.map((item) => item.id).filter((id) => id !== 'other'));
          setAccountEnabled(!!account.enabled);
          setAccountUser(account.username || '');
          setPasswordSet(!!account.passwordSet);
          setEnableSet(!!account.enableSet);
          if (known.has(account.deviceType)) {
            setAccountType(account.deviceType);
            setAccountCustom('');
          } else {
            setAccountType('other');
            setAccountCustom(account.deviceType || '');
          }
        }
        if (cfg.backupSchedule) {
          setBackupEnabled(!!cfg.backupSchedule.enabled);
          setBackupCron(cfg.backupSchedule.cron || '0 2 * * *');
          setBackupLastRun(cfg.backupSchedule.lastRun || null);
          setBackupLastError(cfg.backupSchedule.lastError || '');
        }
        if (cfg.syslog) {
          setSyslogEnabled(!!cfg.syslog.enabled);
          setSyslogPort(String(cfg.syslog.port || 5514));
          setSyslogDays(String(cfg.syslog.retainDays || 14));
          setSyslogRows(String(cfg.syslog.maxRows || 100000));
          setSyslogStatus(cfg.syslog.status || 'stopped');
        }
        if (cfg.netbox?.url && cfg.netbox?.token) {
          loadFields(cfg.netbox.url, cfg.netbox.token);
        }
      })
      .catch(() => {
        if (!cancel) setStatus('Could not load settings');
      });
    return () => {
      cancel = true;
    };
  }, []);

  async function loadFields(url = netboxUrl, token = netboxToken) {
    if (!url.trim() || !token.trim()) {
      setCatalog('Enter the NetBox URL and API token to load regions, roles, and tags.');
      return;
    }
    setCatalog('Loading NetBox fields…');
    try {
      const options = await fetchNetboxOptions({ url: url.trim(), token: token.trim() });
      setRegions(options.regions);
      setRoles(options.roles);
      setTags(options.tags);
      setCatalog(`Loaded ${options.regions.length} regions, ${options.roles.length} roles, ${options.tags.length} tags.`);
    } catch (err: unknown) {
      setCatalog(err instanceof Error ? err.message : 'Could not load NetBox fields');
    }
  }

  async function save() {
    setStatus('Saving…');
    try {
      const netbox = { url: netboxUrl, token: netboxToken, tag: netboxTag, role: netboxRole, region: netboxRegion };
      const interfaceIgnore = ignoreText.split('\n').map((line) => line.trim()).filter(Boolean);
      const saved = await saveDiscoveryConfig({ netbox, credentials, interfaceIgnore });
      const removed = saved.ignoredRemoved || 0;
      setStatus(removed ? `Saved. Removed ${removed} matching interfaces` : 'Saved');
      window.setTimeout(() => setStatus(''), 2000);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? `Failed: ${err.message}` : 'Failed');
    }
  }

  function addCred() {
    const entry: SnmpCredential = {
      id: Date.now().toString(),
      name: credName || (credVersion === '2c' ? credCommunity : credUser),
      version: credVersion,
    };
    if (credVersion === '2c') entry.community = credCommunity;
    else {
      entry.user = credUser;
      entry.authKey = credAuth;
      entry.privKey = credPriv;
    }
    setCredentials([...credentials, entry]);
    setCredName('');
    setCredCommunity('public');
    setCredUser('');
    setCredAuth('');
    setCredPriv('');
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">NetBox, the SNMP credential bank, the poller, and device access are stored with discovery config.</p>
      </div>

      <Panel title="NetBox">
        <div className="flex max-w-lg flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">
            Enter the NetBox URL and API token, then leave the field. Region, role, and tag load from NetBox so the import can use real values.
          </p>
          <Input
            placeholder="NetBox URL"
            aria-label="NetBox URL"
            value={netboxUrl}
            onChange={(event) => setNetboxUrl(event.target.value)}
            onBlur={() => loadFields(netboxUrl, netboxToken)}
          />
          <Input
            placeholder="API token"
            aria-label="NetBox API token"
            type="password"
            value={netboxToken}
            onChange={(event) => setNetboxToken(event.target.value)}
            onBlur={() => loadFields(netboxUrl, netboxToken)}
          />
          <div className="flex flex-wrap gap-2">
            <NetboxChoiceField label="NetBox region" value={netboxRegion} onChange={setNetboxRegion} choices={regions} />
            <NetboxChoiceField label="NetBox role" value={netboxRole} onChange={setNetboxRole} choices={roles} />
            <NetboxChoiceField label="NetBox tag" value={netboxTag} onChange={setNetboxTag} choices={tags} />
          </div>
          <div>
            <Button tone="line" onClick={() => loadFields()}>
              Load NetBox fields
            </Button>
          </div>
          {catalog ? <p className="text-sm text-muted">{catalog}</p> : null}
          <div className="flex items-center gap-3">
            <Button tone="solid" onClick={save}>
              Save NetBox settings
            </Button>
            {status ? <span className="text-sm text-muted">{status}</span> : null}
          </div>
        </div>
      </Panel>

      <Panel title="Interface ignore">
        <div className="flex max-w-lg flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">
            One regular expression per line. Matching names are not auto-selected, and saving removes interfaces that are already tracked when the stored name matches. An index with no stored name stays until the next discovery. Clearing the list does not put removed interfaces back. The match is case-insensitive, and a leading flag such as (?i)^unrouted\d+$ is accepted. (?-i) makes that one pattern case-sensitive. VLAN SVIs are ignored by default because the interface table has no routed bit. Remove the vlan lines if those interfaces should be monitored. Port-channels and management interfaces are not ignored.
          </p>
          <textarea
            aria-label="Interface ignore patterns"
            value={ignoreText}
            onChange={(event) => setIgnoreText(event.target.value)}
            rows={12}
            spellCheck={false}
            className="min-h-48 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-sm"
          />
          <p className="text-sm text-muted">Clear the list and save to track every interface name. An invalid pattern is treated as a substring.</p>
          <div>
            <Button tone="solid" onClick={save}>
              Save interface ignore
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="SNMP credential bank">
        <div className="flex flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">Discovery tries these in order. v3 uses SHA, and AES when a privacy key is set.</p>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Name" aria-label="Credential name" value={credName} onChange={(event) => setCredName(event.target.value)} className="w-40" />
            <Select
              ariaLabel="SNMP version"
              value={credVersion}
              onValueChange={(value) => setCredVersion(value as '2c' | '3')}
              options={[
                { value: '2c', label: 'v2c' },
                { value: '3', label: 'v3' },
              ]}
            />
            {credVersion === '2c' ? (
              <Input
                placeholder="Community"
                aria-label="Community"
                value={credCommunity}
                onChange={(event) => setCredCommunity(event.target.value)}
                className="w-40 font-mono"
              />
            ) : (
              <>
                <Input placeholder="User" aria-label="SNMPv3 user" value={credUser} onChange={(event) => setCredUser(event.target.value)} className="w-36" />
                <Input
                  placeholder="Auth key"
                  aria-label="Auth key"
                  type="password"
                  value={credAuth}
                  onChange={(event) => setCredAuth(event.target.value)}
                  className="w-40"
                />
                <Input
                  placeholder="Priv key"
                  aria-label="Privacy key"
                  type="password"
                  value={credPriv}
                  onChange={(event) => setCredPriv(event.target.value)}
                  className="w-40"
                />
              </>
            )}
            <Button tone="line" onClick={addCred}>
              Add credential
            </Button>
          </div>
          <Separator />
          {credentials.length === 0 ? (
            <p className="text-sm text-muted">No credentials yet.</p>
          ) : (
            <ul>
              {credentials.map((credential) => (
                <li key={credential.id} className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
                  <span className="font-mono text-sm">
                    {credential.name} ({credential.version}) {credential.community || credential.user}
                  </span>
                  <button
                    type="button"
                    className="min-h-11 text-sm text-down"
                    onClick={() => setCredentials(credentials.filter((item) => item.id !== credential.id))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button tone="solid" onClick={save}>
              Save credentials
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Service account">
        <div className="flex max-w-lg flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">
            This account logs in with Netmiko and backs up the configuration shown on a device. The password is encrypted on the server so it can be used again. It is not a one-way hash, and it is never shown after you save it. Leave the password blank to keep the stored secret.
          </p>
          <p className="text-sm text-muted">
            The device type is the Netmiko default for scheduled and manual backups. A device can use a different type on its own settings page. Devices without that override use this one.
          </p>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm">
            <Checkbox checked={accountEnabled} onCheckedChange={(checked) => setAccountEnabled(checked === true)} />
            Enable config backup
          </label>
          <Input aria-label="Service account username" placeholder="Username" value={accountUser} onChange={(event) => setAccountUser(event.target.value)} />
          <Input aria-label="Service account password" type="password" placeholder={passwordSet ? 'Password saved' : 'Password'} value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} />
          <Input aria-label="Enable secret" type="password" placeholder={enableSet ? 'Enable secret saved' : 'Enable secret, optional'} value={accountEnable} onChange={(event) => setAccountEnable(event.target.value)} />
          {enableSet ? (
            <label className="inline-flex min-h-11 items-center gap-2 text-sm">
              <Checkbox checked={clearEnable} onCheckedChange={(checked) => setClearEnable(checked === true)} />
              Remove the stored enable secret
            </label>
          ) : null}
          <Select
            ariaLabel="Default device type"
            value={accountType}
            onValueChange={setAccountType}
            options={deviceTypes.map((item) => ({ value: item.id, label: item.label }))}
          />
          {accountType === 'other' ? (
            <Input aria-label="Netmiko device type" placeholder="netmiko device_type" value={accountCustom} onChange={(event) => setAccountCustom(event.target.value)} className="font-mono" />
          ) : null}
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <Switch checked={backupEnabled} onCheckedChange={setBackupEnabled} aria-label="Enable scheduled backups" />
            Back up discovered devices on a schedule
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="backup-cron" className="text-sm">Cron</label>
            <Input id="backup-cron" aria-label="Backup cron" value={backupCron} onChange={(event) => setBackupCron(event.target.value)} className="w-48 font-mono" />
            <span className="text-sm text-muted">Daily at 02:00 is 0 2 * * *</span>
          </div>
          <p className="text-sm text-muted">
            The schedule stays off until you enable it. Each run logs in to discovered devices one at a time and stores the latest configuration.
            {backupLastRun ? ` Last run ${formatWhen(backupLastRun)}.` : ''}
          </p>
          {backupLastError ? <p className="text-sm text-down">{backupLastError}</p> : null}
          <div className="flex items-center gap-3">
            <Button
              tone="solid"
              onClick={() => {
                const deviceType = accountType === 'other' ? accountCustom.trim() : accountType;
                setAccountNote('Saving…');
                saveServiceAccount({
                  enabled: accountEnabled,
                  username: accountUser.trim(),
                  deviceType,
                  password: accountPassword,
                  enable: accountEnable,
                  clearEnable,
                  schedule: { enabled: backupEnabled, cron: backupCron.trim() },
                })
                  .then((saved) => {
                    setPasswordSet(saved.passwordSet);
                    setEnableSet(saved.enableSet);
                    setAccountPassword('');
                    setAccountEnable('');
                    setClearEnable(false);
                    if (saved.backupSchedule) {
                      setBackupEnabled(!!saved.backupSchedule.enabled);
                      setBackupCron(saved.backupSchedule.cron || '0 2 * * *');
                      setBackupLastRun(saved.backupSchedule.lastRun || null);
                      setBackupLastError(saved.backupSchedule.lastError || '');
                    }
                    setAccountNote('Saved');
                  })
                  .catch((err: unknown) => setAccountNote(err instanceof Error ? err.message : 'Could not save the service account'));
              }}
            >
              Save service account
            </Button>
            {accountNote ? <span className="text-sm text-muted">{accountNote}</span> : null}
          </div>
        </div>
      </Panel>

      <Panel title="Syslog">
        <div className="flex max-w-lg flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">
            Receives UDP syslog and keeps it for the device Logs tab. Port 514 usually needs extra permission, so the default is 5514. The receiver stays off until you enable it. Retention is the shorter of the day limit and the row limit.
          </p>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm">
            <Checkbox checked={syslogEnabled} onCheckedChange={(checked) => setSyslogEnabled(checked === true)} />
            Enable syslog receiver
          </label>
          <Input aria-label="Syslog UDP port" value={syslogPort} onChange={(event) => setSyslogPort(event.target.value)} />
          <Input aria-label="Syslog retention days" value={syslogDays} onChange={(event) => setSyslogDays(event.target.value)} />
          <Input aria-label="Syslog maximum rows" value={syslogRows} onChange={(event) => setSyslogRows(event.target.value)} />
          <p className="text-sm text-muted">Status: {syslogStatus}</p>
          <div className="flex items-center gap-3">
            <Button
              tone="solid"
              onClick={() => {
                setSyslogNote('Saving…');
                saveSyslog({
                  enabled: syslogEnabled,
                  port: Number(syslogPort),
                  retainDays: Number(syslogDays),
                  maxRows: Number(syslogRows),
                })
                  .then((saved) => {
                    setSyslogStatus(saved.status || 'stopped');
                    setSyslogPort(String(saved.port));
                    setSyslogDays(String(saved.retainDays));
                    setSyslogRows(String(saved.maxRows));
                    setSyslogNote('Saved');
                  })
                  .catch((err: unknown) => setSyslogNote(err instanceof Error ? err.message : 'Could not save syslog settings'));
              }}
            >
              Save syslog
            </Button>
            {syslogNote ? <span className="text-sm text-muted">{syslogNote}</span> : null}
          </div>
        </div>
      </Panel>

      <PollerPanel poller={poller} onPoller={setPoller} />
    </div>
  );
}

type PollSort = 'hostname' | 'ip' | 'last' | 'average' | 'when';

function ipKey(ip: string) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return ip;
  return parts.map((part) => String(part).padStart(3, '0')).join('.');
}

function PollerPanel({ poller, onPoller }: { poller: PollerSummary | null; onPoller: (value: PollerSummary) => void }) {
  const [sortKey, setSortKey] = useState<PollSort>('hostname');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let cancel = false;
    function pull() {
      fetchPoller()
        .then((summary) => {
          if (!cancel) onPoller(summary);
        })
        .catch(() => {
          /* the panel keeps the last summary */
        });
    }
    pull();
    const id = window.setInterval(pull, 10000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [onPoller]);

  const rows = useMemo(() => {
    const list = [...(poller?.devices || [])];
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === 'hostname') return (a.hostname || a.ip).localeCompare(b.hostname || b.ip) * dir;
      if (sortKey === 'ip') return ipKey(a.ip).localeCompare(ipKey(b.ip)) * dir;
      if (sortKey === 'last') return ((a.lastMs || 0) - (b.lastMs || 0)) * dir;
      if (sortKey === 'average') return ((a.avgMs || 0) - (b.avgMs || 0)) * dir;
      return ((a.lastAt || 0) - (b.lastAt || 0)) * dir;
    });
    return list;
  }, [poller, sortKey, sortDir]);

  function onSort(key: PollSort) {
    if (sortKey === key) setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'last' || key === 'average' || key === 'when' ? 'desc' : 'asc');
    }
  }

  const columns: { key: PollSort; label: string }[] = [
    { key: 'hostname', label: 'Hostname' },
    { key: 'ip', label: 'IP' },
    { key: 'last', label: 'Last poll' },
    { key: 'average', label: 'Average' },
    { key: 'when', label: 'Finished' },
  ];

  return (
    <Panel title="Poller">
      <div className="flex flex-col gap-3 px-4 py-4">
        <p className="text-sm text-muted">
          Last poll is how long the most recent cycle took, including interface reads, reachability, and alert checks. Device rows are the SNMP read for that device.
          {poller?.currentDevice ? ` Polling ${poller.currentDevice}.` : ''}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-faint">Last poll</div>
            <div className="mt-1 font-mono text-lg">{formatDuration(poller?.lastMs)}</div>
            <div className="text-sm text-muted">{formatEpoch(poller?.lastAt)}</div>
          </div>
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-faint">Average poll</div>
            <div className="mt-1 font-mono text-lg">{formatDuration(poller?.avgMs)}</div>
            <div className="text-sm text-muted">{poller?.samples ? `${poller.samples} cycles` : 'No cycles yet'}</div>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No device poll times yet. Times appear after a device with selected interfaces is polled.</p>
        ) : (
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm">Device poll times ({rows.length})</summary>
            <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  {columns.map((column) => (
                    <th key={column.key} scope="col" aria-sort={sortKey === column.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className="px-2">
                      <button type="button" onClick={() => onSort(column.key)} className="inline-flex min-h-11 items-center gap-1 font-mono text-xs uppercase tracking-widest text-faint">
                        {column.label}
                        {sortKey === column.key ? <span aria-hidden>{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.ip} className="border-b border-line last:border-b-0">
                    <td className="px-2 py-2 font-mono text-sm">{row.hostname || row.ip}</td>
                    <td className="px-2 py-2 font-mono text-sm">{row.ip}</td>
                    <td className="px-2 py-2 font-mono text-sm">{formatDuration(row.lastMs)}</td>
                    <td className="px-2 py-2 font-mono text-sm">{formatDuration(row.avgMs)}</td>
                    <td className="px-2 py-2 text-sm text-muted">{formatEpoch(row.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </details>
        )}
      </div>
    </Panel>
  );
}
