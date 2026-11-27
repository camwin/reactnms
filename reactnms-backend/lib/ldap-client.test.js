import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { authenticateDirectory, directoryTlsOptions, ldapBind, parseLdapUrl, searchMessage } from './ldap-client.js';

const USER_DN = 'uid=ada,dc=example,dc=com';
const BIND_DN = 'cn=svc,dc=example,dc=com';
const BASE_DN = 'dc=example,dc=com';
const GROUP_DN = 'cn=nms,dc=example,dc=com';

function tlv(tag, value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function bindResult(code) {
  const app = tlv(0x61, Buffer.concat([
    tlv(0x0a, Buffer.from([code])),
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

function searchDone() {
  const app = tlv(0x65, Buffer.concat([
    tlv(0x0a, Buffer.from([0])),
    tlv(0x04, Buffer.alloc(0)),
    tlv(0x04, Buffer.alloc(0)),
  ]));
  return tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([3])), app]));
}

function searchReferral() {
  const app = tlv(0x73, tlv(0x04, Buffer.from('ldap://other.example/dc=example,dc=com')));
  return tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([9])), app]));
}

function writeSearch(socket, entry) {
  const parts = [searchReferral()];
  if (entry) parts.push(searchEntry(entry));
  parts.push(searchDone());
  const payload = Buffer.concat(parts);
  const cut = Math.min(12, payload.length - 1);
  socket.write(payload.subarray(0, cut));
  setTimeout(() => {
    if (!socket.destroyed) socket.write(payload.subarray(cut));
  }, 15);
}

// Read the application tag after the message id. A raw 0x63 scan matches the
// letter "c" inside a bind DN and answers a bind with a search entry.
function protocolOp(buf) {
  if (buf[0] !== 0x30) return 0;
  let offset = 2;
  if (buf[1] & 0x80) offset = 2 + (buf[1] & 0x7f);
  if (buf[offset] !== 0x02) return 0;
  return buf[offset + 2 + buf[offset + 1]];
}

function searchKind(text) {
  if (text.includes('uniqueMember')) return 'uniqueMember';
  if (text.includes('memberOf')) return 'memberOf';
  if (text.includes('member')) return 'member';
  return 'user';
}

function directoryServer(state) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (buf) => {
      const op = protocolOp(buf);
      const text = buf.toString('utf8');
      if (op === 0x60) {
        const userBind = text.includes(USER_DN);
        if (userBind) state.userBinds += 1;
        socket.write(bindResult((userBind ? state.rejectUser : state.rejectService) ? 49 : 0));
        return;
      }
      if (op !== 0x63) {
        socket.end();
        return;
      }
      const kind = searchKind(text);
      state.searches.push(kind);
      if (kind === 'user') {
        writeSearch(socket, state.userFound ? USER_DN : '');
        return;
      }
      writeSearch(socket, state.allowGroup ? USER_DN : '');
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

test('supported filters encode equality, or, and, and base scope', () => {
  const ad = searchMessage(3, BASE_DN, '(&(|(sAMAccountName=ada)(userPrincipalName=ada@example.com))(memberOf=cn=ReactNMS,ou=Groups,dc=example,dc=com))');
  assert.ok(ad);
  assert.ok(ad.includes(Buffer.from('sAMAccountName')));
  assert.ok(ad.includes(Buffer.from('memberOf')));
  assert.ok(ad.includes(Buffer.from('cn=ReactNMS,ou=Groups,dc=example,dc=com')));
  const subtree = searchMessage(2, BASE_DN, '(uid=ada)');
  assert.ok(subtree.includes(Buffer.from([0x0a, 0x01, 0x02])));
  assert.ok(subtree.includes(Buffer.from('1.1')));
  assert.equal(searchMessage(2, BASE_DN, '(&(uid=ada)'), null);
  assert.equal(directoryTlsOptions({ host: '10.1.1.1', port: 636 }).servername, '');
  assert.equal(directoryTlsOptions({ host: 'dc.example.com', port: 636 }).servername, 'dc.example.com');
});

test('directory login requires a bind account, base DN, and group DN before it connects', async () => {
  const missing = await authenticateDirectory({
    url: 'ldap://127.0.0.1:9',
    username: 'ada',
    password: 'secret',
    mode: 'ldap',
    baseDn: BASE_DN,
    groupDn: '',
    bindDn: BIND_DN,
    bindPassword: 'bind-secret',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'Set the required group DN in Settings');
  const badFilter = await authenticateDirectory({
    url: 'ldap://127.0.0.1:9',
    username: 'ada',
    password: 'secret',
    mode: 'ad',
    baseDn: BASE_DN,
    groupDn: GROUP_DN,
    userFilter: '(uid=',
    bindDn: BIND_DN,
    bindPassword: 'bind-secret',
  });
  assert.equal(badFilter.error, 'The user filter is not a supported LDAP filter');
});

test('a group member can sign in and a non-member cannot', async () => {
  const state = { allowGroup: true, userFound: true, rejectService: false, rejectUser: false, searches: [], userBinds: 0 };
  const server = directoryServer(state);
  await listen(server);
  const { port } = server.address();
  const url = `ldap://127.0.0.1:${port}`;
  try {
    assert.equal(await ldapBind(parseLdapUrl(url), USER_DN, 'secret'), true);
    state.userBinds = 0;
    state.searches = [];
    const member = await authenticateDirectory({
      url,
      username: 'ada',
      password: 'secret',
      mode: 'ldap',
      baseDn: BASE_DN,
      groupDn: GROUP_DN,
      userFilter: '(uid={{username}})',
      bindDn: BIND_DN,
      bindPassword: 'bind-secret',
    });
    assert.equal(member.ok, true);
    assert.equal(member.name, 'ada');
    assert.deepEqual(state.searches, ['user', 'memberOf']);
    assert.equal(state.userBinds, 1);

    state.allowGroup = false;
    state.searches = [];
    state.userBinds = 0;
    const outsider = await authenticateDirectory({
      url,
      username: 'ada',
      password: 'secret',
      mode: 'ad',
      baseDn: BASE_DN,
      groupDn: GROUP_DN,
      bindDn: BIND_DN,
      bindPassword: 'bind-secret',
    });
    assert.equal(outsider.ok, false);
    assert.equal(outsider.error, 'This account is not in the required group');
    assert.deepEqual(state.searches, ['user', 'memberOf', 'member', 'uniqueMember']);
    assert.equal(state.userBinds, 0);

    state.allowGroup = true;
    state.rejectUser = true;
    state.searches = [];
    const rejected = await authenticateDirectory({
      url,
      username: 'ada',
      password: 'wrong',
      mode: 'ldap',
      baseDn: BASE_DN,
      groupDn: GROUP_DN,
      bindDn: BIND_DN,
      bindPassword: 'bind-secret',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'Directory login was rejected');

    state.rejectService = true;
    state.userFound = false;
    const bindRejected = await authenticateDirectory({
      url,
      username: 'ada',
      password: 'secret',
      mode: 'ldap',
      baseDn: BASE_DN,
      groupDn: GROUP_DN,
      bindDn: BIND_DN,
      bindPassword: 'bind-secret',
    });
    assert.equal(bindRejected.ok, false);
    assert.equal(bindRejected.error, 'The directory bind account was rejected');
  } finally {
    server.close();
  }
});

test('a directory reset becomes a login error instead of crashing the API', async () => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (buf) => {
      if (protocolOp(buf) === 0x60) {
        socket.write(bindResult(0));
        return;
      }
      socket.destroy();
    });
  });
  await listen(server);
  const { port } = server.address();
  try {
    const result = await authenticateDirectory({
      url: `ldap://127.0.0.1:${port}`,
      username: 'ada',
      password: 'secret',
      mode: 'ad',
      baseDn: BASE_DN,
      groupDn: GROUP_DN,
      bindDn: BIND_DN,
      bindPassword: 'bind-secret',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /closed the connection|Check the server URL/);
  } finally {
    server.close();
  }
});
