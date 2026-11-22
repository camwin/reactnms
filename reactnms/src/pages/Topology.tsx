import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function Topology() {
  const [devices, setDevices] = useState<any[]>([]);

  useEffect(() => {
    fetch(`${API}/api/discovery/results`)
      .then((r) => r.json())
      .then((d) => setDevices(d.results || []))
      .catch(() => {});
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Topology</h1>
        <p>Discovered devices. Full link mapping is not implemented yet.</p>
      </div>
      <div className="card">
        {devices.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No devices discovered. Run a scan on the Discovery page.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {devices.map((d) => (
              <li key={d.ip} style={{ padding: '8px 0', borderBottom: '1px solid #334155' }}>
                <Link to={`/devices/${encodeURIComponent(d.ip)}`} style={{ color: '#e2e8f0', textDecoration: 'none' }}>
                  <strong>{d.sysName || d.ip}</strong> <span className="mono" style={{ color: '#94a3b8' }}>{d.ip}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

