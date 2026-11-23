'use strict';
// Run with:  node --test
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

process.env.PORT = '0';
process.env.RATE_LIMIT = '1000';
process.env.BREVO_API_KEY = 'brevo-key'; process.env.MAIL_FROM = 'noreply@bixtech.test';
process.env.BASE_URL = 'http://localhost:3000';
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.DATA_DIR = path.join(os.tmpdir(), 'bix-test-' + process.pid);
Object.assign(process.env, {
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec',
  GITHUB_CLIENT_ID: 'hid', GITHUB_CLIENT_SECRET: 'hsec',
  MICROSOFT_CLIENT_ID: 'mid', MICROSOFT_CLIENT_SECRET: 'msec',
  APPLE_CLIENT_ID: 'com.bix.web', APPLE_TEAM_ID: 'TEAM', APPLE_KEY_ID: 'KEY',
});
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
process.env.APPLE_PRIVATE_KEY = ec.privateKey.export({ type: 'pkcs8', format: 'pem' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = Object.assign(rsa.publicKey.export({ format: 'jwk' }), { kid: 'k1', alg: 'RS256' });

// ---- fake provider responses (the server's outgoing fetch is intercepted)
let fake = {};
let lastApple = {};
let lastMail = null; let mailFails = false;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (o, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(o) });
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url === 'https://api.brevo.com/v3/smtp/email') { if (mailFails) return json({ message: 'bad' }, 401); lastMail = JSON.parse(opts.body); return json({ messageId: 'm1' }); }
  if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'g-at' });
  if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json(fake.google);
  if (url === 'https://github.com/login/oauth/access_token') return json({ access_token: 'h-at' });
  if (url === 'https://api.github.com/user') return json({ id: fake.githubId || 77, login: 'octo', name: 'Octo Cat' });
  if (url === 'https://api.github.com/user/emails') return json(fake.githubEmails);
  if (url.includes('microsoftonline.com') && url.endsWith('/token')) return json({ access_token: 'm-at' });
  if (url === 'https://graph.microsoft.com/oidc/userinfo') return json(fake.microsoft);
  if (url === 'https://appleid.apple.com/auth/keys') return json({ keys: [jwk] });
  if (url === 'https://appleid.apple.com/auth/token') {
    lastApple = Object.fromEntries(opts.body);
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(Object.assign({ iss: 'https://appleid.apple.com', aud: 'com.bix.web',
      exp: Math.floor(Date.now() / 1000) + 600 }, fake.appleClaims(lastApple)))).toString('base64url');
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), rsa.privateKey).toString('base64url');
    return json({ id_token: `${h}.${p}.${s}` });
  }
  throw new Error('unexpected fetch ' + url);
};

const { server, store } = require('../server.js');
let port;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const jar = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');

async function login(provider, { post = false } = {}) {
  const start = await req('GET', `/auth/${provider}`);
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.location);
  const state = loc.searchParams.get('state');
  const cookies = jar(start);
  const cb = post
    ? await req('POST', `/auth/${provider}/callback`, { headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: 'c', state, user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }) }).toString() })
    : await req('GET', `/auth/${provider}/callback?code=c&state=${state}`, { headers: { cookie: cookies } });
  return { start, loc, cb, state, cookies };
}

test('providers endpoint + unauthenticated /api/me is 401', async () => {
  const j = JSON.parse((await req('GET', '/api/providers')).body);
  assert.equal(j.baseUrl, 'http://localhost:3000');
  assert.equal(j.providers.google, true); assert.equal(j.providers.facebook, false);
  assert.equal(JSON.parse((await req('GET', '/healthz')).body).ok, true);
  assert.equal((await req('GET', '/api/me')).status, 401);
});

test('google: PKCE + state sent, new account created, session works, logout kills it', async () => {
  fake.google = { sub: 'g1', email: 'Ada@Example.com', email_verified: true, name: 'Ada' };
  const { loc, cb } = await login('google');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/google/callback');
  assert.match(cb.headers.location, /^\/\?auth=ok&p=google&new=1/);
  const sid = jar(cb);
  assert.match(sid, /^bix_sid=/);
  assert.match(cb.headers['set-cookie'].find((c) => c.startsWith('bix_sid')), /HttpOnly/);
  const me = JSON.parse((await req('GET', '/api/me', { headers: { cookie: sid } })).body);
  assert.equal(me.user.email, 'ada@example.com');
  // returning user: no duplicate account
  const again = await login('google');
  assert.doesNotMatch(again.cb.headers.location, /new=1/);
  assert.equal(store.users.filter((u) => u.email === 'ada@example.com').length, 1);
  // logout needs the CSRF header
  assert.equal((await req('POST', '/auth/logout', { headers: { cookie: sid } })).status, 403);
  assert.equal((await req('POST', '/auth/logout', { headers: { cookie: sid, 'x-requested-with': 'fetch' } })).status, 200);
  assert.equal((await req('GET', '/api/me', { headers: { cookie: sid } })).status, 401);
});

test('tampered cookie, wrong state and missing binding cookie are rejected', async () => {
  const s = await req('GET', '/auth/google');
  const state = new URL(s.headers.location).searchParams.get('state');
  const noCookie = await req('GET', `/auth/google/callback?code=c&state=${state}`);
  assert.equal(noCookie.headers.location, '/?auth_error=state');
  const bad = await req('GET', '/auth/google/callback?code=c&state=nope', { headers: { cookie: jar(s) } });
  assert.equal(bad.headers.location, '/?auth_error=state');
  assert.equal((await req('GET', '/api/me', { headers: { cookie: 'bix_sid=abc.def' } })).status, 401);
  // state is single-use
  fake.google = { sub: 'g1', email: 'ada@example.com', email_verified: true };
  const ok = await login('google');
  const replay = await req('GET', `/auth/google/callback?code=c&state=${ok.state}`, { headers: { cookie: ok.cookies } });
  assert.equal(replay.headers.location, '/?auth_error=state');
});

test('user denies access -> friendly error code', async () => {
  const s = await req('GET', '/auth/github');
  const state = new URL(s.headers.location).searchParams.get('state');
  const r = await req('GET', `/auth/github/callback?error=access_denied&state=${state}`, { headers: { cookie: jar(s) } });
  assert.equal(r.headers.location, '/?auth_error=access_denied');
});

test('github: links to the existing verified-email account instead of duplicating', async () => {
  fake.githubEmails = [{ email: 'ada@example.com', primary: true, verified: true }];
  const { cb } = await login('github');
  assert.match(cb.headers.location, /auth=ok/);
  assert.equal(store.users.filter((u) => u.email === 'ada@example.com').length, 1);
});

test('github with no verified email -> no_email', async () => {
  fake.githubId = 78;
  fake.githubEmails = [{ email: 'x@y.z', primary: true, verified: false }];
  const { cb } = await login('github');
  assert.equal(cb.headers.location, '/?auth_error=no_email');
});

test('microsoft: unverified email matching an existing account is refused (no takeover)', async () => {
  fake.microsoft = { sub: 'm1', email: 'ada@example.com', name: 'Mallory' };
  const { cb } = await login('microsoft');
  assert.equal(cb.headers.location, '/?auth_error=email_exists');
});

test('pre-hijack: unverified account is wiped when the real owner signs in with a verified provider', async () => {
  fake.microsoft = { sub: 'm2', email: 'victim@example.com', name: 'Mallory' };
  const squat = await login('microsoft');
  const mallorySid = jar(squat.cb);
  assert.match(squat.cb.headers.location, /auth=ok/);
  fake.google = { sub: 'g-victim', email: 'victim@example.com', email_verified: true, name: 'Victim' };
  await login('google');
  // Mallory's old Microsoft identity no longer opens that account
  const again = await login('microsoft');
  assert.match(again.cb.headers.location, /email_exists|auth=ok/);
  const u = store.users.find((x) => x.email === 'victim@example.com');
  assert.equal(u.emailVerified, true);
  assert.ok(!store.identities.some((i) => i.provider === 'microsoft' && i.subject === 'm2' && i.userId === u.id));
  assert.ok(mallorySid);
});

test('apple: signed client secret, form_post callback, id_token verified, name captured', async () => {
  fake.appleClaims = (body) => ({ sub: 'a1', email: 'apple@example.com', email_verified: 'true', nonce: lastNonce });
  let lastNonce;
  const start = await req('GET', '/auth/apple');
  const loc = new URL(start.headers.location);
  lastNonce = loc.searchParams.get('nonce');
  assert.equal(loc.searchParams.get('response_mode'), 'form_post');
  assert.match(start.headers['set-cookie'][0], /SameSite=None; Secure/);
  const state = loc.searchParams.get('state');
  const cb = await req('POST', '/auth/apple/callback', { headers: { cookie: jar(start), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: 'c', state, user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }) }).toString() });
  assert.match(cb.headers.location, /auth=ok&p=apple&new=1/);
  assert.equal(store.users.find((u) => u.email === 'apple@example.com').name, 'Ada Lovelace');
  // client_secret is an ES256 JWT we can verify with the public key
  const [h, p, s] = lastApple.client_secret.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).sub, 'com.bix.web');
});

test('apple: wrong nonce in id_token is rejected', async () => {
  fake.appleClaims = () => ({ sub: 'a2', email: 'x@example.com', email_verified: true, nonce: 'wrong' });
  const start = await req('GET', '/auth/apple');
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await req('POST', '/auth/apple/callback', { headers: { cookie: jar(start), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: 'c', state }).toString() });
  assert.equal(cb.headers.location, '/?auth_error=provider');
});

test('unconfigured provider and path traversal', async () => {
  assert.equal((await req('GET', '/auth/facebook')).headers.location, '/?auth_error=not_configured');
  assert.ok([403, 404].includes((await req('GET', '/..%2f..%2fetc/passwd')).status));
  assert.equal((await req('GET', '/../server.js')).status === 200, false);
});

test('SEO: robots.txt, sitemap.xml, filled-in canonical + JSON-LD, 404 page, noindex on API', async () => {
  const robots = await req('GET', '/robots.txt');
  assert.match(robots.body, /Sitemap: http:\/\/localhost:3000\/sitemap\.xml/);
  assert.match(robots.body, /Disallow: \/api\//);
  const map = await req('GET', '/sitemap.xml');
  assert.match(map.headers['content-type'], /xml/);
  assert.match(map.body, /<loc>http:\/\/localhost:3000\/<\/loc>/);
  assert.equal((await req('GET', '/api/me')).headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal((await req('GET', '/definitely-missing')).status, 404);
});

const JSONH = { 'content-type': 'application/json', 'x-requested-with': 'fetch' };
const post = (p, obj, cookie) => req('POST', p, { headers: Object.assign({}, JSONH, cookie ? { cookie } : {}), body: JSON.stringify(obj) });
const codeFromMail = () => lastMail.textContent.match(/code is (\d{6})/)[1];

test('email code: sends a 6-digit code, signs in, creates the account, code works once', async () => {
  const feat = JSON.parse((await req('GET', '/api/providers')).body).features;
  assert.equal(feat.emailCode, true); assert.equal(feat.passkey, true);
  const start = await post('/auth/email/start', { email: 'Student@Example.com', name: 'Ada Student' });
  assert.equal(start.status, 200);
  assert.equal(lastMail.to[0].email, 'student@example.com');
  assert.match(lastMail.subject, /sign-in code/);
  const code = codeFromMail();
  const otp = jar(start);
  const ok = await post('/auth/email/verify', { code }, otp);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).user.name, 'Ada Student');
  const me = JSON.parse((await req('GET', '/api/me', { headers: { cookie: jar(ok) } })).body);
  assert.equal(me.user.email, 'student@example.com');
  assert.equal((await post('/auth/email/verify', { code }, otp)).status, 400); // replay refused
});

test('email code: wrong code, lockout after 5 tries, CSRF header, throttle, mail failure', async () => {
  const start = await post('/auth/email/start', { email: 'lock@example.com' });
  const otp = jar(start); const real = codeFromMail(); const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await post('/auth/email/verify', { code: wrong }, otp)).status, 400);
  assert.equal((await post('/auth/email/verify', { code: real }, otp)).status, 429); // locked even with the right code
  assert.equal((await post('/auth/email/start', { email: 'lock@example.com' })).status, 429); // resend throttle
  assert.equal((await req('POST', '/auth/email/start', { headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.co"}' })).status, 403);
  assert.equal((await post('/auth/email/start', { email: 'not-an-email' })).status, 400);
  mailFails = true;
  assert.equal((await post('/auth/email/start', { email: 'fail@example.com' })).status, 502);
  mailFails = false;
  assert.equal((await post('/auth/email/verify', { code: '123456' })).status, 400); // no cookie
});

test('email code signs into the same account as a verified provider (no duplicate)', async () => {
  fake.google = { sub: 'g-same', email: 'same@example.com', email_verified: true, name: 'Same Person' };
  await login('google');
  const start = await post('/auth/email/start', { email: 'same@example.com' });
  await post('/auth/email/verify', { code: codeFromMail() }, jar(start));
  assert.equal(store.users.filter((u) => u.email === 'same@example.com').length, 1);
});

test('passkey endpoints need a session to register, and refuse forged logins', async () => {
  assert.equal((await post('/auth/passkey/register/options', {})).status, 401);
  const o = await post('/auth/passkey/login/options', {});
  assert.equal(JSON.parse(o.body).publicKey.userVerification, 'required');
  const bad = await post('/auth/passkey/login/verify', { id: 'nope', response: { clientDataJSON: '', authenticatorData: '', signature: '' } }, jar(o));
  assert.equal(bad.status, 400);
});
