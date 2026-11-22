import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Activity, Server } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function Dashboard() {
  const [devices, setDevices] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [widgets, setWidgets] = useState<string[]>(['alerts', 'devices', 'top']);

  useEffect(() => {
    fetch(`${API}/api/discovery/results`).then((r) => r.json()).then((d) => setDevices(d.results || [])).catch(() => {});
    fetch(`${API}/api/alerts/rules`).then((r) => r.json()).then(setRules).catch(() => {});
  }, []);

  function toggleWidget(id: string) {
    setWidgets((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  }

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <label style={{ color: '#94a3b8' }}><input type="checkbox" checked={widgets.includes('alerts')} onChange={() => toggleWidget('alerts')} /> Alerts</label>
          <label style={{ color: '#94a3b8' }}><input type="checkbox" checked={widgets.includes('devices')} onChange={() => toggleWidget('devices')} /> Devices</label>
          <label style={{ color: '#94a3b8' }}><input type="checkbox" checked={widgets.includes('top')} onChange={() => toggleWidget('top')} /> Top interfaces</label>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {widgets.includes('alerts') && (
          <div className="card">
            <h3><Bell size={18} /> Alerts</h3>
            {rules.length === 0 ? (
              <p style={{ color: '#94a3b8' }}>No rules. <Link to="/alerts" style={{ color: '#3b82f6' }}>Create one</Link></p>
            ) : (
              rules.slice(0, 5).map((r) => (
                <div key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid #334155' }}>
                  <strong>{r.name}</strong>
                  <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>{r.device} · {r.metric} {r.op} {r.threshold} {r.unit}</div>
                </div>
              ))
            )}
          </div>
        )}

        {widgets.includes('devices') && (
          <div className="card">
            <h3><Server size={18} /> Devices</h3>
            {devices.length === 0 ? (
              <p style={{ color: '#94a3b8' }}>None discovered. <Link to="/discovery" style={{ color: '#3b82f6' }}>Run a scan</Link></p>
            ) : (
              devices.slice(0, 6).map((d) => (
                <div key={d.ip} style={{ padding: '6px 0', borderBottom: '1px solid #334155' }}>
                  <Link to={`/devices/${encodeURIComponent(d.ip)}`} style={{ color: '#e2e8f0', textDecoration: 'none' }}>
                    <strong>{d.sysName || d.ip}</strong> <span className="mono" style={{ color: '#94a3b8' }}>{d.ip}</span>
                  </Link>
                </div>
              ))
            )}
          </div>
        )}

        {widgets.includes('top') && (
          <div className="card">
            <h3><Activity size={18} /> Top interfaces</h3>
            <p style={{ color: '#94a3b8' }}>Select interfaces on a device to start collecting rates.</p>
            <Link to="/devices" style={{ color: '#3b82f6' }}>Go to devices</Link>
          </div>
        )}
      </div>
    </div>
  );
}
