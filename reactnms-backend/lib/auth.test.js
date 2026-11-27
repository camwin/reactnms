import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { codeChallenge, createAuthStore, publicAuth, ssoName, verifyIdToken, verifyPassword, hashPassword } from './auth.js';

test('public auth and local sessions do not reveal secrets', () => {
  const view = publicAuth({
    mode: 'ldap',
    ad: {
      url: 'ldaps://ad.example',
      bindDn: 'cn=svc,dc=example,dc=com',
      bindPasswordEnc: 'ad-cipher',
      baseDn: 'dc=example,dc=com',
      groupDn: 'cn=nms,dc=example,dc=com',
      domain: 'example.com',
    },
    ldap: { url: 'ldaps://ldap.example', bindPasswordEnc: 'cipher-text', groupDn: 'cn=ldap,dc=example,dc=com' },
    sso: { issuer: 'https://idp.example', clientSecretEnc: 'client-cipher' },
  });
  const json = JSON.stringify(view);
  assert.equal(json.includes('cipher-text'), false);
  assert.equal(json.includes('ad-cipher'), false);
  assert.equal(json.includes('client-cipher'), false);
  assert.equal(json.includes('bindPasswordEnc'), false);
  assert.equal(json.includes('example.com'), false);
  assert.equal(view.ad.passwordSet, true);
  assert.equal(view.ad.groupDn, 'cn=nms,dc=example,dc=com');
  assert.equal(view.ldap.passwordSet, true);
  assert.equal(view.ldap.groupDn, 'cn=ldap,dc=example,dc=com');
  assert.equal(view.sso.secretSet, true);
  assert.equal(view.mode, 'ldap');

  const store = createAuthStore(new Database(':memory:'));
  assert.equal(store.addUser('ada', 'short').ok, false);
  assert.equal(store.addUser('ada', 'correct-horse').ok, true);
  assert.equal(store.loginLocal('ada', 'nope'), null);
  const session = store.loginLocal('ada', 'correct-horse');
  assert.equal(store.sessionUser(session.token).username, 'ada');
  assert.equal(store.sessionUser('not-the-token'), null);
  store.endSession(session.token);
  assert.equal(store.sessionUser(session.token), null);
  const stored = hashPassword('correct-horse');
  assert.equal(verifyPassword('correct-horse', stored), true);
  assert.equal(stored.startsWith('scrypt$'), true);
});

test('sso id tokens must match the issuer, audience, and signature', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key';
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://idp.example',
    aud: 'reactnms',
    exp: Math.floor(Date.now() / 1000) + 120,
    preferred_username: 'ada',
  })).toString('base64url');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const token = `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
  const claims = verifyIdToken(token, { keys: [jwk] }, { issuer: 'https://idp.example', audience: 'reactnms' });
  assert.equal(ssoName(claims), 'ada');
  assert.throws(() => verifyIdToken(token, { keys: [jwk] }, { issuer: 'https://other.example', audience: 'reactnms' }));
  const challenge = codeChallenge('verifier');
  assert.equal(challenge, crypto.createHash('sha256').update('verifier').digest('base64url'));
});
