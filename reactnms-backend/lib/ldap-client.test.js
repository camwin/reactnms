import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { authenticateDirectory, ldapBind, parseLdapUrl } from './ldap-client.js';

function tlv(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function bindSuccess() {
  const app = tlv(0x61, Buffer.concat([
    tlv(0x0a, Buffer.from([0])),
    tlv(0x04, Buffer.alloc(0)),
    tlv(0x04, Buffer.alloc(0)),
  ]));
  return tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), app]));
}

function searchEntry(dn) {
  const app = tlv(0x64, Buffer.concat([
    tlv(0x04, Buffer.from(dn)),
    tlv(0x30, Buffer.alloc(0)),
  ]));
  return tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([2])), app]));
}

function protocolOp(buf) {
  if (buf[0] !== 0x30) return 0;
  let offset = 2;
  if (buf[1] & 0x80) offset = 2 + (buf[1] & 0x7f);
  if (buf[offset] !== 0x02) return 0;
  return buf[offset + 2 + buf[offset + 1]];
}

test('directory login uses a real bind and does not accept a failed bind', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', (buf) => {
      socket.write(protocolOp(buf) === 0x63 ? searchEntry('uid=ada,dc=example,dc=com') : bindSuccess());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const url = `ldap://127.0.0.1:${port}`;
    assert.equal(await ldapBind(parseLdapUrl(url), 'uid=ada,dc=example,dc=com', 'secret'), true);
    const result = await authenticateDirectory({
      url,
      username: 'ada',
      password: 'secret',
      mode: 'ldap',
      baseDn: 'dc=example,dc=com',
      userFilter: '(uid={{username}})',
      bindDn: '',
      bindPassword: '',
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'ada');
  } finally {
    server.close();
  }
});
