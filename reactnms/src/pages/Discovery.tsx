import { useEffect, useState } from 'react';
import { Radar, Play, Clock, Database, RefreshCw, Plus, Trash2 } from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function Discovery() {
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  // Subnets
  const [subnets, setSubnets] = useState<string[]>([]);
  const [newSubnet, setNewSubnet] = useState('');

  // SNMP
  const [community, setCommunity] = useState('public');

  // Schedule
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [cron, setCron] = useState('0 */6 * * *');

  // NetBox integration
  const [netboxUrl, setNetboxUrl] = useState('');
  const [netboxToken, setNetboxToken] = useState('');
  const [netboxTag, setNetboxTag] = useState('');
  const [netboxRole, setNetboxRole] = useState('');
  const [netboxType, setNetboxType] = useState('prefixes');

  async function load() {
    try {
      const [cfgRes, resRes] = await Promise.all([
        fetch(`${API}/api/discovery/config`),
        fetch(`${API}/api/discovery/results`),
      ]);
      const cfg = await cfgRes.json();
      const res = await resRes.json();

      setSubnets(cfg.subnets || []);
      setCommunity(cfg.community || 'public');
      setScheduleEnabled(!!cfg.schedule?.enabled);
      setCron(cfg.schedule?.cron || '0 */6 * * *');
      setNetboxUrl(cfg.netbox?.url || '');
      setNetboxToken(cfg.netbox?.token || '');
      setNetboxTag(cfg.netbox?.tag || '');
      setNetboxRole(cfg.netbox?.role || '');
      setResults(res.results || []);
    } catch (e: any) {
      setStatus('Failed to load config: ' + e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function saveConfig() {
    setStatus('Saving…');
    try {
      await fetch(`${API}/api/discovery/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subnets,
          community,
          schedule: { enabled: scheduleEnabled, cron },
          netbox: {
            url: netboxUrl,
            token: netboxToken,
            tag: netboxTag,
            role: netboxRole,
          },
        }),
      });
      setStatus('Saved');
      setTimeout(() => setStatus(''), 2000);
    } catch (e: any) {
      setStatus('Save failed: ' + e.message);
    }
  }

  function addSubnet() {
    const s = newSubnet.trim();
    if (!s) return;
    if (!subnets.includes(s)) setSubnets([...subnets, s]);
    setNewSubnet('');
  }

  function removeSubnet(s: string) {
    setSubnets(subnets.filter((x) => x !== s));
  }

  async function runScan() {
    setLoading(true);
    setStatus('Scanning…');
    try {
      const resp = await fetch(`${API}/api/discovery/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subnets, community }),
      });
      const data = await resp.json();
      setStatus(`Found ${data.count || 0} devices`);
      await load();
    } catch (e: any) {
      setStatus('Scan failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function importFromNetbox() {
    if (!netboxUrl || !netboxToken) {
      setStatus('NetBox URL and API token required');
      return;
    }
    setLoading(true);
    setStatus('Importing from NetBox…');
    try {
      const resp = await fetch(`${API}/api/netbox/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: netboxUrl,
          token: netboxToken,
          tag: netboxTag || undefined,
          role: netboxRole || undefined,
          type: netboxType,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Import failed');

      if (netboxType === 'prefixes' && data.items) {
        const newOnes = data.items.map((i: any) => i.prefix).filter(Boolean);
        setSubnets((prev) => [...new Set([...prev, ...newOnes])]);
      }
      setStatus(`Imported ${data.count} ${netboxType}`);
    } catch (e: any) {
      setStatus('NetBox import failed: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="discovery-page">
      <div className="page-header">
        <h1><Radar size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />Discovery</h1>
        <p>Add subnets, schedule scans, or pull prefixes from NetBox</p>
        {status && <div style={{ marginTop: 8, color: '#94a3b8' }}>{status}</div>}
      </div>

      {/* Subnets */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Subnets to Scan</h3>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={newSubnet}
            onChange={(e) => setNewSubnet(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSubnet()}
            placeholder="192.168.1.0/24"
            style={{ flex: 1 }}
          />
          <button className="btn-secondary" onClick={addSubnet}><Plus size={16} /> Add</button>
        </div>
        {subnets.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No subnets added yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {subnets.map((s) => (
              <li key={s} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #334155' }}>
                <code>{s}</code>
                <button onClick={() => removeSubnet(s)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }}>
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'center' }}>
          <label>SNMP Community</label>
          <input value={community} onChange={(e) => setCommunity(e.target.value)} style={{ width: 140 }} />
          <button className="btn-primary" onClick={runScan} disabled={loading || subnets.length === 0}>
            <Play size={16} /> {loading ? 'Scanning…' : 'Scan Now'}
          </button>
          <button className="btn-secondary" onClick={saveConfig}>Save</button>
        </div>
      </div>

      {/* Schedule */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3><Clock size={18} /> Schedule</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={scheduleEnabled} onChange={(e) => setScheduleEnabled(e.target.checked)} />
          Enable scheduled discovery
        </label>
        <div style={{ marginTop: 8 }}>
          <label>Cron expression</label>
          <input value={cron} onChange={(e) => setCron(e.target.value)} style={{ width: 200, marginLeft: 8 }} placeholder="0 */6 * * *" />
          <span style={{ marginLeft: 8, color: '#94a3b8', fontSize: '0.85rem' }}>e.g. every 6 hours</span>
        </div>
        <button className="btn-secondary" style={{ marginTop: 8 }} onClick={saveConfig}>Update Schedule</button>
      </div>

      {/* NetBox Integration */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3><Database size={18} /> NetBox Integration</h3>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginTop: 0 }}>
          Pull prefixes (or devices) by tag and/or role. Prefixes are added to the scan list.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label>NetBox URL</label>
            <input value={netboxUrl} onChange={(e) => setNetboxUrl(e.target.value)} placeholder="https://netbox.example.com" style={{ width: '100%' }} />
          </div>
          <div>
            <label>API Token</label>
            <input type="password" value={netboxToken} onChange={(e) => setNetboxToken(e.target.value)} placeholder="Token" style={{ width: '100%' }} />
          </div>
          <div>
            <label>Tag (optional)</label>
            <input value={netboxTag} onChange={(e) => setNetboxTag(e.target.value)} placeholder="nms or management" style={{ width: '100%' }} />
          </div>
          <div>
            <label>Role (optional)</label>
            <input value={netboxRole} onChange={(e) => setNetboxRole(e.target.value)} placeholder="management or router" style={{ width: '100%' }} />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <select value={netboxType} onChange={(e) => setNetboxType(e.target.value)}>
            <option value="prefixes">Prefixes</option>
            <option value="devices">Devices</option>
          </select>
          <button className="btn-primary" onClick={importFromNetbox} disabled={loading}>
            <RefreshCw size={16} /> Import from NetBox
          </button>
          <button className="btn-secondary" onClick={saveConfig}>Save NetBox Settings</button>
        </div>
      </div>

      {/* Results */}
      <div className="card">
        <h3>Discovered Devices {results.length > 0 && `(${results.length})`}</h3>
        {results.length === 0 ? (
          <p style={{ color: '#94a3b8' }}>No devices discovered yet. Add subnets and scan, or import from NetBox.</p>
        ) : (
          <div className="table-container">
            <table className="devices-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>IP</th>
                  <th>Description</th>
                  <th>Subnet</th>
                  <th>Discovered</th>
                </tr>
              </thead>
              <tbody>
                {results.map((d, i) => (
                  <tr key={i}>
                    <td><strong>{d.sysName || d.ip}</strong></td>
                    <td className="mono">{d.ip}</td>
                    <td style={{ fontSize: '0.85rem', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.sysDescr}</td>
                    <td>{d.subnet}</td>
                    <td style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{new Date(d.discoveredAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
