import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  DEVICE_TYPE_CHOICES,
  deleteDevice,
  discoverDevice,
  fetchDevice,
  fetchDeviceSettings,
  fetchSelections,
  saveDeviceCli,
  saveDeviceCredential,
  saveSelections,
  type DevicePollStat,
  type DeviceTypeChoice,
  type PolledInterface,
} from '@/lib/api';
import { formatDuration, formatEpoch } from '@/lib/format';

const NONE = '__none__';
const AUTO = '__auto__';

export default function DeviceSettings() {
  const { ip } = useParams<{ ip: string }>();
  const navigate = useNavigate();
  const [interfaces, setInterfaces] = useState<PolledInterface[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [credentialId, setCredentialId] = useState(NONE);
  const [credentialName, setCredentialName] = useState('');
  const [credentials, setCredentials] = useState<{ id: string; name: string; version: string }[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [poll, setPoll] = useState<DevicePollStat | null>(null);
  const [deviceType, setDeviceType] = useState(AUTO);
  const [customType, setCustomType] = useState('');
  const [detectedType, setDetectedType] = useState('');
  const [deviceTypes, setDeviceTypes] = useState<DeviceTypeChoice[]>(DEVICE_TYPE_CHOICES);

  useEffect(() => {
    if (!ip) return;
    let cancel = false;
    Promise.allSettled([fetchDevice(ip), fetchSelections(ip), fetchDeviceSettings(ip)])
      .then(([device, selection, settings]) => {
        if (cancel) return;
        if (device.status === 'fulfilled') setInterfaces(device.value.interfaces || []);
        else setStatus('Interfaces could not be read. Credential and delete are still available.');
        if (selection.status === 'fulfilled') setSelected((selection.value || []).map(String));
        if (settings.status === 'fulfilled') {
          const known = settings.value.credentials.some((cred) => cred.id === settings.value.credentialId);
          setCredentialId(known ? settings.value.credentialId : NONE);
          setCredentialName(settings.value.credentialName || '');
          setCredentials(settings.value.credentials || []);
          setPoll(settings.value.poll || null);
          const choices = settings.value.deviceTypes?.length ? settings.value.deviceTypes : DEVICE_TYPE_CHOICES;
          setDeviceTypes(choices);
          const typeIds = new Set(choices.map((item) => item.id).filter((id) => id !== 'other'));
          const current = settings.value.deviceType || '';
          setDetectedType(settings.value.detectedType || '');
          if (!current) {
            setDeviceType(AUTO);
            setCustomType('');
          } else if (typeIds.has(current)) {
            setDeviceType(current);
            setCustomType('');
          } else {
            setDeviceType('other');
            setCustomType(current);
          }
        }
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [ip, reloadKey]);

  function toggle(index: string) {
    setSelected((prev) => (prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]));
  }

  function upIndexes(current: string[]) {
    const next = new Set(current);
    const known = new Set<string>();
    for (const iface of interfaces) {
      const index = String(iface.index);
      known.add(index);
      const disabled = iface.adminStatus === 2;
      const up = iface.operStatus === 1 && !disabled && !iface.ignored;
      if (iface.ignored || disabled) next.delete(index);
      else if (up) next.add(index);
    }
    for (const index of [...next]) {
      if (!known.has(index)) next.delete(index);
    }
    return [...next];
  }

  async function selectAllUp() {
    if (!ip || interfaces.length === 0) return;
    const next = upIndexes(selected);
    setSelected(next);
    setSaving(true);
    setStatus('');
    try {
      await saveSelections(ip, next);
      setStatus(`Tracking ${next.length} up interfaces`);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? `Failed: ${err.message}` : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!ip) return;
    setSaving(true);
    setStatus('');
    try {
      await saveSelections(ip, selected);
      setStatus('Saved');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? `Failed: ${err.message}` : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  async function saveCredential() {
    if (!ip) return;
    setSaving(true);
    setStatus('');
    try {
      const saved = await saveDeviceCredential(ip, credentialId === NONE ? '' : credentialId);
      setCredentialName(credentials.find((cred) => cred.id === saved.credentialId)?.name || '');
      setStatus(saved.credentialId ? 'Cached credential saved' : 'Cached credential cleared');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Could not save the credential');
    } finally {
      setSaving(false);
    }
  }

  async function discover() {
    if (!ip) return;
    setDiscovering(true);
    setStatus('');
    try {
      await discoverDevice(ip);
      setReloadKey((value) => value + 1);
      setStatus('Device rediscovered');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Discover failed');
    } finally {
      setDiscovering(false);
    }
  }

  async function remove() {
    if (!ip) return;
    setSaving(true);
    setStatus('');
    try {
      await deleteDevice(ip);
      navigate('/devices');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Could not delete the device');
      setSaving(false);
    }
  }

  if (!ip) return null;
  if (loading) return <div className="px-1 py-6 text-sm text-muted">Loading device settings…</div>;

  const credOptions = [
    { value: NONE, label: credentialName && credentialId === NONE ? `Saved: ${credentialName}` : 'Use discovery order' },
    ...credentials.map((cred) => ({ value: cred.id, label: `${cred.name} (${cred.version})` })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to={`/devices/${encodeURIComponent(ip)}`} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted">
          <ChevronLeft className="size-4" aria-hidden />
          Back to device
        </Link>
        <Button tone="line" onClick={discover} disabled={discovering}>{discovering ? 'Discovering…' : 'Discover device'}</Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Device settings</h1>
        <p className="mt-1 font-mono text-sm text-muted">{ip}</p>
      </div>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-faint">Poll statistics</h2>
          <p className="mt-2 text-sm text-muted">How long the last SNMP interface poll took for this device, and the running average.</p>
        </header>
        <dl className="grid gap-px bg-line sm:grid-cols-3">
          <div className="bg-surface px-4 py-3">
            <dt className="font-mono text-xs uppercase tracking-widest text-faint">Last poll</dt>
            <dd className="mt-1 font-mono text-sm">{formatDuration(poll?.lastMs)}</dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="font-mono text-xs uppercase tracking-widest text-faint">Average</dt>
            <dd className="mt-1 font-mono text-sm">{formatDuration(poll?.avgMs)}</dd>
          </div>
          <div className="bg-surface px-4 py-3">
            <dt className="font-mono text-xs uppercase tracking-widest text-faint">Finished</dt>
            <dd className="mt-1 font-mono text-sm">{formatEpoch(poll?.lastAt)}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-faint">Config backup</h2>
          <p className="mt-2 text-sm text-muted">
            Detect from the operating system is the default. A saved type here overrides that detection.
            {detectedType ? ` Detected ${detectedType}.` : ' No operating system match yet. Choose a type before backing up this device.'}
          </p>
        </header>
        <div className="flex flex-wrap items-center gap-3 px-4 py-4">
          <Select
            ariaLabel="Device type"
            value={deviceType}
            onValueChange={setDeviceType}
            options={[{ value: AUTO, label: 'Detect from operating system' }, ...deviceTypes.map((item) => ({ value: item.id, label: item.label }))]}
          />
          {deviceType === 'other' ? (
            <Input aria-label="Netmiko device type" placeholder="netmiko device_type" value={customType} onChange={(event) => setCustomType(event.target.value)} className="w-56 font-mono" />
          ) : null}
          <Button
            tone="solid"
            disabled={saving}
            onClick={() => {
              const next = deviceType === AUTO ? 'auto' : deviceType === 'other' ? customType.trim() : deviceType;
              setSaving(true);
              setStatus('');
              saveDeviceCli(ip, next)
                .then((saved) => {
                  if (saved.detectedType) setDetectedType(saved.detectedType);
                  setStatus(saved.deviceType ? `Device type ${saved.deviceType}` : 'Using operating system detection');
                })
                .catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'Could not save the device type'))
                .finally(() => setSaving(false));
            }}
          >
            Save device type
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-faint">SNMP credential</h2>
          <p className="mt-2 text-sm text-muted">
            The poller uses this cached credential. Secrets stay in the credential bank. Clear it to follow discovery order again.
          </p>
        </header>
        <div className="flex flex-wrap items-center gap-3 px-4 py-4">
          <Select ariaLabel="Cached SNMP credential" value={credentialId} onValueChange={setCredentialId} options={credOptions} />
          <Button tone="solid" onClick={saveCredential} disabled={saving}>Save credential</Button>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-faint">Polled interfaces</h2>
          <p className="mt-2 text-sm text-muted">
            Only selected interfaces are recorded to history. The description is the configured ifAlias, and stays blank when the alias is blank. Ignored names from Settings, such as Null, loopback, and VLAN SVIs, are removed when that list is saved and again the next time discovery syncs the device.
          </p>
        </header>
        {interfaces.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No interfaces returned.</p>
        ) : (
          <ul>
            <li className="hidden grid-cols-[auto_4rem_minmax(0,1fr)_minmax(0,16rem)_5rem] gap-3 border-b border-line px-4 py-2 font-mono text-xs uppercase tracking-widest text-faint sm:grid">
              <span />
              <span>Index</span>
              <span>Name</span>
              <span>Description</span>
              <span>Status</span>
            </li>
            {interfaces.map((iface) => {
              const index = String(iface.index);
              const disabled = iface.adminStatus === 2;
              const up = iface.operStatus === 1 && !disabled;
              const state = iface.ignored ? 'ignored' : disabled ? 'disabled' : up ? 'up' : 'down';
              return (
                <li key={index} className="grid grid-cols-1 items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[auto_4rem_minmax(0,1fr)_minmax(0,16rem)_5rem]">
                  <Checkbox
                    checked={selected.includes(index)}
                    onCheckedChange={() => toggle(index)}
                    aria-label={`Poll ${iface.name || index}`}
                  />
                  <span className="font-mono text-xs text-faint">{index}</span>
                  <strong className="truncate font-mono text-sm font-medium">{iface.name || `if${index}`}</strong>
                  <span className="truncate text-sm text-muted">{iface.alias || ''}</span>
                  <span className={iface.ignored || disabled ? 'font-mono text-xs text-faint' : up ? 'font-mono text-xs text-accent' : 'font-mono text-xs text-down'}>
                    {state}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3 px-4 py-4">
          <Button tone="solid" onClick={save} disabled={saving}>
            <Save className="size-4" />
            {saving ? 'Saving…' : 'Save selection'}
          </Button>
          <Button tone="line" onClick={selectAllUp} disabled={saving || interfaces.length === 0}>
            Select all UP interfaces
          </Button>
          {status ? <span className="text-sm text-muted">{status}</span> : null}
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-faint">Delete device</h2>
          <p className="mt-2 text-sm text-muted">
            Removes this device, its interface history, cached SNMP credential, and active alerts.
          </p>
        </header>
        <div className="flex flex-wrap items-center gap-2 px-4 py-4">
          {confirmDelete ? (
            <>
              <Button tone="line" className="text-down" onClick={remove} disabled={saving}>Delete this device</Button>
              <Button tone="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button tone="line" onClick={() => setConfirmDelete(true)}>Delete device</Button>
          )}
        </div>
      </section>
    </div>
  );
}
