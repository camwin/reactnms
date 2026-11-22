import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function DeviceSettings() {
  const { ip } = useParams<{ ip: string }>();
  const [interfaces, setInterfaces] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  const [descriptions, setDescriptions] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!ip) return;
    Promise.all([
      fetch(`${API}/api/devices/${encodeURIComponent(ip)}`).then((r) => r.json()),
      fetch(`${API}/api/devices/${encodeURIComponent(ip)}/selections`).then((r) => r.json()),
      fetch(`${API}/api/devices/${encodeURIComponent(ip)}/descriptions`).then((r) => r.json()),
    ]).then(([dev, sel, descs]) => {
      setInterfaces(dev.interfaces || []);
      setSelected(sel || []);
      setDescriptions(descs || {});
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [ip]);

  function toggle(idx: string) {
    setSelected((prev) => (prev.includes(idx) ? prev.filter((x) => x !== idx) : [...prev, idx]));
  }

  async function saveDesc(idx: string, value: string) {
    if (!ip) return;
    await fetch(`${API}/api/devices/${encodeURIComponent(ip)}/descriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: idx, description: value }),
    });
  }

  async function save() {
    if (!ip) return;
    setSaving(true);
    setStatus('');
    try {
      await fetch(`${API}/api/devices/${encodeURIComponent(ip)}/selections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ indexes: selected }),
      });
      setStatus('Saved');
    } catch (e: any) {
      setStatus('Failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading interfaces…</div>;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Link to={`/devices/${encodeURIComponent(ip!)}`} style={{ color: '#94a3b8', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={16} /> Back to device
        </Link>
      </div>

      <div className="page-header">
        <h1>Interface Settings</h1>
        <p className="mono">{ip}</p>
      </div>

      <div className="card">
        <p style={{ color: '#94a3b8' }}>Select which interfaces to poll and graph. Only selected interfaces are recorded to history.</p>
        <div style={{ marginTop: 12 }}>
          {interfaces.map((iface) => (
            <label key={iface.index} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #334155' }}>
              <input
                type="checkbox"
                checked={selected.includes(String(iface.index))}
                onChange={() => toggle(String(iface.index))}
              />
              <span className="mono" style={{ width: 60 }}>{iface.index}</span>
              <strong>{iface.name || `if${iface.index}`}</strong>
              <input
                type="text"
                placeholder="description"
                value={descriptions[String(iface.index)] || ''}
                onChange={(e) => setDescriptions((d) => ({ ...d, [String(iface.index)]: e.target.value }))}
                onBlur={(e) => saveDesc(String(iface.index), e.target.value)}
                style={{ flex: 1, maxWidth: 280, padding: '4px 8px', background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', borderRadius: 4 }}
              />
              <span style={{ color: '#94a3b8', marginLeft: 8 }}>
                {iface.operStatus === 1 ? 'up' : 'down'}
              </span>
            </label>
          ))}
        </div>
        <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
          <button className="btn-primary" onClick={save} disabled={saving}>
            <Save size={16} /> {saving ? 'Saving…' : 'Save Selection'}
          </button>
          {status && <span style={{ color: '#94a3b8' }}>{status}</span>}
        </div>
      </div>
    </div>
  );
}
