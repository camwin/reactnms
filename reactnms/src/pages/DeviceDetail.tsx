import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Server, Activity, Settings, Database } from 'lucide-react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function toRateSeries(points: any[]) {
  if (!points || points.length < 2) return { xs: [], ins: [], outs: [] };
  const xs: number[] = [];
  const ins: number[] = [];
  const outs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const dt = (cur.t - prev.t) / 1000;
    if (dt <= 0) continue;
    const inRate = Math.max(0, (cur.in - prev.in) * 8 / dt); // bits/sec
    const outRate = Math.max(0, (cur.out - prev.out) * 8 / dt);
    xs.push(cur.t / 1000);
    ins.push(inRate);
    outs.push(outRate);
  }
  return { xs, ins, outs };
}

function formatRate(bps: number) {
  if (bps >= 1_000_000_000) return (bps / 1_000_000_000).toFixed(2) + ' Gbps';
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(2) + ' Mbps';
  if (bps >= 1_000) return (bps / 1_000).toFixed(1) + ' Kbps';
  return Math.round(bps) + ' bps';
}

function InterfaceChart({ idx, data }: { idx: string; data: any[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const rates = toRateSeries(data);

  useEffect(() => {
    if (!ref.current || rates.xs.length < 2) return;
    if (plotRef.current) plotRef.current.destroy();
    plotRef.current = new uPlot({
      width: ref.current.clientWidth || 700,
      height: 180,
      series: [
        {},
        { label: 'in', stroke: '#60a5fa', width: 2, value: (_u, v) => formatRate(v) },
        { label: 'out', stroke: '#4ade80', width: 2, value: (_u, v) => formatRate(v) },
      ],
      scales: { x: { time: true }, y: { range: [0, null] } },
      axes: [
        { stroke: '#cbd5e1', grid: { stroke: '#334155' }, ticks: { stroke: '#64748b' } },
        {
          stroke: '#cbd5e1',
          grid: { stroke: '#334155' },
          ticks: { stroke: '#64748b' },
          label: 'rate',
          values: (_u, vals) => vals.map((v) => formatRate(v)),
        },
      ],
    }, [rates.xs, rates.ins, rates.outs], ref.current);
    return () => { plotRef.current?.destroy(); plotRef.current = null; };
  }, [data, idx]);

  const lastIn = rates.ins.length ? rates.ins[rates.ins.length - 1] : 0;
  const lastOut = rates.outs.length ? rates.outs[rates.outs.length - 1] : 0;

  return (
    <div>
      <div style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: 4 }}>
        Current: in {formatRate(lastIn)} · out {formatRate(lastOut)}
      </div>
      <div ref={ref} style={{ width: '100%' }} />
    </div>
  );
}

export default function DeviceDetail() {
  const { ip } = useParams<{ ip: string }>();
  const [device, setDevice] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<Record<string, any[]>>({});
  const [range, setRange] = useState('1h');
  const [realtime, setRealtime] = useState(true);
  const [stats, setStats] = useState<any>(null);

  async function loadDevice() {
    if (!ip) return;
    setLoading(true);
    setError('');
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      const r = await fetch(`${API}/api/devices/${encodeURIComponent(ip)}`, { signal: controller.signal });
      clearTimeout(t);
      const data = await r.json();
      if (!r.ok || data.error) setError(data.error || `HTTP ${r.status}`);
      else setDevice(data);
    } catch (e: any) {
      setError(e.name === 'AbortError' ? 'Request timed out' : e.message);
    } finally {
      setLoading(false);
    }
  }

  async function loadSelections() {
    if (!ip) return;
    const r = await fetch(`${API}/api/devices/${encodeURIComponent(ip)}/selections`);
    setSelected(await r.json() || []);
  }

  async function loadHistory() {
    if (!ip || selected.length === 0) return;
    const now = Date.now();
    const from = range === '1h' ? now - 3600_000 : range === '6h' ? now - 6 * 3600_000 : now - 24 * 3600_000;
    const res = range === '1h' ? 'raw' : '1m';
    const r = await fetch(`${API}/api/devices/${encodeURIComponent(ip)}/traffic?if=${selected.join(',')}&from=${from}&to=${now}&res=${res}`);
    setHistory(await r.json());
  }

  async function loadStats() {
    if (!ip) return;
    const r = await fetch(`${API}/api/devices/${encodeURIComponent(ip)}/stats`);
    setStats(await r.json());
  }

  useEffect(() => { loadDevice(); loadSelections(); loadStats(); }, [ip]);

  useEffect(() => {
    if (selected.length === 0 || !realtime) return;
    loadHistory();
    const id = setInterval(loadHistory, 5000);
    return () => clearInterval(id);
  }, [ip, selected, range, realtime]);

  if (loading) return <div style={{ padding: 24 }}>Loading device…</div>;
  if (error || !device) {
    return (
      <div style={{ padding: 24 }}>
        <Link to="/devices" style={{ color: '#94a3b8' }}><ArrowLeft size={16} /> Back</Link>
        <h2 style={{ color: '#f87171' }}>Could not load device</h2>
        <p>{error}</p>
      </div>
    );
  }

  const uptimeHours = Math.floor((device.sysUpTime || 0) / 100 / 3600);
  const ifaceNames: Record<string, string> = {};
  (device.interfaces || []).forEach((i: any) => {
    const base = i.name || `if${i.index}`;
    const desc = i.customDesc || '';
    ifaceNames[String(i.index)] = desc ? `${base} — ${desc}` : base;
  });

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link to="/devices" style={{ color: '#94a3b8', textDecoration: 'none' }}><ArrowLeft size={16} /> Devices</Link>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to={`/devices/${encodeURIComponent(ip!)}/settings`} className="btn-secondary" style={{ textDecoration: 'none' }}>
            <Settings size={16} /> Interface Settings
          </Link>
        </div>
      </div>

      <div className="page-header">
        <h1><Server size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} />{device.sysName || device.ip}</h1>
        <p className="mono">{device.ip}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div className="card">
          <h3>Overview</h3>
          <table style={{ width: '100%' }}>
            <tbody>
              <tr><td style={{ color: '#94a3b8', width: 120 }}>Description</td><td>{device.sysDescr || '—'}</td></tr>
              <tr><td style={{ color: '#94a3b8' }}>Location</td><td>{device.sysLocation || '—'}</td></tr>
              <tr><td style={{ color: '#94a3b8' }}>Uptime</td><td>{uptimeHours}h</td></tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3><Activity size={18} /> Status</h3>
          <p style={{ color: '#34d399' }}>SNMP reachable</p>
          <p style={{ color: '#94a3b8' }}>{selected.length} interfaces selected</p>
          {stats && (
            <div style={{ marginTop: 8, fontSize: '0.85rem', color: '#94a3b8' }}>
              <Database size={14} style={{ verticalAlign: 'middle' }} />{' '}
              {stats.rawSamples.toLocaleString()} raw samples · {(stats.dbSizeBytes / 1024).toFixed(1)} KB DB
            </div>
          )}
        </div>
      </div>

      {selected.length === 0 ? (
        <div className="card">
          <p style={{ color: '#94a3b8' }}>No interfaces selected. <Link to={`/devices/${ip}/settings`} style={{ color: '#3b82f6' }}>Configure</Link></p>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              <option value="1h">Last hour (raw)</option>
              <option value="6h">Last 6h (1m)</option>
              <option value="24h">Last 24h (1m)</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={realtime} onChange={(e) => setRealtime(e.target.checked)} />
              Realtime
            </label>
            <button className="btn-secondary" onClick={loadHistory}>Refresh now</button>
          </div>

          {selected.map((idx) => {
            const points = history[idx] || [];
            return (
              <div key={idx} className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>{ifaceNames[idx] || `Interface ${idx}`}</h3>
                <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 4 }}>
                  {points.length} points
                </div>
                {points.length < 2 ? (
                  <p style={{ color: '#94a3b8' }}>Collecting data… ({points.length}/2)</p>
                ) : (
                  <InterfaceChart idx={idx} data={points} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
