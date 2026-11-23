'use strict';
// Run with:  node --test      (attendance marking + download reports)
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

process.env.PORT = '0'; process.env.RATE_LIMIT = '1000';
process.env.BASE_URL = 'http://localhost:3000'; process.env.SESSION_SECRET = 'y'.repeat(40);
process.env.DATA_DIR = path.join(os.tmpdir(), 'bix-att-test-' + process.pid);
process.env.ADMIN_PASSWORD = 'correct-horse-battery';
const { server, store } = require('../server.js');
let port;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
const J = { 'x-requested-with': 'fetch', 'content-type': 'application/json' };
const cookieOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');
const post = (p, o, cookie = '') => req('POST', p, { headers: { ...J, cookie }, body: JSON.stringify(o) });
let adm, ids = {};

test('attendance is admin-only', async () => {
  assert.equal((await req('GET', '/api/admin/attendance?date=2026-11-19')).status, 401);
  assert.equal((await post('/api/admin/attendance', { date: '2026-11-19', marks: [] })).status, 401);
  const l = await post('/api/admin/login', { email: 'bixtech3@gmail.com', password: process.env.ADMIN_PASSWORD });
  assert.equal(l.status, 200); adm = cookieOf(l);
});

test('registration keeps the course, field and the specific course (including typed "Other" values)', async () => {
  const a = await post('/auth/register', { name: 'Ada Lovelace', email: 'ada@x.test', password: 'password123', course: 'Web Development', field: 'Frontend Design', specific: 'React', duration: '8 weeks' });
  const b = await post('/auth/register', { name: 'Bob Tester', email: 'bob@x.test', password: 'password123', course: 'Robotics', field: 'Embedded Systems', specific: 'Arduino', duration: '4 weeks' });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const day = JSON.parse((await req('GET', '/api/admin/attendance?date=2026-11-19', { headers: { cookie: adm } })).body);
  assert.equal(day.students.length, 2);
  const bob = day.students.find((s) => s.email === 'bob@x.test');
  assert.deepEqual([bob.course, bob.field, bob.specific], ['Robotics', 'Embedded Systems', 'Arduino']);
  day.students.forEach((s) => { ids[s.email] = s.id; assert.equal(s.status, null); });
});

test('mark, change and clear attendance; bad input is rejected', async () => {
  const d = '2026-11-18', ok = (marks, date = d) => post('/api/admin/attendance', { date, marks }, adm);
  assert.equal((await ok([{ userId: ids['ada@x.test'], status: 'present' }, { userId: ids['bob@x.test'], status: 'absent' }])).status, 200);
  assert.equal((await ok([{ userId: ids['bob@x.test'], status: 'present' }], '2026-11-17')).status, 200);
  assert.equal((await ok([{ userId: 'nobody', status: 'present' }])).status, 400);
  assert.equal((await ok([{ userId: ids['ada@x.test'], status: 'late' }])).status, 400);
  assert.equal((await ok([], '2026-13-45')).status, 400);
  assert.equal((await ok([], '2099-01-01')).status, 400);
  assert.equal((await post('/api/admin/attendance', { date: d, marks: [] }, adm).then(() => req('POST', '/api/admin/attendance', { headers: { cookie: adm }, body: '{}' }))).status, 403); // CSRF header required
  const got = JSON.parse((await req('GET', '/api/admin/attendance?date=' + d, { headers: { cookie: adm } })).body);
  assert.equal(got.students.find((s) => s.email === 'bob@x.test').status, 'absent');
  await ok([{ userId: ids['bob@x.test'], status: 'present' }]); // change his mind
  await ok([{ userId: ids['ada@x.test'], status: '' }]);        // clear one mark
  const again = JSON.parse((await req('GET', '/api/admin/attendance?date=' + d, { headers: { cookie: adm } })).body);
  assert.equal(again.students.find((s) => s.email === 'bob@x.test').status, 'present');
  assert.equal(again.students.find((s) => s.email === 'ada@x.test').status, null);
});

test('totals and CSV downloads count present / absent correctly', async () => {
  const d2 = '2026-11-19';
  await post('/api/admin/attendance', { date: d2, marks: [{ userId: ids['ada@x.test'], status: 'present' }, { userId: ids['bob@x.test'], status: 'absent' }] }, adm);
  // days: 11-17 bob present | 11-18 bob present | 11-19 ada present, bob absent
  const rep = JSON.parse((await req('GET', '/api/admin/attendance/report', { headers: { cookie: adm } })).body);
  const ada = rep.students.find((s) => s.email === 'ada@x.test'), bob = rep.students.find((s) => s.email === 'bob@x.test');
  assert.deepEqual([ada.present, ada.absent, ada.marked, ada.percent], [1, 0, 1, 100]);
  assert.deepEqual([bob.present, bob.absent, bob.marked, bob.percent], [2, 1, 3, 66.7]);
  const ranged = JSON.parse((await req('GET', '/api/admin/attendance/report?from=2026-11-19&to=2026-11-19', { headers: { cookie: adm } })).body);
  assert.equal(ranged.students.find((s) => s.email === 'bob@x.test').present, 0);
  const csv = await req('GET', '/api/admin/attendance/report.csv', { headers: { cookie: adm } });
  assert.match(csv.headers['content-type'], /text\/csv/); assert.match(csv.headers['content-disposition'], /attachment/);
  assert.match(csv.body, /"Days present","Days absent","Days marked","Attendance %"/);
  assert.match(csv.body, /"Bob Tester","bob@x.test","Robotics","Embedded Systems","Arduino","2","1","3","66.7"/);
  const daily = await req('GET', '/api/admin/attendance/report.csv?type=daily', { headers: { cookie: adm } });
  assert.equal(daily.body.trim().split('\r\n').length, 1 + 4); // header + 4 marks
  assert.equal((await req('GET', '/api/admin/attendance/report.csv')).status, 401);
});

test('spreadsheet formulas in names cannot run in the CSV', async () => {
  await post('/auth/register', { name: '=HYPERLINK("x")', email: 'evil@x.test', password: 'password123' });
  const csv = await req('GET', '/api/admin/attendance/report.csv', { headers: { cookie: adm } });
  assert.ok(csv.body.includes('"\'=HYPERLINK(""x"")"'));
});
