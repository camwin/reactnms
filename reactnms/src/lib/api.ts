export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function apiBase() {
  const raw = import.meta.env.VITE_API_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  return raw.replace(/\/$/, '');
}

async function errorMessage(res: Response) {
  const text = await res.text();
  if (!text) return `HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: string };
    if (body.error) return body.error;
  } catch {
    /* response was plain text */
  }
  return text;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, init);
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res.json() as Promise<T>;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export type DiscoveredDevice = {
  ip: string;
  sysName?: string;
  sysDescr?: string;
  subnet?: string;
  discoveredAt?: string;
  method?: string;
  credentialName?: string;
};

export type DiscoveryLogLine = {
  t: string;
  level: string;
  message: string;
};

export type DiscoveryStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  currentSubnet: string | null;
  currentCredential: string | null;
  hostsScanned: number;
  hostsTotal: number;
  found: number;
  lastRun: string | null;
  resultCount: number;
  log: DiscoveryLogLine[];
};

export type NetboxImportResult = {
  count: number;
  added: number;
  skipped: number;
  plannedHosts: number;
  subnets: string[];
  truncated: boolean;
  pages: number;
  tag: string;
  role: string;
  roleName: string;
};

export type DiscoveryResults = {
  lastRun: string | null;
  count: number;
  results: DiscoveredDevice[];
};

export type SnmpCredential = {
  id: string;
  name: string;
  version: '2c' | '3';
  community?: string;
  user?: string;
  authKey?: string;
  privKey?: string;
};

export type DiscoveryConfig = {
  subnets: string[];
  community: string;
  credentials: SnmpCredential[];
  schedule: { enabled: boolean; cron: string };
  netbox: { url?: string; token?: string; tag?: string; role?: string };
  lastRun: string | null;
  results?: DiscoveredDevice[];
};

export type AlertRule = {
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

export type PolledInterface = {
  index: string;
  name: string;
  type: number;
  speed: number;
  adminStatus: number;
  operStatus: number;
  inOctets: number;
  outOctets: number;
  customDesc?: string;
};

export type DevicePoll = {
  ip: string;
  community?: string;
  sysDescr: string;
  sysName: string;
  sysLocation: string;
  sysUpTime: number;
  sysContact: string;
  interfaces: PolledInterface[];
  credential?: string;
};

export type TrafficPoint = { t: number; in: number; out: number };

export type DeviceStats = {
  ip: string;
  rawSamples: number;
  rawApproxBytes: number;
  rolledSamples: number;
  dbSizeBytes: number;
};

export type TrafficRange = '1h' | '6h' | '24h';

export function fetchHealth() {
  return request<{ ok: boolean; discovery: boolean }>('/api/health');
}

export function fetchDiscoveryResults() {
  return request<DiscoveryResults>('/api/discovery/results');
}

export function fetchDiscoveryConfig() {
  return request<DiscoveryConfig>('/api/discovery/config');
}

export function saveDiscoveryConfig(body: Partial<DiscoveryConfig> & Record<string, unknown>) {
  return request<DiscoveryConfig>('/api/discovery/config', jsonInit('POST', body));
}

export function fetchDiscoveryStatus() {
  return request<DiscoveryStatus>('/api/discovery/status');
}

export function scanDiscovery(body: { subnets?: string[] }) {
  return request<DiscoveryStatus & { started?: boolean; count?: number }>('/api/discovery/scan', jsonInit('POST', body));
}

export function importNetboxPrefixes(body: { tag?: string; role?: string }) {
  return request<NetboxImportResult>('/api/netbox/import', jsonInit('POST', { ...body, type: 'prefixes' }));
}

export function fetchAlertRules() {
  return request<AlertRule[]>('/api/alerts/rules');
}

export function createAlertRule(rule: AlertRule) {
  return request<AlertRule>('/api/alerts/rules', jsonInit('POST', rule));
}

export function patchAlertRule(id: string, body: Partial<AlertRule>) {
  return request<{ ok: boolean }>(`/api/alerts/rules/${encodeURIComponent(id)}`, jsonInit('PATCH', body));
}

export function deleteAlertRule(id: string) {
  return request<{ ok: boolean }>(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchDevice(ip: string, signal?: AbortSignal) {
  return request<DevicePoll>(`/api/devices/${encodeURIComponent(ip)}`, { signal });
}

export function fetchSelections(ip: string) {
  return request<string[]>(`/api/devices/${encodeURIComponent(ip)}/selections`);
}

export function saveSelections(ip: string, indexes: string[]) {
  return request<string[]>(`/api/devices/${encodeURIComponent(ip)}/selections`, jsonInit('POST', { indexes }));
}

export function fetchDescriptions(ip: string) {
  return request<Record<string, string>>(`/api/devices/${encodeURIComponent(ip)}/descriptions`);
}

export function saveDescription(ip: string, index: string, description: string) {
  return request<{ ok: boolean }>(
    `/api/devices/${encodeURIComponent(ip)}/descriptions`,
    jsonInit('POST', { index, description }),
  );
}

export function fetchStats(ip: string) {
  return request<DeviceStats>(`/api/devices/${encodeURIComponent(ip)}/stats`);
}

export function fetchTraffic(ip: string, indexes: string[], range: TrafficRange) {
  const now = Date.now();
  const from = range === '1h' ? now - 3_600_000 : range === '6h' ? now - 6 * 3_600_000 : now - 24 * 3_600_000;
  const params = new URLSearchParams({
    if: indexes.join(','),
    from: String(from),
    to: String(now),
    res: range === '1h' ? 'raw' : '1m',
  });
  return request<Record<string, TrafficPoint[]>>(`/api/devices/${encodeURIComponent(ip)}/traffic?${params}`);
}
