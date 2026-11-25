import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  fetchDescriptions,
  fetchDevice,
  fetchSelections,
  saveDescription,
  saveSelections,
  type PolledInterface,
} from '@/lib/api';

export default function DeviceSettings() {
  const { ip } = useParams<{ ip: string }>();
  const [interfaces, setInterfaces] = useState<PolledInterface[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!ip) return;
    let cancel = false;
    Promise.all([fetchDevice(ip), fetchSelections(ip), fetchDescriptions(ip)])
      .then(([device, selection, labels]) => {
        if (cancel) return;
        setInterfaces(device.interfaces || []);
        setSelected((selection || []).map(String));
        setDescriptions(labels || {});
      })
      .catch(() => {
        if (!cancel) setStatus('Could not load interfaces');
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [ip]);

  function toggle(index: string) {
    setSelected((prev) => (prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index]));
  }

  async function saveDesc(index: string, value: string) {
    if (!ip) return;
    try {
      await saveDescription(ip, index, value);
    } catch (err: unknown) {
      setStatus(err instanceof Error ? `Description failed: ${err.message}` : 'Description failed');
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

  if (!ip) return null;
  if (loading) return <div className="px-1 py-6 text-sm text-muted">Loading interfaces…</div>;

  return (
    <div className="flex flex-col gap-4">
      <Link to={`/devices/${encodeURIComponent(ip)}`} className="inline-flex min-h-11 items-center gap-1 text-sm text-muted">
        <ChevronLeft className="size-4" aria-hidden />
        Back to device
      </Link>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Interface settings</h1>
        <p className="mt-1 font-mono text-sm text-muted">{ip}</p>
      </div>

      <section className="rounded-xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-mono text-xs uppercase tracking-widest text-faint">Polled interfaces</h2>
          <p className="mt-2 text-sm text-muted">Only selected interfaces are recorded to history. Descriptions save when the field loses focus.</p>
        </header>
        {interfaces.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No interfaces returned.</p>
        ) : (
          <ul>
            {interfaces.map((iface) => {
              const index = String(iface.index);
              return (
                <li key={index} className="grid grid-cols-1 items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[auto_4rem_minmax(0,1fr)_minmax(0,16rem)_4rem]">
                  <Checkbox
                    checked={selected.includes(index)}
                    onCheckedChange={() => toggle(index)}
                    aria-label={`Poll ${iface.name || index}`}
                  />
                  <span className="font-mono text-xs text-faint">{index}</span>
                  <strong className="truncate font-mono text-sm font-medium">{iface.name || `if${index}`}</strong>
                  <Input
                    value={descriptions[index] || ''}
                    placeholder="Description"
                    onChange={(event) => setDescriptions((current) => ({ ...current, [index]: event.target.value }))}
                    onBlur={(event) => saveDesc(index, event.target.value)}
                  />
                  <span className={iface.operStatus === 1 ? 'font-mono text-xs text-accent' : 'font-mono text-xs text-down'}>
                    {iface.operStatus === 1 ? 'up' : 'down'}
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
          {status ? <span className="text-sm text-muted">{status}</span> : null}
        </div>
      </section>
    </div>
  );
}
