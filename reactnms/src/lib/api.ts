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
  if (text.includes('<html') || text.length > 400) return `HTTP ${res.status}`;
  return text;
}

function redirectToLogin() {
  if (typeof window === 'undefined' || window.location.pathname.startsWith('/login')) return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { ...init, credentials: 'include' });
  if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/config') && !path.startsWith('/api/auth/session')) {
    redirectToLogin();
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res.json() as Promise<T>;
}

export function apiUrl(path: string) {
  return `${apiBase()}${path}`;
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
  sysLocation?: string;
  subnet?: string;
  discoveredAt?: string;
  method?: string;
  credentialName?: string;
  addresses?: string[];
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
  currentDevice: string | null;
  pollingDevice: string | null;
  log: DiscoveryLogLine[];
};

export type NetboxChoice = { id?: number; name: string; slug: string };

export type NetboxOptions = {
  regions: NetboxChoice[];
  roles: NetboxChoice[];
  tags: NetboxChoice[];
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
  region?: string;
  regionName?: string;
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

export type DeviceTypeChoice = { id: string; label: string };

export const DEVICE_TYPE_CHOICES: DeviceTypeChoice[] = [
  { id: 'cisco_ios', label: 'Cisco IOS' },
  { id: 'cisco_xe', label: 'Cisco IOS-XE' },
  { id: 'cisco_nxos', label: 'Cisco NX-OS' },
  { id: 'cisco_asa', label: 'Cisco ASA' },
  { id: 'cisco_xr', label: 'Cisco IOS-XR' },
  { id: 'extreme_exos', label: 'Extreme EXOS' },
  { id: 'extreme_vsp', label: 'Extreme VSP' },
  { id: 'axis', label: 'Axis' },
  { id: 'juniper_junos', label: 'Juniper Junos' },
  { id: 'arista_eos', label: 'Arista EOS' },
  { id: 'ipinfusion_ocnos', label: 'OcNOS' },
  { id: 'other', label: 'Other Netmiko type' },
];

export type ServiceAccount = {
  enabled: boolean;
  username: string;
  deviceType: string;
  passwordSet: boolean;
  enableSet: boolean;
  deviceTypes?: DeviceTypeChoice[];
};

export type BackupSchedule = {
  enabled: boolean;
  cron: string;
  lastRun?: string | null;
  lastError?: string;
};

export type SyslogConfig = {
  enabled: boolean;
  port: number;
  retainDays: number;
  maxRows: number;
  status?: string;
};

export type DirectoryAuth = {
  url: string;
  bindDn: string;
  baseDn: string;
  groupDn: string;
  userFilter: string;
  passwordSet: boolean;
};

export type AuthPublic = {
  mode: 'off' | 'local' | 'ad' | 'ldap' | 'sso' | string;
  ad: DirectoryAuth;
  ldap: DirectoryAuth;
  sso: { issuer: string; clientId: string; redirectUri: string; secretSet: boolean };
};

export type AuthUser = { username: string; createdAt: number };

export type SerialRow = { ip: string; serial: string; name: string; model: string };

export type NetworkSearchRow = {
  ip: string;
  hostname?: string;
  location?: string;
  match?: string;
  id?: string;
  name?: string;
  source?: string;
  serial?: string;
  model?: string;
};

export type DiscoveryConfig = {
  subnets: string[];
  community: string;
  credentials: SnmpCredential[];
  schedule: { enabled: boolean; cron: string };
  netbox: { url?: string; token?: string; tag?: string; role?: string; region?: string };
  interfaceIgnore?: string[];
  serviceAccount?: ServiceAccount;
  backupSchedule?: BackupSchedule;
  syslog?: SyslogConfig;
  auth?: AuthPublic;
  ignoredRemoved?: number;
  lastRun: string | null;
  results?: DiscoveredDevice[];
};

export type RuleCondition = { kind: 'cond'; entity: string; op: string; value: string };
export type RuleGroup = { join: 'AND' | 'OR'; items: RuleItem[] };
export type RuleItem = RuleCondition | ({ kind: 'group' } & RuleGroup);

export type AlertScope = {
  devices: string[];
  groups: string[];
  locations: string[];
  exclude: boolean;
};

export type AlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  severity: 'ok' | 'warning' | 'critical';
  notes: string;
  procedureUrl: string;
  invert: boolean;
  mute: boolean;
  notifyRecovery: boolean;
  notifyAck: boolean;
  operationId: string;
  advanced: boolean;
  sql: string;
  scope: AlertScope;
  builder: RuleGroup;
};

export type AlertOperation = {
  id: string;
  name: string;
  delaySec: number;
  repeatSec: number;
  steps: { afterSec: number; transportIds: string[] }[];
};

export type AlertTransport = {
  id: string;
  name: string;
  type: 'email' | 'webhook' | 'slack';
  target: string;
};

export type DeviceGroup = {
  id: string;
  name: string;
  members: string[];
};

export type ActiveAlert = {
  id: string;
  ruleId: string;
  deviceIp: string;
  ifIndex: string;
  hostname: string;
  ifName: string;
  ifAlias?: string;
  severity: 'ok' | 'warning' | 'critical';
  ruleName: string;
  message: string;
  procedureUrl: string;
  notes: string;
  ackMode: 'clear' | 'worsens' | null;
  ackedAt: number | null;
  metricValue: number | null;
  startedAt: number;
  muted: boolean;
};

export type AlertLogLine = {
  id: number;
  at: number;
  ruleId: string;
  deviceIp: string;
  kind: string;
  detail: string;
};

export type AlertTemplate = {
  id: string;
  name: string;
  severity: AlertRule['severity'];
  notes?: string;
  builder: RuleGroup;
};

export type AlertTestResult = {
  error: string | null;
  sql: string;
  params: unknown[];
  rows: Record<string, unknown>[];
  match: boolean;
  count: number;
};

export type TopologyLink = {
  a: string;
  b: string;
  protocol: 'cdp' | 'lldp';
  aPort?: string;
  bPort?: string;
};

export type TopologyView = {
  sites: { name: string; devices: DiscoveredDevice[] }[];
  links: TopologyLink[];
  scanning: boolean;
  scanned: number;
  total: number;
  updatedAt: string | null;
  error: string | null;
  defaultSite?: string;
  core?: string;
};

export type DeviceEvent = {
  id: number;
  at: number;
  deviceIp: string;
  hostname: string;
  kind: string;
  summary: string;
};

export type DevicePollStat = {
  lastMs: number | null;
  avgMs: number | null;
  lastAt: number | null;
  samples: number;
};

export type DeviceCredentialSettings = {
  credentialId: string;
  credentialName: string;
  credentials: { id: string; name: string; version: string }[];
  poll?: DevicePollStat;
  deviceType?: string;
  detectedType?: string;
  deviceTypes?: DeviceTypeChoice[];
};

export type PollDeviceRow = DevicePollStat & { ip: string; hostname: string };

export type PollerSummary = DevicePollStat & {
  currentDevice?: string | null;
  devices: PollDeviceRow[];
};

export type RouteRow = { dest: string; mask: string; nextHop: string; ifIndex: string; proto: string };
export type VlanRow = { id: string; name: string; source: string };
export type NeighborRow = { localIf: string; remoteName: string; remotePort: string; remoteAddr: string };
export type InventoryRow = { name: string; descr: string; model: string; serial: string; manufacturer: string };
export type SyslogRow = {
  id: number;
  at: number;
  sourceIp: string;
  host: string;
  severity: number;
  severityName: string;
  facilityName: string;
  message: string;
};

export type InterfaceErrorRow = {
  index: string;
  name: string;
  inDiscards: number;
  inErrors: number;
  outDiscards: number;
  outErrors: number;
};

export type DeviceErrors = {
  interfaces: InterfaceErrorRow[];
  syslog: SyslogRow[];
  reachability: DeviceEvent[];
  link: DeviceEvent[];
  switching: DeviceEvent[];
  error: string;
};

export type OpticReading = { name: string; rx: number | null; tx: number | null };
export type OpticSample = { name: string; t: number; rx: number | null; tx: number | null };
export type DeviceOptics = { detected: boolean; optics: OpticReading[]; history: OpticSample[]; error: string };
export type DeviceLogs = { events: DeviceEvent[]; syslog: SyslogRow[] };
export type DeviceConfigBackup = {
  enabled: boolean;
  deviceType: string;
  savedAt: number | null;
  body: string;
  error: string;
  ok?: boolean;
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
  alias?: string;
  customDesc?: string;
  ignored?: boolean;
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
  discoveredAt?: string | null;
  addresses?: string[];
  aliasKnown?: boolean;
  router?: boolean;
  configEnabled?: boolean;
  serials?: string;
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

export function importNetboxPrefixes(body: { tag?: string; role?: string; region?: string }) {
  return request<NetboxImportResult>('/api/netbox/import', jsonInit('POST', { ...body, type: 'prefixes' }));
}

export function fetchNetboxOptions(body?: { url?: string; token?: string }) {
  return request<NetboxOptions>('/api/netbox/options', jsonInit('POST', body || {}));
}

export function fetchAlertRules() {
  return request<AlertRule[]>('/api/alerts/rules');
}

export function createAlertRule(rule: AlertRule) {
  return request<AlertRule>('/api/alerts/rules', jsonInit('POST', rule));
}

export function patchAlertRule(id: string, body: Partial<AlertRule>) {
  return request<AlertRule>(`/api/alerts/rules/${encodeURIComponent(id)}`, jsonInit('PATCH', body));
}

export function deleteAlertRule(id: string) {
  return request<{ ok: boolean }>(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchAlertTemplates() {
  return request<AlertTemplate[]>('/api/alerts/templates');
}

export function fetchActiveAlerts() {
  return request<ActiveAlert[]>('/api/alerts/active');
}

export function fetchAlertLog(query = '', limit = 200, device = '') {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set('q', query);
  if (device) params.set('device', device);
  return request<AlertLogLine[]>(`/api/alerts/log?${params}`);
}

export function acknowledgeAlert(id: string, mode: 'clear' | 'worsens') {
  return request<ActiveAlert>(`/api/alerts/active/${encodeURIComponent(id)}/ack`, jsonInit('POST', { mode }));
}

export function testAlertRule(rule: AlertRule, device: string) {
  return request<AlertTestResult>('/api/alerts/test', jsonInit('POST', { rule, device }));
}

export function fetchAlertOperations() {
  return request<AlertOperation[]>('/api/alerts/operations');
}

export function saveAlertOperation(operation: AlertOperation) {
  return request<AlertOperation>('/api/alerts/operations', jsonInit('POST', operation));
}

export function deleteAlertOperation(id: string) {
  return request<{ ok: boolean }>(`/api/alerts/operations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchAlertTransports() {
  return request<AlertTransport[]>('/api/alerts/transports');
}

export function saveAlertTransport(transport: AlertTransport) {
  return request<AlertTransport>('/api/alerts/transports', jsonInit('POST', transport));
}

export function deleteAlertTransport(id: string) {
  return request<{ ok: boolean }>(`/api/alerts/transports/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchDeviceGroups() {
  return request<DeviceGroup[]>('/api/alerts/groups');
}

export function saveDeviceGroup(group: DeviceGroup) {
  return request<DeviceGroup>('/api/alerts/groups', jsonInit('POST', group));
}

export function deleteDeviceGroup(id: string) {
  return request<{ ok: boolean }>(`/api/alerts/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function fetchAlertLocations() {
  return request<string[]>('/api/alerts/locations');
}

export function fetchTopology() {
  return request<TopologyView>('/api/topology');
}

export function scanTopology() {
  return request<TopologyView>('/api/topology/scan', jsonInit('POST', {}));
}

export function saveTopologyDefault(site: string) {
  return request<TopologyView>('/api/topology/default', jsonInit('POST', { site }));
}

export function fetchEvents(device = '', query = '', limit = 200) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (device) params.set('device', device);
  if (query) params.set('q', query);
  return request<DeviceEvent[]>(`/api/events?${params}`);
}

export function discoverDevice(ip: string) {
  return request<{ ok: boolean; sysName?: string; discoveredAt?: string }>(`/api/devices/${encodeURIComponent(ip)}/discover`, jsonInit('POST', {}));
}

export function fetchDeviceSettings(ip: string) {
  return request<DeviceCredentialSettings>(`/api/devices/${encodeURIComponent(ip)}/settings`);
}

export function saveDeviceCredential(ip: string, credentialId: string) {
  return request<{ ok: boolean; credentialId: string }>(`/api/devices/${encodeURIComponent(ip)}/credential`, jsonInit('POST', { credentialId }));
}

export function deleteDevice(ip: string) {
  return request<{ ok: boolean }>(`/api/devices/${encodeURIComponent(ip)}`, { method: 'DELETE' });
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

export function fetchPoller() {
  return request<PollerSummary>('/api/poller');
}

export function saveServiceAccount(body: {
  enabled: boolean;
  username: string;
  password?: string;
  enable?: string;
  clearEnable?: boolean;
  schedule?: { enabled: boolean; cron: string };
}) {
  return request<ServiceAccount & { backupSchedule?: BackupSchedule }>('/api/settings/service-account', jsonInit('POST', body));
}

export function saveSyslog(body: { enabled: boolean; port: number; retainDays: number; maxRows: number }) {
  return request<SyslogConfig>('/api/settings/syslog', jsonInit('POST', body));
}

export function saveDeviceCli(ip: string, deviceType: string) {
  return request<{ ok: boolean; deviceType: string; detectedType?: string }>(`/api/devices/${encodeURIComponent(ip)}/cli`, jsonInit('POST', { deviceType }));
}

export function fetchCatalogSerials() {
  return request<{ serials: SerialRow[] }>('/api/catalog/serials');
}

export function fetchDeviceSerials(ip: string) {
  return request<{ serials: { serial: string; name: string; model: string }[]; error?: string }>(`/api/devices/${encodeURIComponent(ip)}/serials`);
}

export function fetchDeviceErrors(ip: string) {
  return request<DeviceErrors>(`/api/devices/${encodeURIComponent(ip)}/errors`);
}

export function fetchDeviceOptics(ip: string) {
  return request<DeviceOptics>(`/api/devices/${encodeURIComponent(ip)}/optics`);
}

export function fetchNetworkSearch(kind: string, query: string) {
  const params = new URLSearchParams({ kind, q: query });
  return request<{ kind: string; rows: NetworkSearchRow[]; catalogEmpty: boolean }>(`/api/network-search?${params}`);
}

export function fetchSyslog(query = '', severity = '') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (severity) params.set('severity', severity);
  const suffix = params.toString() ? `?${params}` : '';
  return request<{ status: string; enabled: boolean; rows: SyslogRow[] }>(`/api/syslog${suffix}`);
}

export function fetchAuthConfig() {
  return request<AuthPublic>('/api/auth/config');
}

export function fetchAuthSession() {
  return request<{ mode: string; username: string }>('/api/auth/session');
}

export function login(username: string, password: string) {
  return request<{ ok: boolean; username: string; mode: string }>('/api/auth/login', jsonInit('POST', { username, password }));
}

export function logout() {
  return request<{ ok: boolean }>('/api/auth/logout', jsonInit('POST', {}));
}

export function fetchAuthUsers() {
  return request<{ users: AuthUser[] }>('/api/auth/users');
}

export function createAuthUser(username: string, password: string) {
  return request<{ ok: boolean; username: string }>('/api/auth/users', jsonInit('POST', { username, password }));
}

export function deleteAuthUser(username: string) {
  return request<{ ok: boolean }>(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
}

export function saveAuthSettings(body: {
  mode: string;
  ad?: { url: string; bindDn: string; baseDn: string; groupDn: string; userFilter: string; bindPassword?: string };
  ldap?: { url: string; bindDn: string; baseDn: string; groupDn: string; userFilter: string; bindPassword?: string };
  sso?: { issuer: string; clientId: string; redirectUri: string; clientSecret?: string; clearSecret?: boolean };
}) {
  return request<AuthPublic>('/api/settings/auth', jsonInit('POST', body));
}

export function fetchDeviceRoutes(ip: string) {
  return request<{ ok: boolean; routes: RouteRow[]; error: string }>(`/api/devices/${encodeURIComponent(ip)}/routing`);
}

export function fetchDeviceVlans(ip: string) {
  return request<{ ok: boolean; vlans: VlanRow[]; error: string }>(`/api/devices/${encodeURIComponent(ip)}/vlans`);
}

export function fetchDeviceNeighbors(ip: string, refresh = false) {
  const query = refresh ? '?refresh=1' : '';
  return request<{ cdp: NeighborRow[]; lldp: NeighborRow[]; cdpOk: boolean; lldpOk: boolean; error: string }>(`/api/devices/${encodeURIComponent(ip)}/neighbors${query}`);
}

export function fetchDeviceInventory(ip: string) {
  return request<{ ok: boolean; rows: InventoryRow[]; error: string }>(`/api/devices/${encodeURIComponent(ip)}/inventory`);
}

export function fetchDeviceLogs(ip: string, query = '') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const suffix = params.toString() ? `?${params}` : '';
  return request<DeviceLogs>(`/api/devices/${encodeURIComponent(ip)}/logs${suffix}`);
}

export function fetchDeviceConfig(ip: string) {
  return request<DeviceConfigBackup>(`/api/devices/${encodeURIComponent(ip)}/config`);
}

export function backupDeviceConfig(ip: string) {
  return request<DeviceConfigBackup>(`/api/devices/${encodeURIComponent(ip)}/config/backup`, jsonInit('POST', {}));
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
