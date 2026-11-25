import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { FilterChip, Panel } from '@/components/nms/bits';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { createAlertRule, deleteAlertRule, fetchAlertRules, patchAlertRule, type AlertRule } from '@/lib/api';

type Filter = 'all' | 'enabled' | 'disabled';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'enabled', label: 'Enabled' },
  { id: 'disabled', label: 'Disabled' },
];

export default function Alerts() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [iface, setIface] = useState('');
  const [metric, setMetric] = useState<'in' | 'out'>('in');
  const [op, setOp] = useState<'gt' | 'lt'>('gt');
  const [threshold, setThreshold] = useState(100);
  const [unit, setUnit] = useState<AlertRule['unit']>('Mbps');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancel = false;
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

  const rows = rules.filter((rule) => {
    if (filter === 'enabled') return rule.enabled !== false;
    if (filter === 'disabled') return rule.enabled === false;
    return true;
  });

  async function add() {
    if (!name || !device) return;
    const rule: AlertRule = {
      id: Date.now().toString(),
      name,
      device,
      interface: iface,
      metric,
      op,
      threshold,
      unit,
      enabled: true,
    };
    try {
      await createAlertRule(rule);
      setRules((current) => [...current, rule]);
      setName('');
      setStatus('');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Could not add rule');
    }
  }

  async function remove(id: string) {
    try {
      await deleteAlertRule(id);
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Could not delete rule');
    }
  }

  async function toggle(id: string) {
    const rule = rules.find((item) => item.id === id);
    if (!rule) return;
    const enabled = rule.enabled === false;
    setRules((current) => current.map((item) => (item.id === id ? { ...item, enabled } : item)));
    try {
      await patchAlertRule(id, { enabled });
    } catch (err: unknown) {
      setRules((current) => current.map((item) => (item.id === id ? rule : item)));
      setStatus(err instanceof Error ? err.message : 'Could not update rule');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alert rules</h1>
        <p className="mt-1 text-sm text-muted">Threshold rules stored on the backend. They are not evaluated into a live event stream.</p>
      </div>

      <Panel title="New rule">
        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Input placeholder="Name" aria-label="Rule name" value={name} onChange={(event) => setName(event.target.value)} />
            <Input placeholder="Device IP" aria-label="Device IP" value={device} onChange={(event) => setDevice(event.target.value)} className="font-mono" />
            <Input
              placeholder="Interface index (optional)"
              aria-label="Interface index"
              value={iface}
              onChange={(event) => setIface(event.target.value)}
              className="font-mono"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              ariaLabel="Metric"
              value={metric}
              onValueChange={(value) => setMetric(value as 'in' | 'out')}
              options={[
                { value: 'in', label: 'in' },
                { value: 'out', label: 'out' },
              ]}
            />
            <Select
              ariaLabel="Comparison"
              value={op}
              onValueChange={(value) => setOp(value as 'gt' | 'lt')}
              options={[
                { value: 'gt', label: 'greater than' },
                { value: 'lt', label: 'less than' },
              ]}
            />
            <Input
              type="number"
              aria-label="Threshold"
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              className="w-28"
            />
            <Select
              ariaLabel="Unit"
              value={unit}
              onValueChange={(value) => setUnit(value as AlertRule['unit'])}
              options={['bps', 'Kbps', 'Mbps', 'Gbps'].map((item) => ({ value: item, label: item }))}
            />
            <Button tone="solid" onClick={add}>
              <Plus className="size-4" />
              Add
            </Button>
          </div>
          {status ? <p className="text-sm text-down">{status}</p> : null}
        </div>
      </Panel>

      <div className="flex gap-2 overflow-x-auto">
        {FILTERS.map((item) => (
          <FilterChip key={item.id} active={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </FilterChip>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-4 py-8 text-sm text-muted">No rules in this view.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((rule) => (
            <li key={rule.id} className="rounded-xl border border-line bg-surface px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold">{rule.name}</h2>
                  <p className="mt-1 font-mono text-sm text-muted">
                    {rule.device}
                    {rule.interface ? ` if${rule.interface}` : ''} · {rule.metric} {rule.op === 'gt' ? 'greater than' : 'less than'}{' '}
                    {rule.threshold} {rule.unit}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button tone="line" onClick={() => toggle(rule.id)}>
                    {rule.enabled === false ? 'Enable' : 'Disable'}
                  </Button>
                  <Button tone="ghost" onClick={() => remove(rule.id)} aria-label={`Delete ${rule.name}`}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
