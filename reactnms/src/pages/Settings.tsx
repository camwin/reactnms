import { useEffect, useState } from 'react';
import { Panel } from '@/components/nms/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { fetchDiscoveryConfig, saveDiscoveryConfig, type DiscoveryConfig, type SnmpCredential } from '@/lib/api';

export default function Settings() {
  const [config, setConfig] = useState<DiscoveryConfig | null>(null);
  const [netboxUrl, setNetboxUrl] = useState('');
  const [netboxToken, setNetboxToken] = useState('');
  const [netboxTag, setNetboxTag] = useState('');
  const [netboxRole, setNetboxRole] = useState('');
  const [credentials, setCredentials] = useState<SnmpCredential[]>([]);
  const [status, setStatus] = useState('');
  const [credName, setCredName] = useState('');
  const [credVersion, setCredVersion] = useState<'2c' | '3'>('2c');
  const [credCommunity, setCredCommunity] = useState('public');
  const [credUser, setCredUser] = useState('');
  const [credAuth, setCredAuth] = useState('');
  const [credPriv, setCredPriv] = useState('');

  useEffect(() => {
    let cancel = false;
    fetchDiscoveryConfig()
      .then((cfg) => {
        if (cancel) return;
        setConfig(cfg);
        setNetboxUrl(cfg.netbox?.url || '');
        setNetboxToken(cfg.netbox?.token || '');
        setNetboxTag(cfg.netbox?.tag || '');
        setNetboxRole(cfg.netbox?.role || '');
        setCredentials(cfg.credentials || []);
      })
      .catch(() => {
        if (!cancel) setStatus('Could not load settings');
      });
    return () => {
      cancel = true;
    };
  }, []);

  async function save() {
    setStatus('Saving…');
    try {
      const current = config ?? (await fetchDiscoveryConfig());
      await saveDiscoveryConfig({
        ...current,
        netbox: { url: netboxUrl, token: netboxToken, tag: netboxTag, role: netboxRole },
        credentials,
      });
      setConfig({
        ...current,
        netbox: { url: netboxUrl, token: netboxToken, tag: netboxTag, role: netboxRole },
        credentials,
      });
      setStatus('Saved');
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
        <p className="mt-1 text-sm text-muted">NetBox and the SNMP credential bank are stored with discovery config.</p>
      </div>

      <Panel title="NetBox">
        <div className="flex max-w-lg flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">Discovery imports active prefixes by this role or tag. Use the role name or slug, for example Management.</p>
          <Input placeholder="NetBox URL" aria-label="NetBox URL" value={netboxUrl} onChange={(event) => setNetboxUrl(event.target.value)} />
          <Input
            placeholder="API token"
            aria-label="NetBox API token"
            type="password"
            value={netboxToken}
            onChange={(event) => setNetboxToken(event.target.value)}
          />
          <Input placeholder="Tag (optional)" aria-label="NetBox tag" value={netboxTag} onChange={(event) => setNetboxTag(event.target.value)} />
          <Input placeholder="Role name or slug" aria-label="NetBox role" value={netboxRole} onChange={(event) => setNetboxRole(event.target.value)} />
          <div className="flex items-center gap-3">
            <Button tone="solid" onClick={save}>
              Save NetBox settings
            </Button>
            {status ? <span className="text-sm text-muted">{status}</span> : null}
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
    </div>
  );
}
