'use strict';
// Run with:  node --test      (tests the internship-application upload + admin review APIs)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.PORT = '0'; process.env.RATE_LIMIT = '1000';
process.env.BREVO_API_KEY = 'brevo-key'; process.env.MAIL_FROM = 'noreply@bixtech.test';
process.env.BASE_URL = 'http://localhost:3000'; process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.DATA_DIR = path.join(os.tmpdir(), 'bix-apps-test-' + process.pid);
process.env.ADMIN_PASSWORD = 'correct-horse-battery'; process.env.MAX_UPLOAD_MB = '1'; // 1 MB cap so the "too big" test stays quick

let lastMail = null; const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => { // fake the e-mail provider; never touch the network
  if (String(url) === 'https://api.brevo.com/v3/smtp/email') { lastMail = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => '{}' }; }
  return realFetch(url, opts);
};
const { server, store } = require('../server.js');
let port;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { const raw = Buffer.concat(c); resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString('utf8') }); });
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const cookieOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');
const F = { 'x-requested-with': 'fetch' };
const J = { ...F, 'content-type': 'application/json' };

async function studentLogin(email, name) { // real e-mail-code flow, code read from the fake mail
  const st = await req('POST', '/auth/email/start', { headers: J, body: JSON.stringify({ email, name }) });
  assert.equal(st.status, 200);
  const code = lastMail.textContent.match(/\d{6}/)[0];
  const v = await req('POST', '/auth/email/verify', { headers: { ...J, cookie: cookieOf(st) }, body: JSON.stringify({ code }) });
  assert.equal(v.status, 200);
  return cookieOf(v);
}
async function adminLogin(password = process.env.ADMIN_PASSWORD, email = 'bixtech3@gmail.com') {
  const r = await req('POST', '/api/admin/login', { headers: J, body: JSON.stringify({ email, password }) });
  return { r, cookie: cookieOf(r) };
}
// tiny valid-looking files: the server checks the first bytes
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF');
const up = (cookie, buf, name = 'form.jpg', type = 'image/jpeg') => req('POST', '/api/applications', { headers: { ...F, cookie, 'content-type': type, 'x-file-name': encodeURIComponent(name), 'content-length': buf.length }, body: buf });

let ada, bob, adm;
test('upload needs a student sign-in and the CSRF header', async () => {
  assert.equal((await up('', JPG)).status, 401);
  ada = await studentLogin('ada@school.test', 'Ada Lovelace');
  const noHeader = await req('POST', '/api/applications', { headers: { cookie: ada, 'content-type': 'image/jpeg' }, body: JPG });
  assert.equal(noHeader.status, 403);
  assert.equal((await req('GET', '/api/applications/mine')).status, 401);
});

test('upload jpg: stored with name, email, date and status pending', async () => {
  const r = await up(ada, JPG, 'My Form.JPG');
  assert.equal(r.status, 201);
  const a = JSON.parse(r.body).application;
  assert.equal(a.status, 'pending'); assert.equal(a.email, 'ada@school.test'); assert.equal(a.name, 'Ada Lovelace');
  assert.equal(a.mime, 'image/jpeg'); assert.equal(a.fileName, 'My Form.jpg'); assert.ok(Date.parse(a.submittedAt));
  const mine = JSON.parse((await req('GET', '/api/applications/mine', { headers: { cookie: ada } })).body);
  assert.equal(mine.application.id, a.id);
  const f = await req('GET', '/api/applications/mine/file', { headers: { cookie: ada } });
  assert.equal(f.status, 200); assert.deepEqual(f.raw, JPG); assert.equal(f.headers['content-type'], 'image/jpeg');
});

test('the browser-declared type is ignored: bytes decide; bad types are refused', async () => {
  bob = await studentLogin('bob@school.test', 'Bob Marley');
  assert.equal((await up(bob, Buffer.from('<script>alert(1)</script>'), 'x.jpg', 'image/jpeg')).status, 415); // HTML pretending to be a JPG
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(20)]);
  const h = await up(bob, heic, 'x.heic', 'image/heic');
  assert.equal(h.status, 415); assert.equal(JSON.parse(h.body).error, 'heic_unsupported');
  assert.equal((await up(bob, Buffer.alloc(0))).status, 400);
  assert.equal((await up(bob, Buffer.alloc(1.5 * 1048576, 0xff))).status, 413); // over the 1 MB test cap
  assert.equal((await up(bob, PNG, '../../etc/passwd.png', 'application/octet-stream')).status, 201);
  const mine = JSON.parse((await req('GET', '/api/applications/mine', { headers: { cookie: bob } })).body).application;
  assert.equal(mine.mime, 'image/png'); assert.doesNotMatch(mine.fileName, /[\/\\]/); // path tricks removed
});

test('admin API is locked until the server-side admin login', async () => {
  assert.equal((await req('GET', '/api/admin/applications')).status, 401);
  assert.equal((await req('GET', '/api/admin/applications', { headers: { cookie: ada } })).status, 401); // a student cookie is not an admin cookie
  const bad = await adminLogin('wrong-password'); assert.equal(bad.r.status, 401);
  const badMail = await adminLogin(undefined, 'someone@else.test'); assert.equal(badMail.r.status, 401);
  assert.equal((await req('POST', '/api/admin/login', { headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403); // no CSRF header
  adm = await adminLogin(); assert.equal(adm.r.status, 200);
  assert.match(adm.r.headers['set-cookie'][0], /HttpOnly/); assert.match(adm.r.headers['set-cookie'][0], /SameSite=Strict/);
  assert.equal(JSON.parse((await req('GET', '/api/admin/session', { headers: { cookie: adm.cookie } })).body).admin, true);
});

test('admin lists, filters, views and downloads the original', async () => {
  const l = JSON.parse((await req('GET', '/api/admin/applications', { headers: { cookie: adm.cookie } })).body);
  assert.equal(l.counts.all, 2); assert.equal(l.counts.pending, 2); assert.equal(l.applications.length, 2);
  const q = JSON.parse((await req('GET', '/api/admin/applications?q=ada', { headers: { cookie: adm.cookie } })).body);
  assert.equal(q.applications.length, 1);
  const id = q.applications[0].id;
  const view = await req('GET', `/api/admin/applications/${id}/file`, { headers: { cookie: adm.cookie } });
  assert.match(view.headers['content-disposition'], /^inline/); assert.deepEqual(view.raw, JPG);
  assert.equal(view.headers['x-content-type-options'], 'nosniff');
  const dl = await req('GET', `/api/admin/applications/${id}/file?download=1`, { headers: { cookie: adm.cookie } });
  assert.match(dl.headers['content-disposition'], /^attachment/); assert.deepEqual(dl.raw, JPG);
  assert.equal((await req('GET', '/api/admin/applications/nope1234', { headers: { cookie: adm.cookie } })).status, 404);
  assert.equal((await req('GET', '/api/admin/applications/..%2f..%2fetc/file', { headers: { cookie: adm.cookie } })).status, 404);
});

test('reject needs a comment; student then sees Rejected + comment and can re-upload (PDF)', async () => {
  const id = store.applications.find((a) => a.email === 'ada@school.test').id;
  const url = `/api/admin/applications/${id}/review`;
  assert.equal((await req('POST', url, { headers: { ...J, cookie: adm.cookie }, body: JSON.stringify({ decision: 'rejected' }) })).status, 400);
  assert.equal((await req('POST', url, { headers: { ...J, cookie: adm.cookie }, body: JSON.stringify({ decision: 'maybe' }) })).status, 400);
  assert.equal((await req('POST', url, { headers: { cookie: adm.cookie }, body: '{}' })).status, 403);
  const rej = await req('POST', url, { headers: { ...J, cookie: adm.cookie }, body: JSON.stringify({ decision: 'rejected', comment: 'The school stamp is not visible.' }) });
  assert.equal(rej.status, 200);
  let mine = JSON.parse((await req('GET', '/api/applications/mine', { headers: { cookie: ada } })).body).application;
  assert.equal(mine.status, 'rejected'); assert.equal(mine.comment, 'The school stamp is not visible.');
  const again = await up(ada, PDF, 'scan.pdf', 'application/pdf');
  assert.equal(again.status, 201);
  mine = JSON.parse(again.body).application;
  assert.equal(mine.status, 'pending'); assert.equal(mine.attempts, 2); assert.equal(mine.history[0].comment, 'The school stamp is not visible.');
  assert.equal(store.applications.filter((a) => a.email === 'ada@school.test').length, 1); // replaced, not duplicated
  assert.equal(fs.readdirSync(path.join(process.env.DATA_DIR, 'uploads')).length, 2); // old file was deleted (ada's pdf + bob's png)
});

test('approve locks the form; admin logout ends the admin session', async () => {
  const id = store.applications.find((a) => a.email === 'ada@school.test').id;
  const ok = await req('POST', `/api/admin/applications/${id}/review`, { headers: { ...J, cookie: adm.cookie }, body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(JSON.parse(ok.body).application.status, 'approved');
  const r = await up(ada, JPG); assert.equal(r.status, 409);
  const pdf = await req('GET', `/api/admin/applications/${id}/file`, { headers: { cookie: adm.cookie } });
  assert.equal(pdf.headers['content-type'], 'application/pdf'); assert.match(pdf.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal((await req('POST', '/api/admin/logout', { headers: { ...F, cookie: adm.cookie } })).status, 200);
  assert.equal((await req('GET', '/api/admin/applications', { headers: { cookie: adm.cookie } })).status, 401);
});

test('a record whose file vanished answers 410, not a crash', async () => {
  const a = store.applications.find((x) => x.email === 'bob@school.test');
  fs.unlinkSync(path.join(process.env.DATA_DIR, 'uploads', a.fileId));
  const again = await adminLogin();
  assert.equal((await req('GET', `/api/admin/applications/${a.id}/file`, { headers: { cookie: again.cookie } })).status, 410);
});

/* ---------------- normal sign up / sign in with a password ---------------- */
const reg = (o) => req('POST', '/auth/register', { headers: J, body: JSON.stringify(o) });
test('sign up creates the account, signs in, and the form can be uploaded straight away', async () => {
  const bad = await reg({ name: 'Z', email: 'z@school.test', password: 'longenough1' }); assert.equal(bad.status, 400);
  assert.equal((await reg({ name: 'Zed Zed', email: 'zed@school.test', password: 'short' })).status, 400); // under 8 characters
  const r = await reg({ name: 'Zed Zed', email: 'Zed@School.test', password: 'a-good-password', course: 'Web Development', field: 'Machine Learning', duration: '4 weeks' });
  assert.equal(r.status, 200); const c = cookieOf(r); assert.ok(c);
  assert.equal((await reg({ name: 'Zed Again', email: 'zed@school.test', password: 'another-pass-1' })).status, 409); // same e-mail
  const u = await up(c, JPG, 'zed.jpg'); assert.equal(u.status, 201);
  const l = await adminLogin(); const list = JSON.parse((await req('GET', '/api/admin/applications?q=zed', { headers: { cookie: l.cookie } })).body).applications;
  assert.equal(list.length, 1); assert.equal(list[0].course, 'Web Development'); assert.equal(list[0].duration, '4 weeks');
  const stored = store.users.find((x) => x.email === 'zed@school.test');
  assert.ok(stored.pw && !JSON.stringify(stored).includes('a-good-password')); // only a salted scrypt hash is stored
});
test('sign in: right password works, wrong one and unknown e-mail look the same, tries are limited', async () => {
  const login = (email, password) => req('POST', '/auth/login', { headers: J, body: JSON.stringify({ email, password }) });
  const ok = await login('zed@school.test', 'a-good-password'); assert.equal(ok.status, 200); assert.ok(cookieOf(ok));
  assert.equal(JSON.parse((await req('GET', '/api/me', { headers: { cookie: cookieOf(ok) } })).body).user.email, 'zed@school.test');
  const w = await login('zed@school.test', 'wrong-password'), n = await login('nobody@school.test', 'wrong-password');
  assert.equal(w.status, 401); assert.equal(n.status, 401); assert.equal(w.body, n.body);
  assert.equal((await login('ada@school.test', 'whatever-pass')).status, 401); // e-mail-code account has no password
  let last; for (let i = 0; i < 9; i++) last = await login('zed@school.test', 'nope-' + i); assert.equal(last.status, 429);
});
test('a password typed at sign-up cannot be used to take over an address later proven by e-mail code', async () => {
  assert.equal((await reg({ name: 'Squatter', email: 'victim@school.test', password: 'squatter-pass-1' })).status, 200);
  await studentLogin('victim@school.test', 'Real Victim'); // the real owner proves the address with a code
  const r = await req('POST', '/auth/login', { headers: J, body: JSON.stringify({ email: 'victim@school.test', password: 'squatter-pass-1' }) });
  assert.equal(r.status, 401);
});
test('/api/me?soft=1 answers 200 with user:null when signed out (no red console error)', async () => {
  const r = await req('GET', '/api/me?soft=1'); assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).user, null);
  assert.equal((await req('GET', '/api/me')).status, 401);
});
