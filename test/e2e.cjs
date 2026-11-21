// End-to-end: two separate browsers (manager + employee) must share data through the server.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8787';
const block = (p) => p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort());
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async () => { const c = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await block(p); await p.goto(BASE); return p; };
  const login = async (p, u, pw) => { await p.fill('#loginUser', u); await p.fill('#loginPass', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !!session, null, { timeout: 15000 }); };

  const A = await mk();
  assert.ok(await A.locator('#loginUser').isVisible(), 'login page shows');
  await A.fill('#loginUser', 'manager'); await A.fill('#loginPass', 'wrong'); await A.click('button[type=submit]');
  await A.waitForSelector('#zju-login-error:not([hidden])'); console.log('ok: wrong password rejected');
  await login(A, 'manager', 'Admin12345!'); console.log('ok: manager login');
  assert.equal(await A.evaluate(() => DB.clients.length), 0, 'no demo clients');
  assert.ok(await A.evaluate(() => DB.templates.length) > 0, 'built-in templates seeded');

  // create an employee through the real server endpoint + UI data path
  await A.evaluate(async () => { const id = uid(); await ZSync.saveUser({ id, username: 'sara', name: 'سارة', password: 'Passw0rd!x' }); DB.reps.push({ id, name: 'سارة', username: 'sara', role: 'sales', active: true, preset: 'sales', permissions: zjuClonePreset('sales') }); save(); });
  await A.evaluate(() => { DB.clients.unshift({ id: 'c-test-1', name: 'تاجر الاختبار', stage: 'جديد', phone: '0770000000', city: 'بغداد', rep: DB.reps[0].id, created: today() }); save(); });
  await A.evaluate(() => ZSync.flush());

  const B = await mk();
  await login(B, 'sara', 'Passw0rd!x'); console.log('ok: employee login (separate browser)');
  assert.equal(await B.evaluate(() => DB.clients.some((c) => c.id === 'c-test-1')), true, 'employee sees manager client');
  console.log('ok: employee sees the manager\'s client');

  // employee edits -> manager sees it via polling
  await B.evaluate(() => { DB.clients.find((c) => c.id === 'c-test-1').phone = '0771111111'; save(); });
  await B.evaluate(() => ZSync.flush());
  await A.evaluate(() => ZSync.pull());
  assert.equal(await A.evaluate(() => DB.clients.find((c) => c.id === 'c-test-1').phone), '0771111111');
  console.log('ok: employee edit reaches manager');

  // concurrent edits to different clients both survive
  await A.evaluate(() => { DB.clients.unshift({ id: 'c-A', name: 'من المدير', stage: 'جديد' }); save(); });
  await B.evaluate(() => { DB.clients.unshift({ id: 'c-B', name: 'من الموظفة', stage: 'جديد' }); save(); });
  await A.evaluate(() => ZSync.flush()); await B.evaluate(() => ZSync.flush());
  await A.evaluate(() => ZSync.pull()); await B.evaluate(() => ZSync.pull());
  for (const p of [A, B]) assert.deepEqual(await p.evaluate(() => ['c-A', 'c-B'].every((i) => DB.clients.some((c) => c.id === i))), true);
  console.log('ok: concurrent edits both preserved');

  // delete propagates
  await A.evaluate(() => { DB.clients = DB.clients.filter((c) => c.id !== 'c-A'); save(); }); await A.evaluate(() => ZSync.flush());
  await B.evaluate(() => ZSync.pull());
  assert.equal(await B.evaluate(() => DB.clients.some((c) => c.id === 'c-A')), false); console.log('ok: delete propagates');

  // employee cannot write reps (privilege escalation)
  const st = await B.evaluate(async () => (await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ c: 'reps', id: 'x', data: { id: 'x' } }], kv: {} }) })).status);
  assert.equal(st, 403); console.log('ok: employee cannot write reps');
  const st2 = await B.evaluate(async () => (await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'z', username: 'zzz', name: 'zz', password: 'longenough1' }) })).status);
  assert.equal(st2, 403); console.log('ok: employee cannot create users');

  // session survives refresh
  await B.reload(); await B.waitForFunction(() => !!session, null, { timeout: 15000 }); console.log('ok: session survives refresh');

  // file upload / download
  const fid = await B.evaluate(async () => ZSync.uploadFile(new File(['hello زاجل'], 'ملاحظة.txt', { type: 'text/plain' })));
  const got = await A.evaluate(async (id) => { const f = await ZSync.fetchFile(id); return [await f.blob.text(), f.name]; }, fid);
  assert.deepEqual(got, ['hello زاجل', 'ملاحظة.txt']); console.log('ok: file upload/download shared');

  // disabled employee is locked out
  await A.evaluate(() => { DB.reps.find((r) => r.username === 'sara').active = false; save(); }); await A.evaluate(() => ZSync.flush());
  assert.equal(await B.evaluate(async () => (await fetch('/api/state')).status), 401); console.log('ok: disabled account loses access immediately');

  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs) : 'no page errors');
  await b.close();
  if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
