import { useEffect, useState } from 'react';
import { Plus, Trash2, Bell } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

type AlertRule = {
  id: string;
  name: string;
  device: string;
  interface: string;
  metric: 'in' | 'out';
  op: 'gt' | 'lt';
  threshold: number;
  unit: 'bps' | 'Kbps' | 'Mbps' | 'Gbps';
  enabled: boolean;
};

export default function Alerts() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  const [iface, setIface] = useState('');
  const [metric, setMetric] = useState<'in' | 'out'>('in');
  const [op, setOp] = useState<'gt' | 'lt'>('gt');
  const [threshold, setThreshold] = useState(100);
  const [unit, setUnit] = useState<'bps' | 'Kbps' | 'Mbps' | 'Gbps'>('Mbps');

  useEffect(() => {
    fetch(`${API}/api/alerts/rules`).then((r) => r.json()).then(setRules).catch(() => {});
  }, []);

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
    await fetch(`${API}/api/alerts/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rule),
    });
    setRules((r) => [...r, rule]);
    setName('');
  }

  async function remove(id: string) {
    await fetch(`${API}/api/alerts/rules/${id}`, { method: 'DELETE' });
    setRules((r) => r.filter((x) => x.id !== id));
  }

  async function toggle(id: string) {
    const next = rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    setRules(next);
    const rule = next.find((r) => r.id === id);
    if (rule) {
      await fetch(`${API}/api/alerts/rules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: rule.enabled }),
      });
    }
  }

  const opLabel = (v: string) => (v === 'gt' ? 'greater than' : 'less than');

  return (
    <div>
      <div className="page-header">
        <h1><Bell size={24} style={{ verticalAlign: 'middle', marginRight: 8 }} />Alerts</h1>
        <p>Simple threshold rules. Evaluated against recent traffic rates.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>New rule</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          <input placeholder="Device IP" value={device} onChange={(e) => setDevice(e.target.value)} style={inputStyle} />
          <input placeholder="Interface index (optional)" value={iface} onChange={(e) => setIface(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={metric} onChange={(e) => setMetric(e.target.value as any)} style={inputStyle}>
            <option value="in">in</option>
            <option value="out">out</option>
          </select>
          <select value={op} onChange={(e) => setOp(e.target.value as any)} style={inputStyle}>
            <option value="gt">greater than</option>
            <option value="lt">less than</option>
          </select>
          <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} style={{ ...inputStyle, width: 100 }} />
          <select value={unit} onChange={(e) => setUnit(e.target.value as any)} style={inputStyle}>
            <option value="bps">bps</option>
            <option value="Kbps">Kbps</option>
            <option value="Mbps">Mbps</option>
            <option value="Gbps">Gbps</option>
          </select>
          <button className="btn-primary" onClick={add}><Plus size={16} /> Add</button>
        </div>
      </div>

      <div className="card">
        {rules.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No rules yet.</p>
        ) : (
          rules.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #334155' }}>
              <div>
                <strong>{r.name}</strong>
                <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                  {r.device} {r.interface && `if${r.interface}`} · {r.metric} {opLabel(r.op)} {r.threshold} {r.unit}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" onClick={() => toggle(r.id)}>{r.enabled ? 'Disable' : 'Enable'}</button>
                <button className="btn-secondary" onClick={() => remove(r.id)}><Trash2 size={14} /></button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: '#1e293b',
  border: '1px solid #334155',
  color: '#e2e8f0',
  borderRadius: 4,
};
