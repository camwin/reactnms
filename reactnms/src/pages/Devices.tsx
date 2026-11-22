import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Network } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function Devices() {
  const [devices, setDevices] = useState<any[]>([]);

  useEffect(() => {
    fetch(`${API}/api/discovery/results`)
      .then((r) => r.json())
      .then((data) => setDevices(data.results || []))
      .catch(() => setDevices([]));
  }, []);

  return (
    <div>
      <h1><Network size={24} style={{ verticalAlign: 'middle', marginRight: 8 }} />Devices</h1>
      {devices.length === 0 ? (
        <p>No devices yet. Run discovery.</p>
      ) : (
        <table className="devices-table">
          <thead>
            <tr><th>Name</th><th>IP</th><th>Description</th></tr>
          </thead>
          <tbody>
            {devices.map((d, i) => (
              <tr key={i}>
                <td>
                  <Link to={`/devices/${encodeURIComponent(d.ip)}`} style={{ color: '#3b82f6', textDecoration: 'none' }}>
                    {d.sysName || d.ip}
                  </Link>
                </td>
                <td className="mono">{d.ip}</td>
                <td>{d.sysDescr}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}