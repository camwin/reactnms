import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decryptSecret, encryptSecret, loadKey, publicServiceAccount } from './secret-box.js';

test('service account secrets round-trip and stay out of the public view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactnms-key-'));
  const file = path.join(dir, 'service.key');
  const key = loadKey(file);
  assert.equal(key.length, 32);
  assert.equal(loadKey(file).equals(key), true);
  const packed = encryptSecret(key, 'service-secret');
  assert.equal(packed.includes('service-secret'), false);
  assert.equal(decryptSecret(key, packed), 'service-secret');
  assert.equal(decryptSecret(key, ''), '');
  const view = publicServiceAccount({
    enabled: true,
    username: 'backup',
    deviceType: 'cisco_ios',
    passwordEnc: packed,
    enableEnc: encryptSecret(key, 'enable-secret'),
  });
  assert.equal(view.passwordSet, true);
  assert.equal(view.enableSet, true);
  assert.equal(JSON.stringify(view).includes('service-secret'), false);
  assert.equal(JSON.stringify(view).includes(packed), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
