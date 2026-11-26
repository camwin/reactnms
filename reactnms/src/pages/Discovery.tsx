import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Plus, Trash2 } from 'lucide-react';
import { Panel } from '@/components/nms/bits';
import { NetboxChoiceField } from '@/components/nms/netbox-fields';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  ApiError,
  fetchDiscoveryConfig,
  fetchDiscoveryStatus,
  fetchNetboxOptions,
  importNetboxPrefixes,
  saveDiscoveryConfig,
  scanDiscovery,
  type NetboxChoice,
  type SnmpCredential,
} from '@/lib/api';

export default function Discovery() {
  const [running, setRunning] = useState(false);
  const [watching, setWatching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState('');
  const [subnets, setSubnets] = useState<string[]>([]);
  const [newSubnet, setNewSubnet] = useState('');
  const [credentials, setCredentials] = useState<SnmpCredential[]>([]);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [cron, setCron] = useState('0 */6 * * *');
  const [netboxReady, setNetboxReady] = useState(false);
  const [netboxUrl, setNetboxUrl] = useState('');
  const [region, setRegion] = useState('');
  const [role, setRole] = useState('');
  const [tag, setTag] = useState('');
  const [regions, setRegions] = useState<NetboxChoice[]>([]);
  const [roles, setRoles] = useState<NetboxChoice[]>([]);
  const [tags, setTags] = useState<NetboxChoice[]>([]);

  async function load() {
    const config = await fetchDiscoveryConfig();
    setSubnets(config.subnets || []);
    setCredentials(config.credentials || []);
    setScheduleEnabled(!!config.schedule?.enabled);
    setCron(config.schedule?.cron || '0 */6 * * *');
    const ready = Boolean(config.netbox?.url && config.netbox?.token);
    setNetboxReady(ready);
    setNetboxUrl(config.netbox?.url || '');
    setRegion(config.netbox?.region || '');
    setRole(config.netbox?.role || '');
    setTag(config.netbox?.tag || '');
    if (!ready) return;
    try {
      const options = await fetchNetboxOptions();
      setRegions(options.regions);
      setRoles(options.roles);
      setTags(options.tags);
    } catch {
      /* the saved slugs still work if the catalog cannot be loaded */
    }
  }

  useEffect(() => {
    let cancel = false;
    load().catch((err: unknown) => {
      if (!cancel) setStatus(err instanceof Error ? `Failed to load config: ${err.message}` : 'Failed to load config');
    });
    fetchDiscoveryStatus()
      .then((next) => {
        if (cancel) return;
        setRunning(next.running);
        if (next.running) setWatching(true);
      })
      .catch(() => {
        /* an older backend has no status route; the scan button still works */
      });
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!watching) return;
    let cancel = false;
    const id = window.setInterval(() => {
      fetchDiscoveryStatus()
        .then(async (next) => {
          if (cancel) return;
          setRunning(next.running);
          if (next.running) return;
          setWatching(false);
          setStatus(next.error ? next.error : `Found ${next.found} devices. They are listed on the Devices page.`);
        })
        .catch(() => {
          /* keep watching until the status route answers */
        });
    }, 2000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [watching]);

  async function saveConfig() {
    setStatus('Saving…');
    try {
      await saveDiscoveryConfig({
        subnets,
        schedule: { enabled: scheduleEnabled, cron },
      });
      setStatus('Saved');
      window.setTimeout(() => setStatus(''), 2000);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed');
    }
  }

  function addSubnet() {
    const subnet = newSubnet.trim();
    if (!subnet) return;
    if (!subnets.includes(subnet)) setSubnets([...subnets, subnet]);
    setNewSubnet('');
  }

  async function runScan() {
    setStatus('Starting scan…');
    try {
      const data = await scanDiscovery({ subnets });
      if (data.started || data.running) {
        setRunning(true);
        setWatching(true);
        setStatus('Scan started. Progress stays at the top of every page.');
        return;
      }
      if (typeof data.count === 'number') {
        setStatus(`Found ${data.count} devices`);
        await load();
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setRunning(true);
        setWatching(true);
      }
      setStatus(err instanceof Error ? err.message : 'Scan failed');
    }
  }

  async function importPrefixes() {
    setImporting(true);
    setStatus('Importing prefixes…');
    try {
      const data = await importNetboxPrefixes({ region: region.trim(), role: role.trim(), tag: tag.trim() });
      setSubnets(data.subnets || []);
      if (data.region) setRegion(data.region);
      if (data.role) setRole(data.role);
      if (data.tag) setTag(data.tag);
      const whoBits = [data.regionName, data.roleName, data.tag ? `tag ${data.tag}` : ''].filter(Boolean);
      const who = whoBits.length ? ` for ${whoBits.join(', ')}` : '';
      const early = data.truncated ? ' The import stopped early. Narrow the filter and import again.' : '';
      setStatus(`Imported ${data.count} prefixes (${data.added} new)${who}. About ${data.plannedHosts.toLocaleString()} hosts.${early}`);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Discovery</h1>
        <p className="mt-1 text-sm text-muted">
          Scans use the SNMP credential bank. Devices show up on the Devices page as each subnet finishes, with a last discovered time.
        </p>
        {status ? <p className="mt-2 text-sm text-muted">{status}</p> : null}
      </div>

      <Panel title="NetBox prefixes">
        <div className="flex flex-col gap-3 px-4 py-4">
          <p className="text-sm text-muted">
            Imports active prefixes and adds them to the scan list. Region, role, and tag match a NetBox name or slug.
          </p>
          {netboxUrl ? <p className="truncate font-mono text-xs text-faint">{netboxUrl}</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <NetboxChoiceField label="NetBox region" value={region} onChange={setRegion} choices={regions} />
            <NetboxChoiceField label="NetBox role" value={role} onChange={setRole} choices={roles} />
            <NetboxChoiceField label="NetBox tag" value={tag} onChange={setTag} choices={tags} />
            <Button
              tone="solid"
              onClick={importPrefixes}
              disabled={!netboxReady || importing || (!region.trim() && !role.trim() && !tag.trim())}
            >
              {importing ? 'Importing…' : 'Import prefixes'}
            </Button>
          </div>
          {!netboxReady ? (
            <p className="text-sm text-muted">
              Save a NetBox URL and token under{' '}
              <Link to="/settings" className="text-accent">
                Settings
              </Link>{' '}
              first.
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel title="Subnets to scan">
        <div className="flex gap-2 px-4 pt-4">
          <Input
            value={newSubnet}
            onChange={(event) => setNewSubnet(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addSubnet();
            }}
            placeholder="192.168.1.0/24"
            aria-label="Subnet"
          />
          <Button tone="line" onClick={addSubnet}>
            <Plus className="size-4" />
            Add
          </Button>
        </div>
        {subnets.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">No subnets added yet.</p>
        ) : (
          <ul className="mt-3 max-h-72 overflow-auto">
            {subnets.map((subnet) => (
              <li key={subnet} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2">
                <code className="font-mono text-sm">{subnet}</code>
                <button
                  type="button"
                  onClick={() => setSubnets(subnets.filter((item) => item !== subnet))}
                  className="inline-flex size-11 items-center justify-center text-down"
                  aria-label={`Remove ${subnet}`}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
          <p className="text-sm text-muted">Credentials are tried in the order below. v3 uses SHA, and AES when a privacy key is set.</p>
          {credentials.length === 0 ? (
            <p className="text-sm text-muted">
              No credentials saved.{' '}
              <Link to="/settings" className="text-accent">
                Add credentials
              </Link>
              . Until then a scan uses the saved v2c community.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {credentials.map((credential) => (
                <li key={credential.id} className="font-mono text-sm">
                  {credential.name} · {credential.version === '3' ? 'v3' : 'v2c'}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button tone="solid" onClick={runScan} disabled={running || subnets.length === 0}>
              <Play className="size-4" />
              {running ? 'Scanning…' : 'Scan now'}
            </Button>
            <Button tone="line" onClick={saveConfig}>
              Save
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Schedule">
        <div className="flex flex-col gap-3 px-4 py-4">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} aria-label="Enable scheduled discovery" />
            Enable scheduled discovery
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Label htmlFor="cron">Cron</Label>
            <Input id="cron" value={cron} onChange={(event) => setCron(event.target.value)} className="w-48 font-mono" />
            <span className="text-sm text-muted">Example: every 6 hours is 0 */6 * * *</span>
          </div>
          <div>
            <Button tone="line" onClick={saveConfig}>
              Update schedule
            </Button>
          </div>
        </div>
      </Panel>

    </div>
  );
}
