import crypto from 'node:crypto';
import fs from 'fs';

const IV_LEN = 12;
const TAG_LEN = 16;

export const DEFAULT_SERVICE_ACCOUNT = {
  enabled: false,
  username: '',
  deviceType: 'cisco_ios',
  passwordEnc: '',
  enableEnc: '',
};

// Netmiko has to log in later, so the password is encrypted at rest rather than hashed.
export function loadKey(file) {
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file);
      if (existing.length === 32) return existing;
    }
  } catch {
    /* write a new key below */
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* mode is best-effort */ }
  return key;
}

export function encryptSecret(key, plain) {
  const text = String(plain ?? '');
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64');
}

export function decryptSecret(key, packed) {
  const raw = String(packed || '');
  if (!raw) return '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) throw new Error('stored secret is unreadable');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function normalizeServiceAccount(raw, deviceType) {
  const src = { ...DEFAULT_SERVICE_ACCOUNT, ...(raw || {}) };
  return {
    enabled: !!src.enabled,
    username: String(src.username || '').trim(),
    deviceType: deviceType || src.deviceType || 'cisco_ios',
    passwordEnc: String(src.passwordEnc || ''),
    enableEnc: String(src.enableEnc || ''),
  };
}

export function publicServiceAccount(account) {
  const src = account || DEFAULT_SERVICE_ACCOUNT;
  return {
    enabled: !!src.enabled,
    username: src.username || '',
    deviceType: src.deviceType || 'cisco_ios',
    passwordSet: !!src.passwordEnc,
    enableSet: !!src.enableEnc,
  };
}
