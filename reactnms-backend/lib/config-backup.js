import { spawn } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'node:url';

export const DEVICE_TYPES = [
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

const KNOWN = new Set(DEVICE_TYPES.map((item) => item.id));

export function normalizeDeviceType(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'other') return '';
  if (KNOWN.has(raw)) return raw;
  return /^[a-zA-Z0-9_-]{1,64}$/.test(raw) ? raw : '';
}

export function backupCommand(deviceType) {
  if (deviceType === 'juniper_junos' || deviceType === 'extreme_exos' || deviceType === 'extreme_vsp') return 'show configuration';
  if (deviceType === 'axis') return 'param list';
  return 'show running-config';
}

export function redact(text, secrets) {
  let out = String(text || '');
  for (const secret of secrets || []) {
    const value = String(secret || '');
    if (value.length >= 3) out = out.split(value).join('***');
  }
  return out;
}

export function runBackup({ host, username, password, enable, deviceType, timeoutMs = 90000 }) {
  const type = normalizeDeviceType(deviceType);
  if (!type) return Promise.resolve({ ok: false, error: 'Unknown device type', config: '' });
  if (!username || !password) return Promise.resolve({ ok: false, error: 'Service account username and password are required', config: '' });
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup_config.py');
  const payload = JSON.stringify({
    host,
    username,
    password,
    secret: enable || '',
    device_type: type,
    command: backupCommand(type),
  });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err?.code === 'ENOENT' ? 'Python is not installed' : 'Could not start the backup', config: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, error: 'Backup timed out', config: '' });
    }, timeoutMs);
    child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });
    child.on('error', (err) => {
      finish({ ok: false, error: err?.code === 'ENOENT' ? 'Python is not installed' : redact(err.message, [password, enable]), config: '' });
    });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch { parsed = null; }
      if (parsed?.ok) {
        finish({ ok: true, config: String(parsed.config || '').slice(0, 2_000_000), error: '' });
        return;
      }
      const message = parsed?.error || redact(stderr, [password, enable]) || `backup exited ${code}`;
      const friendly = /No module named ['"](?:netmiko|paramiko)['"]/i.test(message) ? 'Netmiko is not installed' : String(message).slice(0, 500);
      finish({ ok: false, config: '', error: friendly });
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}
