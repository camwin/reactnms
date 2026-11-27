import test from 'node:test';
import assert from 'node:assert/strict';
import { backupCommand, deviceTypeFromDescr, normalizeDeviceType, redact } from './config-backup.js';

test('device types cover the requested vendors and reject free text that is not a type', () => {
  assert.equal(normalizeDeviceType('cisco_ios'), 'cisco_ios');
  assert.equal(normalizeDeviceType('extreme_exos'), 'extreme_exos');
  assert.equal(normalizeDeviceType('axis'), 'axis');
  assert.equal(normalizeDeviceType('juniper_junos'), 'juniper_junos');
  assert.equal(normalizeDeviceType('arista_eos'), 'arista_eos');
  assert.equal(normalizeDeviceType('ipinfusion_ocnos'), 'ipinfusion_ocnos');
  assert.equal(normalizeDeviceType('linux'), 'linux');
  assert.equal(normalizeDeviceType('other'), '');
  assert.equal(normalizeDeviceType('has space'), '');
  assert.equal(backupCommand('juniper_junos'), 'show configuration');
  assert.equal(backupCommand('axis'), 'param list');
  assert.equal(backupCommand('cisco_xe'), 'show running-config');
  assert.equal(redact('login failed for secret-pass and enable-pass', ['secret-pass', 'enable-pass']), 'login failed for *** and ***');
  assert.equal(deviceTypeFromDescr('Cisco IOS Software, C9300'), 'cisco_ios');
  assert.equal(deviceTypeFromDescr('Cisco IOS-XE Software'), 'cisco_xe');
  assert.equal(deviceTypeFromDescr('Cisco NX-OS'), 'cisco_nxos');
  assert.equal(deviceTypeFromDescr('Juniper Networks, Inc. junos'), 'juniper_junos');
  assert.equal(deviceTypeFromDescr('Arista EOS version'), 'arista_eos');
  assert.equal(deviceTypeFromDescr('something else'), '');
});
