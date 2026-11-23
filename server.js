'use strict';
/*
 * BixTech auth server — zero npm dependencies (Node 18+).
 * Serves the website from ./public and handles OAuth 2.0 / OpenID Connect for
 * Google, Apple, GitHub, Facebook and Microsoft (authorization-code flow).
 *
 *   GET  /auth/:provider            start login (redirects to the provider)
 *   GET  /auth/:provider/callback   provider redirects back here (Apple uses POST)
 *   GET  /api/providers             which providers are configured
 *   GET  /api/me                    PROTECTED: the signed-in user, 401 otherwise
 *   POST /auth/register             create a password account (name, email, password, course, field, duration)
 *   POST /auth/login                sign in with email + password
 *   POST /auth/logout               destroy the session
 *
 * Internship application documents (student upload + admin review):
 *   GET  /api/applications/mine               student: my application (or null)
 *   GET  /api/applications/mine/file          student: my uploaded document
 *   POST /api/applications                    student: upload / replace (raw file body)
 *   GET  /api/admin/session                   admin: am I signed in on the server?
 *   POST /api/admin/login | /api/admin/logout admin: server-side sign in / out
 *   GET  /api/admin/applications              admin: list (?status=&q=)
 *   GET  /api/admin/applications/:id          admin: one application
 *   GET  /api/admin/applications/:id/file     admin: view (or ?download=1) the original
 *   POST /api/admin/applications/:id/review   admin: approve / reject (+ comment)
 *
 * Attendance (admin only):
 *   GET  /api/admin/attendance?date=YYYY-MM-DD     every registered student + that day's mark
 *   POST /api/admin/attendance                     { date, marks:[{userId,status:'present'|'absent'|''}] }
 *   GET  /api/admin/attendance/report[.csv]        totals per student (?from=&to=, ?type=daily for one row per day)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------- config ---------- */
function loadEnvFile(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      let val = m[2];
      if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
      else val = val.replace(/\s+#.*$/, '').replace(/^#.*$/, ''); // drop trailing comments
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (e) { /* no .env file: use real environment variables */ }
}
loadEnvFile(path.join(__dirname, '.env'));

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const BASE_URL = (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const SECURE = BASE_URL.startsWith('https://');
const RATE_LIMIT = Number(env.RATE_LIMIT) || 30;
const SESSION_TTL = (Number(env.SESSION_DAYS) || 7) * 86400; // seconds
const DATA_FILE = path.join(env.DATA_DIR || path.join(__dirname, 'data'), 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_SECRET = env.SESSION_SECRET || '';
if (SESSION_SECRET.length < 32) {
  const msg = '[auth] SESSION_SECRET is missing or shorter than 32 characters. Run "node setup.js" or set a long random value (see README).';
  if (SECURE) { console.error(msg); process.exit(1); } // never run a public site with a weak secret
  console.warn(msg);
}
const SID_COOKIE = (SECURE ? '__Host-' : '') + 'bix_sid';
const OAUTH_COOKIE = (SECURE ? '__Host-' : '') + 'bix_oauth';

/* ---------- tiny helpers ---------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const hmac = (s) => crypto.createHmac('sha256', SESSION_SECRET || 'dev-only-secret').update(s).digest('base64url');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const nowS = () => Math.floor(Date.now() / 1000);
class AuthError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

/* ---------- storage (JSON file; swap for a real DB when you grow) ---------- */
let store = { users: [], identities: [], passkeys: [] };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* first run */ }
store.passkeys = store.passkeys || [];
store.attendance = store.attendance || {}; // attendance: { 'YYYY-MM-DD': { userId: 'p' (present) | 'a' (absent) } }
store.applications = store.applications || []; // internship application records (the files themselves live elsewhere, see fileSave)
const UP_URL = env.UPSTASH_REDIS_REST_URL, UP_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
async function upstash(cmd, ms = 8000) { // ms: file uploads get a longer timeout than small JSON saves
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd), signal: AbortSignal.timeout(ms) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('upstash ' + r.status + ' ' + (j.error || ''));
  return j.result;
}
async function loadRemote() { // with Upstash configured, accounts and passkeys live there instead of the (temporary) disk
  if (!UP_URL || !UP_TOKEN) return;
  const v = await upstash(['GET', 'bixtech:store']);
  if (v) store = Object.assign({ users: [], identities: [], passkeys: [], applications: [], attendance: {} }, JSON.parse(v));
}
let pushTimer = null, pushing = false;
function pushRemote() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    if (pushing) return pushRemote();
    pushing = true;
    try { await upstash(['SET', 'bixtech:store', JSON.stringify(store)]); } catch (e) { console.error('[store] upstash save failed:', e.message); }
    pushing = false;
  }, 300);
}
function persist() {
  if (UP_URL && UP_TOKEN) return pushRemote();
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  try { fs.renameSync(tmp, DATA_FILE); } // atomic replace on a normal disk
  catch (e) { fs.writeFileSync(DATA_FILE, JSON.stringify(store), { mode: 0o600 }); } // some mounted drives can't rename
}

/* ---------- users: first sign-in creates the account, later ones reuse it ---------- */
function findOrCreateUser(p) {
  const ident = store.identities.find((i) => i.provider === p.provider && i.subject === p.subject);
  if (ident) {
    const user = store.users.find((u) => u.id === ident.userId);
    if (user) { user.lastLoginAt = nowS(); persist(); return { user, created: false }; }
  }
  const email = (p.email || '').trim().toLowerCase();
  if (!email) throw new AuthError('no_email', 'provider returned no email');

  let user = store.users.find((u) => u.email === email);
  if (user) {
    // Only attach a new provider to an existing account if the provider PROVES the email is theirs.
    if (!p.emailVerified) throw new AuthError('email_exists', 'unverified email matches an existing account');
    if (!user.emailVerified) {
      // The account was made with an unproven email: drop whoever else is attached to it.
      store.identities = store.identities.filter((i) => i.userId !== user.id);
      user.emailVerified = true;
      delete user.pw; // a password chosen when the e-mail was still unproven must not survive: it may belong to someone who only typed this address
    }
  } else {
    user = { id: 'u_' + rand(12), email, name: (p.name || email.split('@')[0]).slice(0, 120),
             emailVerified: !!p.emailVerified, createdAt: nowS(), lastLoginAt: nowS() };
    store.users.push(user);
    var created = true;
  }
  store.identities.push({ provider: p.provider, subject: p.subject, userId: user.id });
  user.lastLoginAt = nowS();
  persist();
  return { user, created: !!created };
}

/* ---------- sessions: signed, HttpOnly cookie (stateless, so they survive restarts and sleeping hosts) ---------- */
const revoked = new Map(); // logged-out session ids (best effort, in memory) -> expiry
function createSession(user, provider) {
  const blob = b64u(JSON.stringify({ j: rand(12), u: user.id, n: user.name, e: user.email, p: provider, x: nowS() + SESSION_TTL }));
  return blob + '.' + hmac(blob); // tamper-evident: changing anything breaks the signature
}
function sessionFrom(req) {
  const raw = parseCookies(req)[SID_COOKIE];
  if (!raw) return null;
  const [blob, sig] = raw.split('.');
  if (!blob || !sig || !safeEq(sig, hmac(blob))) return null;
  let c; try { c = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!c || c.x < nowS() || revoked.has(c.j)) return null;
  return { key: c.j, exp: c.x, user: { id: c.u, name: c.n, email: c.e }, provider: c.p };
}
setInterval(() => {
  for (const [k, exp] of consumed) if (exp < nowS()) consumed.delete(k);
  for (const [k, exp] of revoked) if (exp < nowS()) revoked.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------- http helpers ---------- */
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, { maxAge, sameSite = 'Lax' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}`;
  if (SECURE || sameSite === 'None') c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}
function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object';
  res.writeHead(status, Object.assign({
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers));
  res.end(isObj ? JSON.stringify(body) : body || '');
}
function redirect(res, url, cookies = []) {
  res.writeHead(302, Object.assign({ Location: url, 'Cache-Control': 'no-store' }, cookies.length ? { 'Set-Cookie': cookies } : {}));
  res.end();
}
function readBody(req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const securityHeaders = () => Object.assign({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
}, SECURE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {});

/* simple per-IP rate limit for /auth/* (RATE_LIMIT requests / minute, default 30) */
const hits = new Map();
function limited(req) {
  const ip = (SECURE && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : req.socket.remoteAddress) || '?';
  const t = Date.now(), h = (hits.get(ip) || []).filter((x) => t - x < 60000);
  h.push(t); hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.length > RATE_LIMIT;
}

/* ---------- providers ---------- */
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(10000) }, opts));
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${text.slice(0, 200)}`);
  return data;
}
const bearer = (t) => ({ Authorization: 'Bearer ' + t, Accept: 'application/json' });

function appleClientSecret() {
  const key = (env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n') ||
    (env.APPLE_PRIVATE_KEY_PATH ? fs.readFileSync(env.APPLE_PRIVATE_KEY_PATH, 'utf8') : '');
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID }));
  const t = nowS();
  const payload = b64u(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: t, exp: t + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(sig)}`;
}
let appleKeys = { at: 0, keys: [] };
async function verifyAppleIdToken(idToken, nonce) {
  const [h, p, s] = String(idToken).split('.');
  if (!h || !p || !s) throw new Error('bad id_token');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  if (header.alg !== 'RS256') throw new Error('bad alg');
  if (Date.now() - appleKeys.at > 3600000 || !appleKeys.keys.some((k) => k.kid === header.kid)) {
    appleKeys = { at: Date.now(), keys: (await fetchJSON('https://appleid.apple.com/auth/keys')).keys };
  }
  const jwk = appleKeys.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const c = JSON.parse(Buffer.from(p, 'base64url'));
  if (c.iss !== 'https://appleid.apple.com' || c.aud !== env.APPLE_CLIENT_ID || c.exp < nowS() || !safeEq(c.nonce || '', nonce)) throw new Error('bad claims');
  return c;
}

const providers = {
  google: {
    label: 'Google', pkce: true, scope: 'openid email profile',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    id: () => env.GOOGLE_CLIENT_ID, secret: () => env.GOOGLE_CLIENT_SECRET,
    async profile(tok) {
      const u = await fetchJSON('https://openidconnect.googleapis.com/v1/userinfo', { headers: bearer(tok.access_token) });
      return { subject: u.sub, email: u.email, emailVerified: u.email_verified === true, name: u.name };
    },
  },
  github: {
    label: 'GitHub', pkce: true, scope: 'read:user user:email',
    authUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
    id: () => env.GITHUB_CLIENT_ID, secret: () => env.GITHUB_CLIENT_SECRET,
    async profile(tok) {
      const h = Object.assign(bearer(tok.access_token), { 'User-Agent': 'bixtech-auth', 'X-GitHub-Api-Version': '2022-11-28' });
      const u = await fetchJSON('https://api.github.com/user', { headers: h });
      const emails = await fetchJSON('https://api.github.com/user/emails', { headers: h });
      const best = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
      return { subject: String(u.id), email: best && best.email, emailVerified: !!best, name: u.name || u.login };
    },
  },
  facebook: {
    label: 'Facebook', pkce: false, scope: 'email public_profile',
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth', tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    id: () => env.FACEBOOK_APP_ID, secret: () => env.FACEBOOK_APP_SECRET,
    async profile(tok) {
      const u = await fetchJSON('https://graph.facebook.com/v19.0/me?fields=id,name,email', { headers: bearer(tok.access_token) });
      // Facebook does not say whether the email is verified, so we never auto-link it to an existing account.
      return { subject: u.id, email: u.email, emailVerified: false, name: u.name };
    },
  },
  microsoft: {
    label: 'Microsoft', pkce: true, scope: 'openid email profile',
    get authUrl() { return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`; },
    get tokenUrl() { return `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`; },
    id: () => env.MICROSOFT_CLIENT_ID, secret: () => env.MICROSOFT_CLIENT_SECRET,
    async profile(tok) {
      const u = await fetchJSON('https://graph.microsoft.com/oidc/userinfo', { headers: bearer(tok.access_token) });
      // Microsoft's email claim is not guaranteed verified (the "nOAuth" issue), so never auto-link it.
      return { subject: u.sub, email: u.email, emailVerified: false, name: u.name };
    },
  },
  apple: {
    label: 'Apple', pkce: false, scope: 'name email', formPost: true,
    authUrl: 'https://appleid.apple.com/auth/authorize', tokenUrl: 'https://appleid.apple.com/auth/token',
    id: () => env.APPLE_CLIENT_ID,
    secret: () => (env.APPLE_TEAM_ID && env.APPLE_KEY_ID && (env.APPLE_PRIVATE_KEY || env.APPLE_PRIVATE_KEY_PATH) ? appleClientSecret() : ''),
    async profile(tok, ctx) {
      const c = await verifyAppleIdToken(tok.id_token, ctx.nonce);
      let name = ctx.appleUser && ctx.appleUser.name ? [ctx.appleUser.name.firstName, ctx.appleUser.name.lastName].filter(Boolean).join(' ') : '';
      return { subject: c.sub, email: c.email, emailVerified: c.email_verified === true || c.email_verified === 'true', name };
    },
  },
};
const configured = (p) => !!(providers[p].id() && providers[p].secret());
const REQUIRED = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  facebook: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'], microsoft: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  apple: ['APPLE_CLIENT_ID', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_PRIVATE_KEY (or APPLE_PRIVATE_KEY_PATH)'],
};
const missing = (p) => REQUIRED[p].filter((v) => !(env[v.split(' ')[0]] || (v.startsWith('APPLE_PRIVATE_KEY') && env.APPLE_PRIVATE_KEY_PATH)));

/* ---------- OAuth flow ---------- */
const consumed = new Map(); // best-effort single-use memory of finished states (state -> exp)
const redirectUri = (p) => `${BASE_URL}/auth/${p}/callback`;
const fail = (res, code, extra = []) => redirect(res, `/?auth_error=${encodeURIComponent(code)}`, extra);
const clearOauth = () => cookie(OAUTH_COOKIE, '', { maxAge: 0 });

function readOauthCookie(req) {
  const raw = parseCookies(req)[OAUTH_COOKIE];
  if (!raw) return null;
  const [blob, sig] = raw.split('.');
  if (!blob || !sig || !safeEq(sig, hmac(blob))) return null;
  try { return JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')); } catch (e) { return null; }
}

function startLogin(res, name) {
  const p = providers[name];
  if (!configured(name)) return fail(res, 'not_configured');
  const state = rand(24), verifier = rand(48), nonce = rand(16);
  // Everything we must remember about this login attempt lives in a signed HttpOnly cookie,
  // so it survives server restarts and works with several / scaled-to-zero instances.
  const blob = b64u(JSON.stringify({ s: state, p: name, v: verifier, n: nonce, e: nowS() + 600 }));
  const q = new URLSearchParams({ response_type: 'code', client_id: p.id(), redirect_uri: redirectUri(name), scope: p.scope, state });
  if (p.pkce) { q.set('code_challenge', b64u(sha256(verifier))); q.set('code_challenge_method', 'S256'); }
  if (name === 'apple') { q.set('response_mode', 'form_post'); q.set('nonce', nonce); }
  if (name === 'google') q.set('prompt', 'select_account');
  if (name === 'microsoft') q.set('prompt', 'select_account');
  // Apple posts back cross-site, so its binding cookie must be SameSite=None (needs HTTPS).
  const c = cookie(OAUTH_COOKIE, blob + '.' + hmac(blob), { maxAge: 600, sameSite: p.formPost ? 'None' : 'Lax' });
  redirect(res, `${p.authUrl}?${q}`, [c]);
}

async function finishLogin(req, res, name, params) {
  const p = providers[name];
  const done = (code) => fail(res, code, [clearOauth()]);
  try {
    if (!configured(name)) return done('not_configured');
    const st = readOauthCookie(req);
    if (!st || st.p !== name || st.e < nowS() || !params.state || !safeEq(params.state, st.s) || consumed.has(st.s)) return done('state');
    consumed.set(st.s, st.e); // single use
    if (params.error) return done(params.error === 'access_denied' || params.error === 'user_cancelled_authorize' ? 'access_denied' : 'provider');
    if (!params.code) return done('provider');

    const body = new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: redirectUri(name), client_id: p.id(), client_secret: p.secret() });
    if (p.pkce) body.set('code_verifier', st.v);
    const tok = await fetchJSON(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    if (!tok.access_token && !tok.id_token) throw new Error('no token in response');

    let appleUser = null;
    if (params.user) { try { appleUser = JSON.parse(params.user); } catch (e) { /* ignore */ } }
    const prof = await p.profile(tok, { nonce: st.n, appleUser });
    if (!prof.subject) throw new Error('no subject');

    const { user, created } = findOrCreateUser(Object.assign({ provider: name }, prof));
    const sid = createSession(user, name);
    redirect(res, `/?auth=ok&p=${name}${created ? '&new=1' : ''}`, [cookie(SID_COOKIE, sid, { maxAge: SESSION_TTL }), clearOauth()]);
  } catch (e) {
    console.error(`[auth] ${name} failed:`, e.code || '', e.message);
    done(e instanceof AuthError ? e.code : 'provider');
  }
}


/* ---------- JSON helpers for the POST endpoints ---------- */
async function readJSON(req) {
  try { return JSON.parse((await readBody(req, 20000)) || '{}'); } catch (e) { return null; }
}
function signedBlob(obj) { const b = b64u(JSON.stringify(obj)); return b + '.' + hmac(b); }
function readSigned(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const [b, sig] = raw.split('.');
  if (!b || !sig || !safeEq(sig, hmac(b))) return null;
  try { return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch (e) { return null; }
}
const startSession = (res, user, provider, extraCookies = []) =>
  send(res, 200, { ok: true, user: { id: user.id, name: user.name, email: user.email, provider } },
    { 'Set-Cookie': [cookie(SID_COOKIE, createSession(user, provider), { maxAge: SESSION_TTL }), ...extraCookies] });


/* ---------- password accounts (normal sign up / sign in) ---------- */
// scrypt = a deliberately slow, memory-hungry hash, so stolen hashes are very hard to crack. Each password gets its own random salt.
const scryptAsync = (pw, salt) => new Promise((ok, bad) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? bad(e) : ok(k))));
const loginTries = new Map(); // "email|ip" -> timestamps; 8 wrong tries per 10 minutes
const DUMMY_SALT = crypto.randomBytes(16);
const clean = (x, n) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
async function pwRegister(req, res, body) {
  const name = clean(body.name, 80), email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
  if (name.length < 2) return send(res, 400, { error: 'bad_name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(res, 400, { error: 'bad_email' });
  if (pw.length < 8 || pw.length > 128) return send(res, 400, { error: 'weak_password' });
  if (store.users.some((u) => u.email === email)) return send(res, 409, { error: 'email_exists' });
  const salt = crypto.randomBytes(16), key = await scryptAsync(pw, salt);
  if (store.users.some((u) => u.email === email)) return send(res, 409, { error: 'email_exists' }); // re-check: another request may have won while we were hashing
  const user = { id: 'u_' + rand(12), email, name, emailVerified: false, createdAt: nowS(), lastLoginAt: nowS(),
    pw: { s: salt.toString('base64'), h: key.toString('base64') },
    profile: { course: clean(body.course, 60), field: clean(body.field, 60), duration: clean(body.duration, 40), specific: clean(body.specific, 60) } };
  store.users.push(user); persist();
  startSession(res, user, 'password');
}
async function pwLogin(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || ''), k = email + '|' + clientIp(req), t = Date.now();
  const h = (loginTries.get(k) || []).filter((x) => t - x < 600000);
  if (h.length >= 8) return send(res, 429, { error: 'too_many_requests' });
  const user = store.users.find((u) => u.email === email);
  const salt = user && user.pw ? Buffer.from(user.pw.s, 'base64') : DUMMY_SALT;
  const key = await scryptAsync(pw.slice(0, 128), salt); // hashed even for unknown emails, so timing does not reveal which emails exist
  if (!(user && user.pw && safeEq(key.toString('base64'), user.pw.h))) { h.push(t); loginTries.set(k, h); if (loginTries.size > 5000) loginTries.clear(); return send(res, 401, { error: 'bad_credentials' }); }
  loginTries.delete(k); user.lastLoginAt = nowS(); persist();
  startSession(res, user, 'password');
}

/* ---------- email confirmation codes (sent with Brevo's free plan) ---------- */
const mailConfigured = () => !!(env.BREVO_API_KEY && env.MAIL_FROM);
async function sendMail(to, subject, html, text) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: env.MAIL_FROM_NAME || 'BixTech Academy', email: env.MAIL_FROM }, to: [{ email: to }], subject, htmlContent: html, textContent: text }) });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    // turn Brevo's answer into a plain-English fix, printed in the server terminal (never shown to students)
    const hint = r.status === 401 ? (/ip/i.test(body) ? 'Brevo blocked this server IP: Brevo > Security > Authorised IPs > deactivate blocking (or add this server).' : 'BREVO_API_KEY is wrong or revoked: create a new API key (v3) in Brevo.')
      : r.status === 400 || r.status === 403 ? 'MAIL_FROM is not a verified sender: Brevo > Senders, Domains & Dedicated IPs > Senders > add and verify that exact address.'
      : r.status === 429 ? 'Brevo daily sending limit reached.' : 'Unexpected Brevo answer.';
    throw new Error('mail ' + r.status + ' ' + body + '  ->  FIX: ' + hint);
  }
}
const OTP_COOKIE = (SECURE ? '__Host-' : '') + 'bix_otp';
const otpAttempts = new Map(), otpSent = new Map();
const otpHash = (email, code, nonce) => hmac('otp|' + email + '|' + code + '|' + nonce);
const nameFromEmail = (e) => e.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);

async function otpStart(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return send(res, 400, { error: 'bad_email' });
  if (!mailConfigured()) return send(res, 503, { error: 'mail_not_configured' });
  if (Date.now() - (otpSent.get(email) || 0) < 45000) return send(res, 429, { error: 'wait' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), nonce = rand(12);
  const name = String(body.name || '').trim().slice(0, 80);
  try {
    await sendMail(email, `${code} is your BixTech Academy sign-in code`,
      `<div style="font-family:Arial,sans-serif;max-width:420px"><h2>Your sign-in code</h2><p style="font-size:32px;letter-spacing:6px;font-weight:700">${code}</p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p></div>`,
      `Your BixTech Academy sign-in code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this email.`);
  } catch (e) { console.error('[mail]', e.message); return send(res, 502, { error: 'mail_failed' }); }
  otpSent.set(email, Date.now());
  const blob = signedBlob({ m: email, h: otpHash(email, code, nonce), n: nonce, e: nowS() + 600, u: name });
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(OTP_COOKIE, blob, { maxAge: 600 }) });
}
async function otpVerify(req, res, body) {
  const c = readSigned(req, OTP_COOKIE);
  if (!c || c.e < nowS() || consumed.has('otp:' + c.n)) return send(res, 400, { error: 'expired' });
  const tries = (otpAttempts.get(c.n) || 0) + 1;
  otpAttempts.set(c.n, tries);
  if (tries > 5) return send(res, 429, { error: 'too_many' });
  const code = String(body.code || '').replace(/\D/g, '');
  if (code.length !== 6 || !safeEq(otpHash(c.m, code, c.n), c.h)) return send(res, 400, { error: 'bad_code' });
  consumed.set('otp:' + c.n, c.e); // a code works once
  try {
    const { user } = findOrCreateUser({ provider: 'email', subject: c.m, email: c.m, emailVerified: true, name: c.u || nameFromEmail(c.m) });
    startSession(res, user, 'email', [cookie(OTP_COOKIE, '', { maxAge: 0 })]);
  } catch (e) { console.error('[otp]', e.message); send(res, 500, { error: 'server_error' }); }
}

/* ---------- passkeys: Face ID / fingerprint / device unlock (WebAuthn) ---------- */
const WA_COOKIE = (SECURE ? '__Host-' : '') + 'bix_wa';
const RP_ID = new URL(BASE_URL).hostname, ORIGIN = new URL(BASE_URL).origin;
function cborDecode(buf) {
  let p = 0;
  const item = () => {
    const ib = buf[p++], mt = ib >> 5, ai = ib & 31;
    const len = () => { if (ai < 24) return ai; if (ai === 24) return buf[p++]; if (ai === 25) { const v = buf.readUInt16BE(p); p += 2; return v; } if (ai === 26) { const v = buf.readUInt32BE(p); p += 4; return v; } throw new Error('cbor length'); };
    if (mt === 0) return len();
    if (mt === 1) return -1 - len();
    if (mt === 2) { const n = len(); const b = buf.subarray(p, p + n); p += n; return b; }
    if (mt === 3) { const n = len(); const t = buf.toString('utf8', p, p + n); p += n; return t; }
    if (mt === 4) { const n = len(), a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
    if (mt === 5) { const n = len(), m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
    if (mt === 7 && ai === 20) return false;
    if (mt === 7 && ai === 21) return true;
    if (mt === 7 && ai === 22) return null;
    throw new Error('cbor type');
  };
  return item();
}
function parseAuthData(ad) {
  const out = { rpIdHash: ad.subarray(0, 32), flags: ad[32], counter: ad.readUInt32BE(33) };
  if (out.flags & 0x40) {
    const n = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + n);
    out.cose = cborDecode(ad.subarray(55 + n));
  }
  return out;
}
function coseToJwk(m) {
  const kty = m.get(1);
  if (kty === 2 && m.get(-1) === 1) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 3) return { alg: -257, jwk: { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  throw new Error('unsupported key type');
}
function checkClientData(b64, type, c) {
  const raw = Buffer.from(String(b64), 'base64url');
  const cd = JSON.parse(raw.toString('utf8'));
  if (cd.type !== type || !safeEq(cd.challenge || '', c.c) || cd.origin !== ORIGIN) throw new Error('bad clientData');
  return raw;
}
const checkAuthFlags = (ad) => {
  if (!safeEq(b64u(ad.rpIdHash), b64u(sha256(RP_ID)))) throw new Error('bad rpId');
  if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new Error('user not verified'); // must have used Face ID / PIN
};

async function passkeyRegOptions(req, res) {
  const s = sessionFrom(req);
  if (!s) return send(res, 401, { error: 'unauthenticated' });
  const challenge = rand(32);
  const mine = store.passkeys.filter((k) => k.userId === s.user.id);
  send(res, 200, { publicKey: {
    challenge, rp: { name: 'BixTech Academy', id: RP_ID },
    user: { id: b64u(s.user.id), name: s.user.email, displayName: s.user.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none', timeout: 60000, excludeCredentials: mine.map((k) => ({ type: 'public-key', id: k.id })),
  } }, { 'Set-Cookie': cookie(WA_COOKIE, signedBlob({ c: challenge, t: 'reg', u: s.user.id, e: nowS() + 300 }), { maxAge: 300 }) });
}
async function passkeyRegVerify(req, res, body) {
  const s = sessionFrom(req), c = readSigned(req, WA_COOKIE);
  if (!s) return send(res, 401, { error: 'unauthenticated' });
  try {
    if (!c || c.t !== 'reg' || c.u !== s.user.id || c.e < nowS() || consumed.has('wa:' + c.c)) throw new Error('challenge');
    consumed.set('wa:' + c.c, c.e);
    checkClientData(body.response.clientDataJSON, 'webauthn.create', c);
    const att = cborDecode(Buffer.from(body.response.attestationObject, 'base64url'));
    const ad = parseAuthData(att.get('authData'));
    checkAuthFlags(ad);
    if (!ad.credId || b64u(ad.credId) !== body.id) throw new Error('credential id');
    const { alg, jwk } = coseToJwk(ad.cose);
    if (store.passkeys.filter((k) => k.userId === s.user.id).length >= 5) throw new Error('too many passkeys');
    store.passkeys.push({ id: b64u(ad.credId), userId: s.user.id, alg, jwk, counter: ad.counter, createdAt: nowS() });
    persist();
    send(res, 200, { ok: true }, { 'Set-Cookie': cookie(WA_COOKIE, '', { maxAge: 0 }) });
  } catch (e) { console.error('[passkey register]', e.message); send(res, 400, { error: 'passkey_failed' }); }
}
async function passkeyLoginOptions(req, res) {
  const challenge = rand(32);
  send(res, 200, { publicKey: { challenge, rpId: RP_ID, timeout: 60000, userVerification: 'required', allowCredentials: [] } },
    { 'Set-Cookie': cookie(WA_COOKIE, signedBlob({ c: challenge, t: 'auth', e: nowS() + 300 }), { maxAge: 300 }) });
}
async function passkeyLoginVerify(req, res, body) {
  const c = readSigned(req, WA_COOKIE);
  try {
    if (!c || c.t !== 'auth' || c.e < nowS() || consumed.has('wa:' + c.c)) throw new Error('challenge');
    consumed.set('wa:' + c.c, c.e);
    const cred = store.passkeys.find((k) => k.id === body.id);
    if (!cred) throw new Error('unknown credential');
    const r = body.response;
    const cdRaw = checkClientData(r.clientDataJSON, 'webauthn.get', c);
    const adRaw = Buffer.from(r.authenticatorData, 'base64url'), ad = parseAuthData(adRaw);
    checkAuthFlags(ad);
    const data = Buffer.concat([adRaw, sha256(cdRaw)]), sig = Buffer.from(r.signature, 'base64url');
    const key = crypto.createPublicKey({ key: cred.jwk, format: 'jwk' });
    const ok = cred.alg === -7 ? crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig) : crypto.verify('sha256', data, key, sig);
    if (!ok) throw new Error('bad signature');
    if ((cred.counter || ad.counter) && ad.counter <= cred.counter) throw new Error('counter went backwards (cloned key?)');
    cred.counter = ad.counter;
    const user = store.users.find((u) => u.id === cred.userId);
    if (!user) throw new Error('no user');
    user.lastLoginAt = nowS(); persist();
    startSession(res, user, 'passkey', [cookie(WA_COOKIE, '', { maxAge: 0 })]);
  } catch (e) { console.error('[passkey login]', e.message); send(res, 400, { error: 'passkey_failed' }); }
}
const POST_ROUTES = {
  '/auth/register': pwRegister, '/auth/login': pwLogin,
  '/auth/email/start': otpStart, '/auth/email/verify': otpVerify,
  '/auth/passkey/register/options': passkeyRegOptions, '/auth/passkey/register/verify': passkeyRegVerify,
  '/auth/passkey/login/options': passkeyLoginOptions, '/auth/passkey/login/verify': passkeyLoginVerify,
};

/* ============================================================================
 * INTERNSHIP APPLICATION DOCUMENTS
 * A student uploads the PHOTO or PDF of the form their school gave them. An admin
 * reviews it. Two things are stored separately:
 *   - the record (who, when, status, comment)  -> store.applications (same place as accounts)
 *   - the file bytes                            -> DATA_DIR/uploads/<fileId>  (or Upstash if configured)
 * ========================================================================== */
const UPLOAD_DIR = path.join(env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
// Size limit. With Upstash the file travels as base64 (+33%), and Upstash accepts requests up to 10 MB, so 7 MB is the safe ceiling there.
const MAX_UPLOAD = (UP_URL && UP_TOKEN ? Math.min(Number(env.MAX_UPLOAD_MB) || 7, 7) : (Number(env.MAX_UPLOAD_MB) || 7)) * 1024 * 1024;
const ADMIN_EMAIL = String(env.ADMIN_EMAIL || 'bixtech3@gmail.com').trim().toLowerCase();
const ADMIN_COOKIE = (SECURE ? '__Host-' : '') + 'bix_adm';
const ADMIN_TTL = 8 * 3600; // an admin sign-in lasts 8 hours
const adminConfigured = () => String(env.ADMIN_PASSWORD || '').length >= 8; // no password set (or too short) = admin API stays locked
const STATUSES = ['pending', 'approved', 'rejected'];

/* ---- file storage: disk by default, Upstash when configured (survives restarts on free hosts) ---- */
const FILE_ID = /^[A-Za-z0-9_-]{8,64}$/; // fileIds are generated by us; this regex also blocks "../" path tricks
async function fileSave(id, buf) {
  if (UP_URL && UP_TOKEN) return upstash(['SET', 'bixtech:file:' + id, buf.toString('base64')], 40000);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf, { mode: 0o600 });
}
async function fileLoad(id) {
  if (!FILE_ID.test(id)) return null;
  if (UP_URL && UP_TOKEN) { const v = await upstash(['GET', 'bixtech:file:' + id], 40000); return v ? Buffer.from(v, 'base64') : null; }
  try { return fs.readFileSync(path.join(UPLOAD_DIR, id)); } catch (e) { return null; }
}
async function fileDelete(id) {
  if (!FILE_ID.test(id)) return;
  try {
    if (UP_URL && UP_TOKEN) await upstash(['DEL', 'bixtech:file:' + id]);
    else fs.unlinkSync(path.join(UPLOAD_DIR, id));
  } catch (e) { /* already gone */ }
}

/* ---- validation: we never trust the browser's file type, we look at the first bytes ("magic numbers") ---- */
function sniffType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(b.toString('latin1', 8, 12))) return { heic: true }; // iPhone HEIC photo
  return null;
}
function cleanName(raw, ext) { // safe display name: no slashes, no control characters, always ends with the real extension
  let n = ''; try { n = decodeURIComponent(String(raw || '')); } catch (e) { /* keep empty */ }
  n = n.replace(/[\x00-\x1f\x7f<>:"\/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return (n.slice(0, 80) || 'application-form') + '.' + ext;
}
// Read a raw (binary) request body. Too big -> we keep draining it (so we can still answer 413) and only cut the connection if it is absurd.
function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { over = true; if (size > limit * 3) req.destroy(); } else if (!over) chunks.push(c); });
    req.on('end', () => (over ? reject(new AuthError('too_large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
const publicApp = (a, admin) => ({
  id: a.id, name: a.name, email: a.email, fileName: a.fileName, mime: a.mime, size: a.size,
  submittedAt: a.submittedAt, status: a.status, comment: a.comment || '', reviewedAt: a.reviewedAt || null,
  attempts: a.attempts || 1, history: a.history || [],
  ...(admin ? { sha256: a.sha256, reviewedBy: a.reviewedBy || null, course: a.course || '', field: a.field || '', duration: a.duration || '' } : {}),
});
const clientIp = (req) => (SECURE && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '?';
const isFetch = (req) => req.headers['x-requested-with'] === 'fetch'; // CSRF guard: browsers won't let other sites add this header
const isJson = (req) => /^application\/json/.test(req.headers['content-type'] || '');

/* ---- admin sign-in (server side). The old admin screen only checks a password inside the browser, which can't protect files held on the server. ---- */
function adminFrom(req) {
  const c = readSigned(req, ADMIN_COOKIE);
  return c && c.a === 1 && c.e > nowS() && !revoked.has(c.j) ? c : null;
}
const adminTries = new Map(); // ip -> timestamps of recent sign-in attempts
function adminLimited(req) { // 8 attempts per 10 minutes per address
  const ip = clientIp(req), t = Date.now(), h = (adminTries.get(ip) || []).filter((x) => t - x < 600000);
  h.push(t); adminTries.set(ip, h); if (adminTries.size > 2000) adminTries.clear();
  return h.length > 8;
}
async function adminLogin(req, res) {
  if (!isFetch(req) || !isJson(req)) return send(res, 403, { error: 'forbidden' });
  if (!adminConfigured()) return send(res, 503, { error: 'admin_not_configured' });
  if (adminLimited(req)) return send(res, 429, { error: 'too_many_requests' });
  const body = await readJSON(req); if (!body) return send(res, 400, { error: 'bad_request' });
  // compare HMACs of both values: same length every time, and timingSafeEqual leaks nothing about how many characters matched
  const okE = safeEq(hmac('adm-e|' + String(body.email || '').trim().toLowerCase()), hmac('adm-e|' + ADMIN_EMAIL));
  const okP = safeEq(hmac('adm-p|' + String(body.password || '')), hmac('adm-p|' + env.ADMIN_PASSWORD));
  if (!(okE && okP)) return send(res, 401, { error: 'bad_credentials' });
  adminTries.delete(clientIp(req));
  send(res, 200, { ok: true, email: ADMIN_EMAIL }, { 'Set-Cookie': cookie(ADMIN_COOKIE, signedBlob({ a: 1, j: rand(12), e: nowS() + ADMIN_TTL }), { maxAge: ADMIN_TTL, sameSite: 'Strict' }) });
}

/* ---- sending a stored file back to the browser ---- */
async function sendDocument(res, a, download) {
  const buf = await fileLoad(a.fileId);
  if (!buf) return send(res, 410, { error: 'file_missing' }); // record exists but the bytes are gone (e.g. a free host wiped its disk)
  const ascii = a.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': a.mime, 'Content-Length': buf.length,
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN', // our own admin page may show the PDF in a frame; other sites may not
    'Content-Security-Policy': a.mime === 'application/pdf' ? "frame-ancestors 'self'; base-uri 'none'" : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
  });
  res.end(buf);
}

const uploadHits = new Map(); // userId -> timestamps (max 10 uploads per hour per student)

async function appsRoute(req, res, pathname, url) {
  const method = req.method;

  /* ---------- admin session ---------- */
  if (pathname === '/api/admin/session' && method === 'GET') {
    const on = !!adminFrom(req);
    return send(res, 200, { admin: on, configured: adminConfigured(), email: on ? ADMIN_EMAIL : undefined });
  }
  if (pathname === '/api/admin/login' && method === 'POST') return adminLogin(req, res);
  if (pathname === '/api/admin/logout' && method === 'POST') {
    if (!isFetch(req)) return send(res, 403, { error: 'forbidden' });
    const c = adminFrom(req); if (c) revoked.set(c.j, c.e);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(ADMIN_COOKIE, '', { maxAge: 0, sameSite: 'Strict' }) });
  }

  /* ---------- student side (needs the normal student sign-in cookie) ---------- */
  if (pathname.startsWith('/api/applications')) {
    const s = sessionFrom(req);
    if (!s) return send(res, 401, { error: 'unauthenticated' });
    const mine = () => store.applications.find((a) => a.userId === s.user.id);

    if (pathname === '/api/applications/mine' && method === 'GET') {
      const a = mine();
      return send(res, 200, { application: a ? publicApp(a, false) : null, maxBytes: MAX_UPLOAD });
    }
    if (pathname === '/api/applications/mine/file' && method === 'GET') {
      const a = mine(); if (!a) return send(res, 404, { error: 'not_found' });
      return sendDocument(res, a, url.searchParams.get('download') === '1');
    }
    if (pathname === '/api/applications' && method === 'POST') {
      if (!isFetch(req)) return send(res, 403, { error: 'forbidden' });
      const t = Date.now(), h = (uploadHits.get(s.user.id) || []).filter((x) => t - x < 3600000);
      if (h.length >= 10) return send(res, 429, { error: 'too_many_uploads' });
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > MAX_UPLOAD) return send(res, 413, { error: 'too_large', maxBytes: MAX_UPLOAD }, { Connection: 'close' });
      let buf;
      try { buf = await readBuffer(req, MAX_UPLOAD); }
      catch (e) { return send(res, e.code === 'too_large' ? 413 : 400, { error: e.code === 'too_large' ? 'too_large' : 'bad_request', maxBytes: MAX_UPLOAD }, { Connection: 'close' }); }
      if (!buf.length) return send(res, 400, { error: 'empty_file' });
      const kind = sniffType(buf);
      if (!kind) return send(res, 415, { error: 'unsupported_type' });
      if (kind.heic) return send(res, 415, { error: 'heic_unsupported' });
      const old = mine();
      if (old && old.status === 'approved') return send(res, 409, { error: 'already_approved' }); // an approved form is final
      h.push(t); uploadHits.set(s.user.id, h);
      const fileId = rand(18);
      try { await fileSave(fileId, buf); }
      catch (e) { console.error('[apps] could not save file:', e.message); return send(res, 500, { error: 'storage_failed' }); }
      const fresh = {
        id: old ? old.id : 'a_' + rand(9), userId: s.user.id, name: s.user.name, email: s.user.email,
        course: ((store.users.find((u) => u.id === s.user.id) || {}).profile || {}).course || '', field: ((store.users.find((u) => u.id === s.user.id) || {}).profile || {}).field || '', duration: ((store.users.find((u) => u.id === s.user.id) || {}).profile || {}).duration || '',
        fileId, fileName: cleanName(req.headers['x-file-name'], kind.ext), mime: kind.mime, size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        submittedAt: new Date().toISOString(), status: 'pending', comment: '', reviewedAt: null, reviewedBy: null,
        attempts: old ? (old.attempts || 1) + 1 : 1,
        history: old ? (old.history || []).concat(old.status === 'rejected' ? [{ status: 'rejected', comment: old.comment, at: old.reviewedAt }] : []) : [],
      };
      if (old) store.applications[store.applications.indexOf(old)] = fresh; else store.applications.push(fresh);
      persist();
      if (old) fileDelete(old.fileId); // the replaced file is no longer needed
      return send(res, 201, { ok: true, application: publicApp(fresh, false) });
    }
    return send(res, 405, { error: 'method_not_allowed' });
  }

  /* ---------- attendance (needs the server-side admin cookie) ---------- */
  if (pathname.startsWith('/api/admin/attendance')) {
    if (!adminFrom(req)) return send(res, 401, { error: 'admin_required' });
    return attendanceRoute(req, res, pathname, url);
  }

  /* ---------- admin review (needs the server-side admin cookie) ---------- */
  if (pathname.startsWith('/api/admin/applications')) {
    if (!adminFrom(req)) return send(res, 401, { error: 'admin_required' });

    if (pathname === '/api/admin/applications' && method === 'GET') {
      const status = url.searchParams.get('status') || 'all', q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const counts = { all: store.applications.length, pending: 0, approved: 0, rejected: 0 };
      store.applications.forEach((a) => { counts[a.status]++; });
      const list = store.applications
        .filter((a) => (status === 'all' || a.status === status) && (!q || (a.name + ' ' + a.email).toLowerCase().includes(q)))
        .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)) // newest first
        .map((a) => publicApp(a, true));
      return send(res, 200, { counts, applications: list });
    }
    const m = pathname.match(/^\/api\/admin\/applications\/([A-Za-z0-9_-]{4,40})(\/file|\/review)?$/);
    if (!m) return send(res, 404, { error: 'not_found' });
    const a = store.applications.find((x) => x.id === m[1]);
    if (!a) return send(res, 404, { error: 'not_found' });

    if (!m[2] && method === 'GET') return send(res, 200, { application: publicApp(a, true) });
    if (m[2] === '/file' && method === 'GET') return sendDocument(res, a, url.searchParams.get('download') === '1');
    if (m[2] === '/review' && method === 'POST') {
      if (!isFetch(req) || !isJson(req)) return send(res, 403, { error: 'forbidden' });
      const body = await readJSON(req); if (!body) return send(res, 400, { error: 'bad_request' });
      const decision = String(body.decision || ''), comment = String(body.comment || '').trim().slice(0, 1000);
      if (!STATUSES.includes(decision) || decision === 'pending') return send(res, 400, { error: 'bad_decision' });
      if (decision === 'rejected' && comment.length < 3) return send(res, 400, { error: 'comment_required' }); // a rejection must tell the student why
      if (a.status !== 'pending') a.history = (a.history || []).concat([{ status: a.status, comment: a.comment, at: a.reviewedAt }]); // keep the earlier decision if the admin changes their mind
      a.status = decision; a.comment = comment; a.reviewedAt = new Date().toISOString(); a.reviewedBy = ADMIN_EMAIL;
      persist();
      return send(res, 200, { ok: true, application: publicApp(a, true) });
    }
    return send(res, 405, { error: 'method_not_allowed' });
  }
  return send(res, 404, { error: 'not_found' });
}

/* ============================================================================
 * ATTENDANCE: the admin marks each registered student present or absent per day.
 * Stored in store.attendance (same place as accounts), so it survives restarts when Upstash is on.
 * ========================================================================== */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d) => DAY.test(String(d)) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d
  && Date.parse(d + 'T00:00:00Z') <= Date.now() + 2 * 86400000; // a real calendar day, not further than tomorrow
const studentRow = (u) => { const p = u.profile || {}; return { id: u.id, name: u.name, email: u.email, course: p.course || '', field: p.field || '', specific: p.specific || '', duration: p.duration || '' }; };
const allStudents = () => store.users.map(studentRow).sort((a, b) => a.name.localeCompare(b.name));
function attendanceTotals(from, to) { // per student: days present / absent between from and to (inclusive, both optional)
  const days = Object.keys(store.attendance).filter((d) => (!from || d >= from) && (!to || d <= to)).sort();
  return { days, rows: allStudents().map((s) => {
    let present = 0, absent = 0;
    for (const d of days) { const m = store.attendance[d][s.id]; if (m === 'p') present++; else if (m === 'a') absent++; }
    const marked = present + absent;
    return Object.assign(s, { present, absent, marked, percent: marked ? Math.round(present / marked * 1000) / 10 : null });
  }) };
}
const csvCell = (x) => { x = String(x == null ? '' : x); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return '"' + x.replace(/"/g, '""') + '"'; }; // quotes; the ' stops spreadsheet formula tricks
async function attendanceRoute(req, res, pathname, url) {
  const method = req.method;
  if (pathname === '/api/admin/attendance' && method === 'GET') {
    const date = url.searchParams.get('date') || '';
    if (!validDay(date)) return send(res, 400, { error: 'bad_date' });
    const day = store.attendance[date] || {};
    const students = allStudents().map((s) => Object.assign(s, { status: day[s.id] === 'p' ? 'present' : day[s.id] === 'a' ? 'absent' : null }));
    return send(res, 200, { date, students, markedDays: Object.keys(store.attendance).length });
  }
  if (pathname === '/api/admin/attendance' && method === 'POST') {
    if (!isFetch(req) || !isJson(req)) return send(res, 403, { error: 'forbidden' });
    const body = await readJSON(req); if (!body || !Array.isArray(body.marks) || body.marks.length > 2000) return send(res, 400, { error: 'bad_request' });
    if (!validDay(body.date)) return send(res, 400, { error: 'bad_date' });
    const ids = new Set(store.users.map((u) => u.id));
    for (const m of body.marks) if (!m || !ids.has(m.userId) || !['present', 'absent', ''].includes(m.status)) return send(res, 400, { error: 'bad_mark' });
    const day = store.attendance[body.date] || (store.attendance[body.date] = {});
    for (const m of body.marks) { if (m.status === '') delete day[m.userId]; else day[m.userId] = m.status === 'present' ? 'p' : 'a'; }
    if (!Object.keys(day).length) delete store.attendance[body.date];
    persist();
    return send(res, 200, { ok: true });
  }
  if ((pathname === '/api/admin/attendance/report' || pathname === '/api/admin/attendance/report.csv') && method === 'GET') {
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) return send(res, 400, { error: 'bad_date' });
    const t = attendanceTotals(from, to);
    if (pathname.endsWith('.csv')) {
      const daily = url.searchParams.get('type') === 'daily';
      const head = ['Name', 'Email', 'Course', 'Field', 'Specific course'];
      const lines = [];
      if (daily) {
        lines.push(head.concat(['Date', 'Status']).map(csvCell).join(','));
        for (const s of t.rows) for (const d of t.days) { const m = store.attendance[d][s.id]; if (m) lines.push([s.name, s.email, s.course, s.field, s.specific, d, m === 'p' ? 'Present' : 'Absent'].map(csvCell).join(',')); }
      } else {
        lines.push(head.concat(['Days present', 'Days absent', 'Days marked', 'Attendance %']).map(csvCell).join(','));
        for (const s of t.rows) lines.push([s.name, s.email, s.course, s.field, s.specific, s.present, s.absent, s.marked, s.percent == null ? '' : s.percent].map(csvCell).join(','));
      }
      return send(res, 200, '\ufeff' + lines.join('\r\n') + '\r\n', { 'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="bixtech-attendance-${daily ? 'daily' : 'summary'}.csv"` }); // BOM so Excel reads accents correctly
    }
    return send(res, 200, { days: t.days.length, from: t.days[0] || null, to: t.days[t.days.length - 1] || null, students: t.rows });
  }
  return send(res, 404, { error: 'not_found' });
}

/* ---------- static files ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain' };
const PUBLIC_PAGES = ['/']; // pages Google may index (private areas live inside the app, behind login)
function seoFile(res, pathname) {
  if (pathname === '/robots.txt') {
    send(res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\n\nSitemap: ${BASE_URL}/sitemap.xml\n`, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return true;
  }
  if (pathname === '/sitemap.xml') {
    const day = new Date().toISOString().slice(0, 10);
    const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${BASE_URL}${p}</loc><lastmod>${day}</lastmod></url>`).join('\n');
    send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    return true;
  }
  return false;
}
function serveStatic(req, res, pathname) {
  if (seoFile(res, pathname)) return;
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page not found · BixTech</title><body style="font-family:sans-serif;text-align:center;padding:3rem"><h1>404</h1><p>This page doesn’t exist.</p><p><a href="/">Back to BixTech</a></p>', { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (path.extname(file) === '.html') { // fill in the real address and optional Google verification tag
      const verify = env.GOOGLE_SITE_VERIFICATION ? `<meta name="google-site-verification" content="${String(env.GOOGLE_SITE_VERIFICATION).replace(/[^A-Za-z0-9_-]/g, '')}">\n` : '';
      data = Buffer.from(data.toString('utf8').split('%%BASE_URL%%').join(BASE_URL).split('%%VERIFY%%').join(verify));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* ---------- router ---------- */
async function handler(req, res) {
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
  const url = new URL(req.url, BASE_URL);
  const { pathname } = url;
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    if (pathname.startsWith('/auth/') && limited(req)) return send(res, 429, { error: 'too_many_requests' });

    if (pathname === '/healthz') return send(res, 200, { ok: true });

    if (pathname === '/api/providers' && req.method === 'GET')
      return send(res, 200, { baseUrl: BASE_URL, providers: Object.fromEntries(Object.keys(providers).map((k) => [k, configured(k)])), features: { emailCode: mailConfigured(), passkey: true } });

    if (pathname === '/api/me' && req.method === 'GET') { // protected route
      const s = sessionFrom(req);
      if (!s && url.searchParams.get('soft') === '1') return send(res, 200, { user: null }); // "am I signed in?" probe: answers 200 so the browser console stays free of red 401 lines
      if (!s) return send(res, 401, { error: 'unauthenticated' });
      return send(res, 200, { user: { id: s.user.id, name: s.user.name, email: s.user.email, provider: s.provider } });
    }

    if (pathname === '/auth/logout' && req.method === 'POST') {
      if (req.headers['x-requested-with'] !== 'fetch') return send(res, 403, { error: 'forbidden' }); // CSRF guard
      const s = sessionFrom(req);
      if (s) revoked.set(s.key, s.exp);
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(SID_COOKIE, '', { maxAge: 0 }) });
    }

    if (pathname.startsWith('/api/applications') || pathname.startsWith('/api/admin/')) return await appsRoute(req, res, pathname, url); // await, so a failure inside is caught by the try/catch below instead of crashing the process

    if (req.method === 'POST' && POST_ROUTES[pathname]) {
      if (req.headers['x-requested-with'] !== 'fetch' || !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 403, { error: 'forbidden' }); // CSRF guard
      const body = await readJSON(req);
      if (!body) return send(res, 400, { error: 'bad_request' });
      return POST_ROUTES[pathname](req, res, body);
    }

    const m = pathname.match(/^\/auth\/(google|apple|github|facebook|microsoft)(\/callback)?$/);
    if (m) {
      const name = m[1];
      if (!m[2] && req.method === 'GET') return startLogin(res, name);
      if (m[2] && req.method === 'GET' && !providers[name].formPost) return finishLogin(req, res, name, Object.fromEntries(url.searchParams));
      if (m[2] && req.method === 'POST' && providers[name].formPost)
        return finishLogin(req, res, name, Object.fromEntries(new URLSearchParams(await readBody(req))));
      return send(res, 405, 'Method not allowed');
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('[server]', e);
    send(res, 500, { error: 'server_error' });
  }
}

const server = http.createServer(handler);
if (require.main === module) {
  loadRemote().catch((e) => console.error('[store] could not load from Upstash:', e.message)).then(() => server.listen(PORT, () => {
    console.log(`BixTech running at ${BASE_URL}`);
    for (const k of Object.keys(providers)) {
      console.log(`  ${providers[k].label.padEnd(10)} ${configured(k) ? 'READY' : 'NOT SET UP, missing: ' + missing(k).join(', ')}`);
      console.log(`  ${''.padEnd(10)} callback URL to register: ${redirectUri(k)}`);
    }
    console.log(`  Email codes: ${mailConfigured() ? 'READY' : 'NOT SET UP, missing: BREVO_API_KEY, MAIL_FROM'}`);
    console.log(`  Admin review: ${adminConfigured() ? 'READY (admin email ' + ADMIN_EMAIL + ')' : 'NOT SET UP, set ADMIN_PASSWORD (8+ characters) to open the Internship Applications review'}`);
    console.log(`  Uploaded forms: ${UP_URL ? 'Upstash (permanent)' : UPLOAD_DIR + ' (lost when a free host restarts; see README)'}, max ${Math.round(MAX_UPLOAD / 1048576)} MB each`);
    console.log(`  Saved accounts: ${UP_URL ? 'Upstash (permanent)' : 'local file (lost when a free host restarts; see README)'}`);
  }));
}
module.exports = { server, store, providers, missing };
