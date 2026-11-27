import { useEffect, useMemo, useState } from 'react';
import { Panel } from '@/components/nms/bits';
import { NetboxChoiceField } from '@/components/nms/netbox-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  createAuthUser,
  deleteAuthUser,
  fetchAuthUsers,
  fetchDiscoveryConfig,
  fetchNetboxOptions,
  fetchPoller,
  logout,
  saveAuthSettings,
  saveDiscoveryConfig,
  saveServiceAccount,
  saveSyslog,
  type AuthPublic,
  type AuthUser,
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
  const [accountPassword, setAccountPassword] = useState('');
  const [accountEnable, setAccountEnable] = useState('');
  const [clearEnable, setClearEnable] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);
  const [enableSet, setEnableSet] = useState(false);
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
  const [auth, setAuth] = useState<AuthPublic | null>(null);

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
          setAccountEnabled(!!account.enabled);
          setAccountUser(account.username || '');
          setPasswordSet(!!account.passwordSet);
          setEnableSet(!!account.enableSet);
        }
        if (cfg.auth) setAuth(cfg.auth);
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
            The Netmiko device type is detected from each device's operating system. Set a different type on that device's settings page when the detection does not match.
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
                setAccountNote('Saving…');
                saveServiceAccount({
                  enabled: accountEnabled,
                  username: accountUser.trim(),
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
          <div className="flex flex-col gap-1">
            <Label htmlFor="syslog-port">UDP port</Label>
            <Input id="syslog-port" aria-label="Syslog UDP port" value={syslogPort} onChange={(event) => setSyslogPort(event.target.value)} />
            <p className="text-xs text-muted">Port 514 usually needs extra permission. 5514 is the default.</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="syslog-days">Retention days</Label>
            <Input id="syslog-days" aria-label="Syslog retention days" value={syslogDays} onChange={(event) => setSyslogDays(event.target.value)} />
            <p className="text-xs text-muted">Messages older than this many days are deleted.</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="syslog-rows">Maximum rows</Label>
            <Input id="syslog-rows" aria-label="Syslog maximum rows" value={syslogRows} onChange={(event) => setSyslogRows(event.target.value)} />
            <p className="text-xs text-muted">The store also drops the oldest rows after this many messages. The shorter of the two limits wins.</p>
          </div>
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

      <AuthPanel auth={auth} onAuth={setAuth} />

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

const AUTH_MODES = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'Local' },
  { value: 'ad', label: 'Active Directory' },
  { value: 'ldap', label: 'LDAP' },
  { value: 'sso', label: 'SSO' },
];

const AD_FILTER = '(|(sAMAccountName={{username}})(userPrincipalName={{username}}))';
const LDAP_FILTER = '(uid={{username}})';

function DirectoryFields({
  idPrefix,
  serverLabel,
  url,
  setUrl,
  bindUser,
  setBindUser,
  bindPassword,
  setBindPassword,
  passwordSet,
  baseDn,
  setBaseDn,
  groupDn,
  setGroupDn,
  userFilter,
  setUserFilter,
  filterHelp,
}: {
  idPrefix: string;
  serverLabel: string;
  url: string;
  setUrl: (value: string) => void;
  bindUser: string;
  setBindUser: (value: string) => void;
  bindPassword: string;
  setBindPassword: (value: string) => void;
  passwordSet: boolean;
  baseDn: string;
  setBaseDn: (value: string) => void;
  groupDn: string;
  setGroupDn: (value: string) => void;
  userFilter: string;
  setUserFilter: (value: string) => void;
  filterHelp: string;
}) {
  return (
    <>
      <Label htmlFor={`${idPrefix}-url`}>{serverLabel}</Label>
      <Input id={`${idPrefix}-url`} aria-label={`${serverLabel} URL`} placeholder="ldaps://directory.example.com" value={url} onChange={(event) => setUrl(event.target.value)} />
      <Label htmlFor={`${idPrefix}-bind`}>Bind user</Label>
      <Input id={`${idPrefix}-bind`} aria-label={`${serverLabel} bind user`} placeholder="CN=svc-nms,OU=Service,DC=example,DC=com" value={bindUser} onChange={(event) => setBindUser(event.target.value)} />
      <p className="text-xs text-muted">A DN or user@domain. This account only searches the directory. The password is encrypted and is not shown again.</p>
      <Input aria-label={`${serverLabel} bind password`} type="password" placeholder={passwordSet ? 'Bind password saved' : 'Bind password'} value={bindPassword} onChange={(event) => setBindPassword(event.target.value)} />
      <Label htmlFor={`${idPrefix}-base`}>Search base DN</Label>
      <Input id={`${idPrefix}-base`} aria-label={`${serverLabel} search base DN`} placeholder="DC=example,DC=com" value={baseDn} onChange={(event) => setBaseDn(event.target.value)} />
      <Label htmlFor={`${idPrefix}-group`}>Required group DN</Label>
      <Input id={`${idPrefix}-group`} aria-label={`${serverLabel} required group DN`} placeholder="CN=ReactNMS,OU=Groups,DC=example,DC=com" value={groupDn} onChange={(event) => setGroupDn(event.target.value)} />
      <p className="text-xs text-muted">Sign-in is allowed only when this group lists the account, or the account lists this group. Active Directory does not list a user's primary group here, so choose a group the account was added to.</p>
      <Label htmlFor={`${idPrefix}-filter`}>User filter</Label>
      <Input id={`${idPrefix}-filter`} aria-label={`${serverLabel} user filter`} value={userFilter} onChange={(event) => setUserFilter(event.target.value)} className="font-mono" />
      <p className="text-xs text-muted">{filterHelp}</p>
    </>
  );
}

function AuthPanel({ auth, onAuth }: { auth: AuthPublic | null; onAuth: (value: AuthPublic) => void }) {
  const [mode, setMode] = useState(auth?.mode || 'off');
  const [adUrl, setAdUrl] = useState(auth?.ad.url || '');
  const [adBind, setAdBind] = useState(auth?.ad.bindDn || '');
  const [adPassword, setAdPassword] = useState('');
  const [adBase, setAdBase] = useState(auth?.ad.baseDn || '');
  const [adGroup, setAdGroup] = useState(auth?.ad.groupDn || '');
  const [adFilter, setAdFilter] = useState(auth?.ad.userFilter || AD_FILTER);
  const [ldapUrl, setLdapUrl] = useState(auth?.ldap.url || '');
  const [ldapBind, setLdapBind] = useState(auth?.ldap.bindDn || '');
  const [ldapPassword, setLdapPassword] = useState('');
  const [ldapBase, setLdapBase] = useState(auth?.ldap.baseDn || '');
  const [ldapGroup, setLdapGroup] = useState(auth?.ldap.groupDn || '');
  const [ldapFilter, setLdapFilter] = useState(auth?.ldap.userFilter || LDAP_FILTER);
  const [issuer, setIssuer] = useState(auth?.sso.issuer || '');
  const [clientId, setClientId] = useState(auth?.sso.clientId || '');
  const [redirectUri, setRedirectUri] = useState(auth?.sso.redirectUri || '');
  const [clientSecret, setClientSecret] = useState('');
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!auth) return;
    setMode(auth.mode || 'off');
    setAdUrl(auth.ad.url || '');
    setAdBind(auth.ad.bindDn || '');
    setAdBase(auth.ad.baseDn || '');
    setAdGroup(auth.ad.groupDn || '');
    setAdFilter(auth.ad.userFilter || AD_FILTER);
    setLdapUrl(auth.ldap.url || '');
    setLdapBind(auth.ldap.bindDn || '');
    setLdapBase(auth.ldap.baseDn || '');
    setLdapGroup(auth.ldap.groupDn || '');
    setLdapFilter(auth.ldap.userFilter || LDAP_FILTER);
    setIssuer(auth.sso.issuer || '');
    setClientId(auth.sso.clientId || '');
    setRedirectUri(auth.sso.redirectUri || '');
  }, [auth]);

  useEffect(() => {
    let cancel = false;
    fetchAuthUsers()
      .then((body) => {
        if (!cancel) setUsers(body.users || []);
      })
      .catch(() => {
        if (!cancel) setUsers([]);
      });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <Panel title="Authentication">
      <div className="flex max-w-lg flex-col gap-3 px-4 py-4">
        <p className="text-sm text-muted">
          Authentication stays off until you choose a mode, so this install is not locked out. Create a local user before you turn Local on. After you turn authentication on, the next page load asks you to sign in.
        </p>
        <Select ariaLabel="Authentication mode" value={mode} onValueChange={setMode} options={AUTH_MODES} />
        {mode === 'ad' ? (
          <DirectoryFields
            idPrefix="ad"
            serverLabel="Active Directory server"
            url={adUrl}
            setUrl={setAdUrl}
            bindUser={adBind}
            setBindUser={setAdBind}
            bindPassword={adPassword}
            setBindPassword={setAdPassword}
            passwordSet={!!auth?.ad.passwordSet}
            baseDn={adBase}
            setBaseDn={setAdBase}
            groupDn={adGroup}
            setGroupDn={setAdGroup}
            userFilter={adFilter}
            setUserFilter={setAdFilter}
            filterHelp="Default matches the account name or user@domain. {{username}} is replaced with the name typed at sign-in."
          />
        ) : null}
        {mode === 'ldap' ? (
          <DirectoryFields
            idPrefix="ldap"
            serverLabel="LDAP server"
            url={ldapUrl}
            setUrl={setLdapUrl}
            bindUser={ldapBind}
            setBindUser={setLdapBind}
            bindPassword={ldapPassword}
            setBindPassword={setLdapPassword}
            passwordSet={!!auth?.ldap.passwordSet}
            baseDn={ldapBase}
            setBaseDn={setLdapBase}
            groupDn={ldapGroup}
            setGroupDn={setLdapGroup}
            userFilter={ldapFilter}
            setUserFilter={setLdapFilter}
            filterHelp="Default matches uid. {{username}} is replaced with the name typed at sign-in."
          />
        ) : null}
        {mode === 'sso' ? (
          <>
            <Label htmlFor="sso-issuer">Issuer</Label>
            <Input id="sso-issuer" aria-label="SSO issuer" placeholder="https://login.example.com/realms/network" value={issuer} onChange={(event) => setIssuer(event.target.value)} />
            <Label htmlFor="sso-client">Client ID</Label>
            <Input id="sso-client" aria-label="SSO client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} />
            <Label htmlFor="sso-redirect">Redirect URI</Label>
            <Input id="sso-redirect" aria-label="SSO redirect URI" placeholder="https://host/api/auth/sso/callback" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} />
            <p className="text-xs text-muted">This is the backend callback. The client secret is encrypted and is not shown again. Leave it blank to keep the stored secret.</p>
            <Input aria-label="SSO client secret" type="password" placeholder={auth?.sso.secretSet ? 'Client secret saved' : 'Client secret'} value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
          </>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            tone="solid"
            onClick={() => {
              setNote('Saving…');
              saveAuthSettings({
                mode,
                ad: { url: adUrl.trim(), bindDn: adBind.trim(), baseDn: adBase.trim(), groupDn: adGroup.trim(), userFilter: adFilter.trim(), bindPassword: adPassword },
                ldap: { url: ldapUrl.trim(), bindDn: ldapBind.trim(), baseDn: ldapBase.trim(), groupDn: ldapGroup.trim(), userFilter: ldapFilter.trim(), bindPassword: ldapPassword },
                sso: { issuer: issuer.trim(), clientId: clientId.trim(), redirectUri: redirectUri.trim(), clientSecret },
              })
                .then((saved) => {
                  onAuth(saved);
                  setAdPassword('');
                  setLdapPassword('');
                  setClientSecret('');
                  setNote('Saved');
                })
                .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not save authentication'));
            }}
          >
            Save authentication
          </Button>
          {auth?.mode && auth.mode !== 'off' ? (
            <Button tone="line" onClick={() => logout().finally(() => window.location.assign('/login'))}>Sign out</Button>
          ) : null}
          {note ? <span className="text-sm text-muted">{note}</span> : null}
        </div>
        <div className="mt-2 border-t border-line pt-3">
          <h3 className="font-mono text-xs uppercase tracking-widest text-faint">Local users</h3>
          <p className="mt-2 text-sm text-muted">Usernames can contain letters, numbers, and . _ @ -. Passwords need at least 8 characters.</p>
          {users.length ? (
            <ul className="mt-2">
              {users.map((user) => (
                <li key={user.username} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm">
                  <span className="font-mono">{user.username}</span>
                  <button
                    type="button"
                    className="min-h-11 text-sm text-down"
                    onClick={() => {
                      deleteAuthUser(user.username)
                        .then(() => setUsers((current) => current.filter((item) => item.username !== user.username)))
                        .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not remove the user'));
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted">No local users yet.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input aria-label="New username" placeholder="Username" value={username} onChange={(event) => setUsername(event.target.value)} className="w-40" />
            <Input aria-label="New password" type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} className="w-40" />
            <Button
              tone="line"
              onClick={() => {
                createAuthUser(username.trim(), password)
                  .then((saved) => {
                    setUsers((current) => [...current, { username: saved.username, createdAt: Date.now() }].sort((a, b) => a.username.localeCompare(b.username)));
                    setUsername('');
                    setPassword('');
                    setNote(`Added ${saved.username}`);
                  })
                  .catch((err: unknown) => setNote(err instanceof Error ? err.message : 'Could not create the user'));
              }}
            >
              Add user
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
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
