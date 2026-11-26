import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FilterChip, Panel } from '@/components/nms/bits';
import { RuleBuilder } from '@/components/nms/rule-builder';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  acknowledgeAlert,
  createAlertRule,
  deleteAlertOperation,
  deleteAlertRule,
  deleteAlertTransport,
  deleteDeviceGroup,
  fetchActiveAlerts,
  fetchAlertLocations,
  fetchAlertOperations,
  fetchAlertRules,
  fetchAlertTemplates,
  fetchAlertTransports,
  fetchDeviceGroups,
  fetchDiscoveryResults,
  patchAlertRule,
  saveAlertOperation,
  saveAlertTransport,
  saveDeviceGroup,
  testAlertRule,
  type ActiveAlert,
  type AlertOperation,
  type AlertRule,
  type AlertTemplate,
  type AlertTestResult,
  type AlertTransport,
  type DeviceGroup,
  type DiscoveredDevice,
} from '@/lib/api';
import { formatWhen, interfaceLabel } from '@/lib/format';
import { cn } from '@/lib/cn';

type Tab = 'active' | 'rules' | 'operations' | 'tester';

const NONE = '__none__';

function blankRule(): AlertRule {
  return {
    id: '',
    name: '',
    enabled: true,
    severity: 'warning',
    notes: '',
    procedureUrl: '',
    invert: false,
    mute: false,
    notifyRecovery: true,
    notifyAck: false,
    operationId: '',
    advanced: false,
    sql: '',
    scope: { devices: [], groups: [], locations: [], exclude: false },
    builder: { join: 'AND', items: [{ kind: 'cond', entity: 'macros.device_down', op: '=', value: '' }] },
  };
}

function severityClass(severity: string) {
  if (severity === 'critical') return 'text-down';
  if (severity === 'warning') return 'text-warn';
  return 'text-accent';
}

function deviceLabel(device: DiscoveredDevice) {
  return device.sysName && device.sysName !== device.ip ? `${device.sysName} · ${device.ip}` : device.ip;
}

export default function Alerts() {
  const [tab, setTab] = useState<Tab>('active');
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [draft, setDraft] = useState<AlertRule>(blankRule);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [operations, setOperations] = useState<AlertOperation[]>([]);
  const [transports, setTransports] = useState<AlertTransport[]>([]);
  const [templates, setTemplates] = useState<AlertTemplate[]>([]);
  const [active, setActive] = useState<ActiveAlert[]>([]);
  const [status, setStatus] = useState('');
  const [sqlOpen, setSqlOpen] = useState(false);
  const [templateId, setTemplateId] = useState(NONE);
  const [testRuleId, setTestRuleId] = useState(NONE);
  const [testDevice, setTestDevice] = useState(NONE);
  const [testResult, setTestResult] = useState<AlertTestResult | null>(null);
  const [groupName, setGroupName] = useState('');
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [operation, setOperation] = useState<AlertOperation>({ id: '', name: '', delaySec: 0, repeatSec: 300, steps: [{ afterSec: 0, transportIds: [] }] });
  const [transport, setTransport] = useState<AlertTransport>({ id: '', name: '', type: 'webhook', target: '' });

  async function reload() {
    const [nextRules, nextDevices, nextLocations, nextGroups, nextOperations, nextTransports, nextTemplates, nextActive] = await Promise.all([
      fetchAlertRules(),
      fetchDiscoveryResults(),
      fetchAlertLocations(),
      fetchDeviceGroups(),
      fetchAlertOperations(),
      fetchAlertTransports(),
      fetchAlertTemplates(),
      fetchActiveAlerts(),
    ]);
    setRules(nextRules);
    setDevices(nextDevices.results || []);
    setLocations(nextLocations);
    setGroups(nextGroups);
    setOperations(nextOperations);
    setTransports(nextTransports);
    setTemplates(nextTemplates);
    setActive(nextActive);
  }

  useEffect(() => {
    let cancel = false;
    reload().catch(() => {
      if (!cancel) setStatus('Could not load alerts');
    });
    const id = window.setInterval(() => {
      fetchActiveAlerts().then((rows) => { if (!cancel) setActive(rows); }).catch(() => undefined);
    }, 5000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, []);

  const deviceOptions = devices.map((device) => ({ value: device.ip, label: deviceLabel(device) }));

  async function saveRule() {
    setStatus('Saving…');
    try {
      const saved = draft.id ? await patchAlertRule(draft.id, draft) : await createAlertRule(draft);
      setDraft(saved);
      await reload();
      setStatus('Rule saved');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Could not save the rule');
    }
  }

  async function runTest(rule: AlertRule, device: string, toggle = false) {
    setStatus('');
    setTestResult(null);
    try {
      setTestResult(await testAlertRule(rule, device === NONE ? '' : device));
      if (toggle) setSqlOpen(true);
    } catch (err: unknown) {
      if (toggle) setSqlOpen(false);
      setStatus(err instanceof Error ? err.message : 'Test failed');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alerts</h1>
          <p className="mt-1 text-sm text-muted">
            Rules run at the end of each polling cycle. Interface conditions only see interfaces selected for polling. ICMP is checked about once a minute.
            Email is logged in history and delivered only when ALERT_MAIL_URL is set.
          </p>
        </div>
        <Link to="/alerts/history" className="text-sm text-accent">Alert history</Link>
      </div>
      <div className="flex flex-wrap gap-2">
        {([
          ['active', 'Active'],
          ['rules', 'Rules'],
          ['operations', 'Operations'],
          ['tester', 'Tester'],
        ] as [Tab, string][]).map(([id, label]) => (
          <FilterChip key={id} active={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'active' && active.filter((alert) => !alert.ackedAt).length ? ` ${active.filter((alert) => !alert.ackedAt).length}` : ''}
          </FilterChip>
        ))}
      </div>
      {status ? <p className="text-sm text-muted">{status}</p> : null}

      {tab === 'active' ? (
        <div className="flex flex-col gap-3">
          {active.length === 0 ? <p className="rounded-xl border border-line bg-surface px-4 py-6 text-sm text-muted">No active alerts.</p> : null}
          {active.map((alert) => (
            <Panel key={alert.id} title={alertTitle(alert)}>
              <div className="flex flex-col gap-3 px-4 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={cn('font-mono text-xs uppercase tracking-widest', severityClass(alert.severity))}>{alert.severity}</span>
                  {alert.muted ? <span className="font-mono text-xs text-faint">Muted</span> : null}
                  {alert.ackMode ? <span className="font-mono text-xs text-muted">Acked until {alert.ackMode === 'clear' ? 'clear' : 'it worsens'}</span> : null}
                </div>
                <p className="text-sm">{alert.message}</p>
                <p className="font-mono text-xs text-muted">
                  <Link to={`/devices/${encodeURIComponent(alert.deviceIp)}`} className="text-accent">{alert.hostname || alert.deviceIp}</Link>
                  {interfaceLabel(alert.ifName, alert.ifAlias) ? ` · ${interfaceLabel(alert.ifName, alert.ifAlias)}` : ''}
                  {alert.metricValue != null ? ` · ${alert.metricValue}` : ''}
                  {alert.startedAt ? ` · since ${formatWhen(new Date(alert.startedAt).toISOString())}` : ''}
                </p>
                {alert.notes ? <p className="text-sm text-muted">{alert.notes}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button tone="line" onClick={() => acknowledgeAlert(alert.id, 'clear').then(reload).catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'Ack failed'))}>
                    Acknowledge until clear
                  </Button>
                  <Button tone="line" onClick={() => acknowledgeAlert(alert.id, 'worsens').then(reload).catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'Ack failed'))}>
                    Acknowledge until metric worsens
                  </Button>
                  {alert.procedureUrl ? (
                    <Button asChild tone="solid">
                      <a href={alert.procedureUrl} target="_blank" rel="noreferrer">Procedure</a>
                    </Button>
                  ) : null}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      ) : null}

      {tab === 'rules' ? (
        <div className="flex flex-col gap-4">
          <Panel title="Rule collection">
            <div className="flex flex-wrap items-center gap-2 px-4 py-4">
              <Select
                ariaLabel="Rule template"
                value={templateId}
                onValueChange={setTemplateId}
                options={[{ value: NONE, label: 'Choose a template' }, ...templates.map((item) => ({ value: item.id, label: item.name }))]}
              />
              <Button
                tone="line"
                onClick={() => {
                  const template = templates.find((item) => item.id === templateId);
                  if (!template) return;
                  setDraft({
                    ...draft,
                    name: draft.name || template.name,
                    severity: template.severity,
                    notes: template.notes || draft.notes,
                    advanced: false,
                    builder: template.builder,
                  });
                  setStatus(`Imported ${template.name}`);
                }}
              >
                Import template
              </Button>
              <Button tone="ghost" onClick={() => setDraft(blankRule())}>New rule</Button>
            </div>
          </Panel>

          <Panel title={draft.id ? 'Edit rule' : 'New rule'}>
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Rule name" placeholder="Rule name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="max-w-sm" />
                <Select
                  ariaLabel="Severity"
                  value={draft.severity}
                  onValueChange={(severity) => setDraft({ ...draft, severity: severity as AlertRule['severity'] })}
                  options={[{ value: 'ok', label: 'OK' }, { value: 'warning', label: 'Warning' }, { value: 'critical', label: 'Critical' }]}
                />
                <Select
                  ariaLabel="Operation profile"
                  value={draft.operationId || NONE}
                  onValueChange={(operationId) => setDraft({ ...draft, operationId: operationId === NONE ? '' : operationId })}
                  options={[{ value: NONE, label: 'No operation' }, ...operations.map((item) => ({ value: item.id, label: item.name }))]}
                />
              </div>
              <textarea
                aria-label="Runbook notes"
                placeholder="Runbook notes"
                value={draft.notes}
                onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                className="min-h-20 rounded-lg border border-line bg-bg px-3 py-2 text-sm"
              />
              <Input aria-label="Procedure URL" placeholder="Procedure URL (https)" value={draft.procedureUrl} onChange={(event) => setDraft({ ...draft, procedureUrl: event.target.value })} />
              <div className="flex flex-wrap gap-4">
                <Flag label="Enabled" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
                <Flag label="Invert match" checked={draft.invert} onChange={(invert) => setDraft({ ...draft, invert })} />
                <Flag label="Mute alerts" checked={draft.mute} onChange={(mute) => setDraft({ ...draft, mute })} />
                <Flag label="Notify on recovery" checked={draft.notifyRecovery} onChange={(notifyRecovery) => setDraft({ ...draft, notifyRecovery })} />
                <Flag label="Notify on acknowledgement" checked={draft.notifyAck} onChange={(notifyAck) => setDraft({ ...draft, notifyAck })} />
                <Flag label="Advanced SQL override" checked={draft.advanced} onChange={(advanced) => setDraft({ ...draft, advanced })} />
                <Flag label="Exclude selected" checked={draft.scope.exclude} onChange={(exclude) => setDraft({ ...draft, scope: { ...draft.scope, exclude } })} />
              </div>
              {draft.advanced ? (
                <textarea
                  aria-label="Raw SQL"
                  value={draft.sql}
                  onChange={(event) => setDraft({ ...draft, sql: event.target.value })}
                  placeholder="SELECT ip AS device_ip, hostname FROM devices WHERE icmp_up = 0"
                  className="min-h-32 font-mono text-xs rounded-lg border border-line bg-bg px-3 py-2"
                />
              ) : (
                <RuleBuilder group={draft.builder} onChange={(builder) => setDraft({ ...draft, builder })} />
              )}
              <div className="flex flex-wrap gap-3">
                <MultiSelect label="Devices" values={draft.scope.devices} options={deviceOptions} onChange={(devices) => setDraft({ ...draft, scope: { ...draft.scope, devices } })} />
                <MultiSelect label="Device groups" values={draft.scope.groups} options={groups.map((group) => ({ value: group.id, label: group.name }))} onChange={(groups) => setDraft({ ...draft, scope: { ...draft.scope, groups } })} />
                <MultiSelect label="Locations" values={draft.scope.locations} options={locations.map((location) => ({ value: location, label: location }))} onChange={(locations) => setDraft({ ...draft, scope: { ...draft.scope, locations } })} />
              </div>
              <p className="text-sm text-muted">An empty scope matches every device. Otherwise a device matches when it is in any selected device, group, or location. Exclude selected inverts that mapping. A backtick value such as `interfaces.name` compares two columns.</p>
              <div className="flex flex-wrap gap-2">
                <Button tone="solid" onClick={saveRule}>Save rule</Button>
                <Button
                  tone="line"
                  onClick={() => {
                    if (sqlOpen) {
                      setSqlOpen(false);
                      return;
                    }
                    void runTest(draft, NONE, true);
                  }}
                >
                  {sqlOpen ? 'Hide SQL' : 'Check SQL'}
                </Button>
              </div>
              {sqlOpen && testResult && tab === 'rules' ? <SqlResult result={testResult} /> : null}
            </div>
          </Panel>

          <Panel title="Device groups">
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Group name" placeholder="Group name" value={groupName} onChange={(event) => setGroupName(event.target.value)} className="max-w-xs" />
                <Button
                  tone="line"
                  onClick={() => {
                    saveDeviceGroup({ id: '', name: groupName || 'Group', members: groupMembers }).then(() => {
                      setGroupName('');
                      setGroupMembers([]);
                      return reload();
                    }).catch((err: unknown) => setStatus(err instanceof Error ? err.message : 'Could not save the group'));
                  }}
                >
                  Add group
                </Button>
              </div>
              <MultiSelect label="Members" values={groupMembers} options={deviceOptions} onChange={setGroupMembers} />
              <ul>
                {groups.map((group) => (
                  <li key={group.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-b-0">
                    <span>{group.name} <span className="text-muted">({group.members.length})</span></span>
                    <button type="button" className="min-h-11 text-down" onClick={() => deleteDeviceGroup(group.id).then(reload)}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>

          <Panel title="Saved rules">
            {rules.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No rules yet.</p> : (
              <ul>
                {rules.map((rule) => (
                  <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0">
                    <div>
                      <div className="font-medium">{rule.name}</div>
                      <div className={cn('font-mono text-xs uppercase', severityClass(rule.severity))}>{rule.severity}{rule.enabled ? '' : ' · disabled'}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button tone="line" onClick={() => patchAlertRule(rule.id, { enabled: !rule.enabled }).then(reload)}>
                        {rule.enabled ? 'Disable' : 'Enable'}
                      </Button>
                      <Button tone="line" onClick={() => { setDraft(rule); setTab('rules'); }}>Edit</Button>
                      <Button tone="ghost" onClick={() => deleteAlertRule(rule.id).then(() => { if (draft.id === rule.id) setDraft(blankRule()); return reload(); })}>Delete</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      ) : null}

      {tab === 'operations' ? (
        <div className="flex flex-col gap-4">
          <Panel title="Alert transports">
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Transport name" placeholder="Name" value={transport.name} onChange={(event) => setTransport({ ...transport, name: event.target.value })} className="max-w-40" />
                <Select
                  ariaLabel="Transport type"
                  value={transport.type}
                  onValueChange={(type) => setTransport({ ...transport, type: type as AlertTransport['type'] })}
                  options={[{ value: 'webhook', label: 'Webhook' }, { value: 'slack', label: 'Slack' }, { value: 'email', label: 'Email' }]}
                />
                <Input
                  aria-label="Transport target"
                  placeholder={transport.type === 'email' ? 'address@example.com' : 'https://hook.example/'}
                  value={transport.target}
                  onChange={(event) => setTransport({ ...transport, target: event.target.value })}
                  className="max-w-sm"
                />
                <Button tone="line" onClick={() => saveAlertTransport(transport).then(() => { setTransport({ id: '', name: '', type: 'webhook', target: '' }); return reload(); })}>
                  Add transport
                </Button>
              </div>
              <ul>
                {transports.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-b-0">
                    <span>{item.name} · {item.type} · <span className="font-mono text-xs">{item.target}</span></span>
                    <button type="button" className="min-h-11 text-down" onClick={() => deleteAlertTransport(item.id).then(reload)}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
          <Panel title="Operation profile">
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap gap-2">
                <Input aria-label="Operation name" placeholder="Name" value={operation.name} onChange={(event) => setOperation({ ...operation, name: event.target.value })} className="max-w-xs" />
                <Input aria-label="Notification delay seconds" type="number" value={operation.delaySec} onChange={(event) => setOperation({ ...operation, delaySec: Number(event.target.value) })} className="w-28" />
                <Input aria-label="Repeat interval seconds" type="number" value={operation.repeatSec} onChange={(event) => setOperation({ ...operation, repeatSec: Number(event.target.value) })} className="w-28" />
              </div>
              <p className="text-sm text-muted">Delay and repeat are seconds. Each step lists the transports used once that many seconds have passed. Later steps replace earlier ones.</p>
              {operation.steps.map((step, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <Input aria-label="Step after seconds" type="number" value={step.afterSec} onChange={(event) => {
                    const steps = operation.steps.map((item, itemIndex) => itemIndex === index ? { ...item, afterSec: Number(event.target.value) } : item);
                    setOperation({ ...operation, steps });
                  }} className="w-28" />
                  <MultiSelect
                    label="Transports"
                    values={step.transportIds}
                    options={transports.map((item) => ({ value: item.id, label: `${item.name} (${item.type})` }))}
                    onChange={(transportIds) => {
                      const steps = operation.steps.map((item, itemIndex) => itemIndex === index ? { ...item, transportIds } : item);
                      setOperation({ ...operation, steps });
                    }}
                  />
                  <Button tone="ghost" onClick={() => setOperation({ ...operation, steps: operation.steps.filter((_, itemIndex) => itemIndex !== index) })}>Remove step</Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button tone="line" onClick={() => setOperation({ ...operation, steps: [...operation.steps, { afterSec: 600, transportIds: [] }] })}>Add escalation step</Button>
                <Button tone="solid" onClick={() => saveAlertOperation(operation).then(() => { setOperation({ id: '', name: '', delaySec: 0, repeatSec: 300, steps: [{ afterSec: 0, transportIds: [] }] }); return reload(); })}>Save operation</Button>
              </div>
              <ul>
                {operations.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 border-b border-line py-2 text-sm last:border-b-0">
                    <button type="button" className="min-h-11 text-left" onClick={() => setOperation(item)}>{item.name} · delay {item.delaySec}s · repeat {item.repeatSec}s · {item.steps.length} steps</button>
                    <button type="button" className="min-h-11 text-down" onClick={() => deleteAlertOperation(item.id).then(reload)}>Remove</button>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
        </div>
      ) : null}

      {tab === 'tester' ? (
        <Panel title="Debug tester">
          <div className="flex flex-col gap-3 px-4 py-4">
            <p className="text-sm text-muted">Runs the saved rule’s compiled SQL against one device and shows the query plus the rows that matched.</p>
            <div className="flex flex-wrap gap-2">
              <Select
                ariaLabel="Rule to test"
                value={testRuleId}
                onValueChange={setTestRuleId}
                options={[{ value: NONE, label: 'Choose a rule' }, ...rules.map((rule) => ({ value: rule.id, label: rule.name }))]}
              />
              <Select
                ariaLabel="Device to test"
                value={testDevice}
                onValueChange={setTestDevice}
                options={[{ value: NONE, label: 'Choose a device' }, ...deviceOptions]}
              />
              <Button
                tone="solid"
                onClick={() => {
                  const rule = rules.find((item) => item.id === testRuleId);
                  if (!rule) { setStatus('Choose a rule'); return; }
                  runTest(rule, testDevice);
                }}
              >
                Run test
              </Button>
            </div>
            {testResult ? <SqlResult result={testResult} /> : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function alertTitle(alert: ActiveAlert) {
  const iface = interfaceLabel(alert.ifName, alert.ifAlias);
  if (alert.ruleName && iface) return `${alert.ruleName}: ${iface}`;
  return alert.ruleName || iface || 'Alert';
}

function Flag({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex min-h-11 items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}

function MultiSelect({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: { value: string; label: string }[];
  onChange: (values: string[]) => void;
}) {
  return (
    <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
      <span className="font-mono text-xs uppercase tracking-widest text-faint">{label}</span>
      <select
        multiple
        aria-label={label}
        value={values}
        onChange={(event) => onChange([...event.target.selectedOptions].map((option) => option.value))}
        className="min-h-32 rounded-lg border border-line bg-bg px-2 py-1 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function SqlResult({ result }: { result: AlertTestResult }) {
  return (
    <div className="rounded-lg border border-line bg-bg px-3 py-3">
      <p className={cn('text-sm', result.match ? 'text-down' : 'text-accent')}>{result.match ? `Match (${result.count})` : 'No match'}</p>
      {result.error ? <p className="mt-2 text-sm text-down">{result.error}</p> : null}
      <pre className="mt-2 overflow-auto font-mono text-xs text-muted">{result.sql}</pre>
      <pre className="mt-2 overflow-auto font-mono text-xs text-faint">{JSON.stringify({ params: result.params, rows: result.rows }, null, 2)}</pre>
    </div>
  );
}
