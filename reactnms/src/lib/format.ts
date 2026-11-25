export function formatRate(bps: number) {
  if (!Number.isFinite(bps)) return '—';
  if (bps >= 1_000_000_000) return (bps / 1_000_000_000).toFixed(2) + ' Gbps';
  if (bps >= 1_000_000) return (bps / 1_000_000).toFixed(2) + ' Mbps';
  if (bps >= 1_000) return (bps / 1_000).toFixed(1) + ' Kbps';
  return Math.round(bps) + ' bps';
}

const UNKNOWN_IF_SPEED = 4_294_967_295;

export function knownSpeed(bps?: number) {
  if (!bps || bps <= 0 || bps >= UNKNOWN_IF_SPEED) return 0;
  return bps;
}

export function formatSpeed(bps?: number) {
  const speed = knownSpeed(bps);
  if (!speed) return null;
  if (speed >= 1_000_000_000 && speed % 1_000_000_000 === 0) return `${speed / 1_000_000_000}G`;
  if (speed >= 1_000_000 && speed % 1_000_000 === 0) return `${speed / 1_000_000}M`;
  if (speed >= 1_000 && speed % 1_000 === 0) return `${speed / 1_000}K`;
  return formatRate(speed);
}

export function formatSnmpUptime(ticks: number) {
  const sec = Math.floor((ticks || 0) / 100);
  if (sec <= 0) return '—';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((sec % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export function formatWhen(iso?: string | null) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function formatAgo(iso?: string | null) {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never';
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
