import crypto from 'node:crypto';

export const DEFAULT_AUTH = {
  mode: 'off',
  ad: { url: '', domain: '' },
  ldap: { url: '', baseDn: '', userFilter: '(uid={{username}})', bindDn: '', bindPasswordEnc: '' },
  sso: { issuer: '', clientId: '', clientSecretEnc: '', redirectUri: '' },
};

const MODES = new Set(['off', 'local', 'ad', 'ldap', 'sso']);

export function normalizeAuth(raw) {
  const src = raw || {};
  return {
    mode: MODES.has(src.mode) ? src.mode : 'off',
    ad: {
      url: String(src.ad?.url || '').trim(),
      domain: String(src.ad?.domain || '').trim(),
    },
    ldap: {
      url: String(src.ldap?.url || '').trim(),
      baseDn: String(src.ldap?.baseDn || '').trim(),
      userFilter: String(src.ldap?.userFilter || '(uid={{username}})').trim() || '(uid={{username}})',
      bindDn: String(src.ldap?.bindDn || '').trim(),
      bindPasswordEnc: String(src.ldap?.bindPasswordEnc || ''),
    },
    sso: {
      issuer: String(src.sso?.issuer || '').trim().replace(/\/$/, ''),
      clientId: String(src.sso?.clientId || '').trim(),
      clientSecretEnc: String(src.sso?.clientSecretEnc || ''),
      redirectUri: String(src.sso?.redirectUri || '').trim(),
    },
  };
}

export function publicAuth(auth) {
  const cfg = normalizeAuth(auth);
  return {
    mode: cfg.mode,
    ad: { ...cfg.ad },
    ldap: {
      url: cfg.ldap.url,
      baseDn: cfg.ldap.baseDn,
      userFilter: cfg.ldap.userFilter,
      bindDn: cfg.ldap.bindDn,
      passwordSet: !!cfg.ldap.bindPasswordEnc,
    },
    sso: {
      issuer: cfg.sso.issuer,
      clientId: cfg.sso.clientId,
      redirectUri: cfg.sso.redirectUri,
      secretSet: !!cfg.sso.clientSecretEnc,
    },
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const actual = crypto.scryptSync(String(password), parts[1], 32);
  const expected = Buffer.from(parts[2], 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createAuthStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_user (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_session (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_state (
      state TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      next_url TEXT NOT NULL DEFAULT '/'
    );
  `);

  function listUsers() {
    return db.prepare('SELECT username, created_at AS createdAt FROM auth_user ORDER BY username').all();
  }

  function addUser(username, password) {
    const name = String(username || '').trim();
    if (!/^[a-zA-Z0-9._@-]{1,64}$/.test(name)) return { ok: false, error: 'Username must be letters, numbers, ., _, @, or -' };
    if (String(password || '').length < 8) return { ok: false, error: 'Password must be at least 8 characters' };
    db.prepare('INSERT INTO auth_user (username, password_hash, created_at) VALUES (?, ?, ?)').run(name, hashPassword(password), Date.now());
    return { ok: true, username: name };
  }

  function deleteUser(username) {
    db.prepare('DELETE FROM auth_user WHERE username = ?').run(String(username || ''));
    db.prepare('DELETE FROM auth_session WHERE username = ?').run(String(username || ''));
  }

  function loginLocal(username, password) {
    const row = db.prepare('SELECT username, password_hash FROM auth_user WHERE username = ?').get(String(username || '').trim());
    if (!row || !verifyPassword(password, row.password_hash)) return null;
    return openSession(row.username);
  }

  function openSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO auth_session (token_hash, username, expires_at) VALUES (?, ?, ?)').run(tokenHash(token), username, Date.now() + 12 * 3600 * 1000);
    return { token, username };
  }

  function sessionUser(token) {
    if (!token) return null;
    const row = db.prepare('SELECT username, expires_at FROM auth_session WHERE token_hash = ?').get(tokenHash(token));
    if (!row || row.expires_at < Date.now()) return null;
    return { username: row.username };
  }

  function endSession(token) {
    if (!token) return;
    db.prepare('DELETE FROM auth_session WHERE token_hash = ?').run(tokenHash(token));
  }

  function saveState(verifier, nextUrl = '/') {
    const state = crypto.randomBytes(24).toString('hex');
    const next = String(nextUrl || '/').slice(0, 500) || '/';
    db.prepare('DELETE FROM auth_state WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO auth_state (state, verifier, expires_at, next_url) VALUES (?, ?, ?, ?)').run(state, verifier, Date.now() + 10 * 60 * 1000, next);
    return state;
  }

  function takeState(state) {
    const row = db.prepare('SELECT verifier, expires_at, next_url FROM auth_state WHERE state = ?').get(String(state || ''));
    db.prepare('DELETE FROM auth_state WHERE state = ?').run(String(state || ''));
    if (!row || row.expires_at < Date.now()) return null;
    return { verifier: row.verifier, next: row.next_url || '/' };
  }

  return { listUsers, addUser, deleteUser, loginLocal, openSession, sessionUser, endSession, saveState, takeState };
}

export function codeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function verifyIdToken(token, jwks, { issuer, audience }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('SSO token was not a signed JWT');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const jwk = (jwks?.keys || []).find((key) => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw new Error('SSO signing key was not found');
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(`${parts[0]}.${parts[1]}`);
  const ok = verify.verify(crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('SSO token signature was rejected');
  if (payload.iss !== issuer) throw new Error('SSO issuer did not match');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw new Error('SSO audience did not match');
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('SSO token expired');
  return payload;
}

export function ssoName(payload) {
  return String(payload?.preferred_username || payload?.email || payload?.name || payload?.sub || '').trim();
}
