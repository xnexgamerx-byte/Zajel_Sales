// End-to-end against a running server (fresh database): real browsers for the manager and two employees.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'Admin12345!';
const block = (p) => p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort());

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async () => { const c = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); await block(p); await p.goto(BASE); return p; };
  const login = async (p, u, pw) => { await p.fill('#loginUser', u); await p.fill('#loginPass', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !!session, null, { timeout: 15000 }); };
  const sync = (p) => p.evaluate(() => ZSync.flush());
  const pull = (p) => p.evaluate(() => ZSync.pull());
  const ids = (p) => p.evaluate(() => DB.clients.map((c) => c.id).sort());
  const ok = (m) => console.log('ok:', m);

  // ── manager ──
  const M = await mk();
  await M.fill('#loginUser', 'manager'); await M.fill('#loginPass', 'wrong'); await M.click('button[type=submit]');
  await M.waitForSelector('#zju-login-error:not([hidden])'); ok('wrong password rejected');
  await login(M, 'manager', ADMIN); ok('manager login');
  assert.equal(await M.evaluate(() => DB.clients.length), 0, 'no demo clients');
  assert.ok(await M.evaluate(() => DB.templates.length) > 0, 'built-in templates seeded');

  const addRep = (username, name) => M.evaluate(async ([username, name]) => {
    const id = uid(); await ZSync.saveUser({ id, username, name, password: 'Passw0rd!x' });
    DB.reps.push({ id, name, username, role: 'sales', active: true, preset: 'sales', permissions: zjuClonePreset('sales') }); save(); await ZSync.flush(); return id;
  }, [username, name]);
  const sara = await addRep('sara', 'سارة'), ali = await addRep('ali', 'علي');
  await M.evaluate(([sara, ali]) => {
    DB.clients.unshift({ id: 'c-sara', name: 'تاجر سارة', stage: 'جديد', rep: sara, created: today() });
    DB.clients.unshift({ id: 'c-ali', name: 'تاجر علي', stage: 'جديد', rep: ali, created: today() });
    DB.tasks.unshift({ id: 't-ali', client: 'c-ali', title: 'متابعة علي', date: today(), rep: ali, done: false });
    save();
  }, [sara, ali]);
  await sync(M);

  // ── employees in separate browsers ──
  const S = await mk(); await login(S, 'sara', 'Passw0rd!x'); ok('employee login (separate browser)');
  const A = await mk(); await login(A, 'ali', 'Passw0rd!x');
  assert.deepEqual(await ids(S), ['c-sara']); assert.deepEqual(await ids(A), ['c-ali']);
  assert.equal(await S.evaluate(() => DB.tasks.some((t) => t.id === 't-ali')), false);
  ok("each employee receives only their own merchants and follow-ups");
  assert.equal(await S.evaluate(() => DB.audit.length === 0 || DB.audit.every((a) => a.who === 'سارة')), true);

  // own edits sync to the manager
  await S.evaluate(() => { DB.clients[0].phone = '0771111111'; save(); }); await sync(S); await pull(M);
  assert.equal(await M.evaluate(() => DB.clients.find((c) => c.id === 'c-sara').phone), '0771111111'); ok('employee edit reaches manager');

  // concurrent edits on different merchants survive
  await S.evaluate((sara) => { DB.clients.unshift({ id: 'c-sara2', name: 'جديد من سارة', stage: 'جديد', rep: sara }); save(); }, sara);
  await M.evaluate(() => { DB.clients.find((c) => c.id === 'c-ali').city = 'البصرة'; save(); });
  await sync(S); await sync(M); await pull(M); await pull(S);
  assert.ok((await ids(M)).includes('c-sara2')); assert.equal(await M.evaluate(() => DB.clients.find((c) => c.id === 'c-ali').city), 'البصرة');
  ok('concurrent edits both preserved');

  // reassignment: manager moves c-sara2 to ali -> disappears for sara, appears for ali
  await M.evaluate((ali) => { DB.clients.find((c) => c.id === 'c-sara2').rep = ali; save(); }, ali); await sync(M);
  await pull(S); await pull(A);
  assert.deepEqual(await ids(S), ['c-sara']); assert.deepEqual(await ids(A), ['c-ali', 'c-sara2']); ok('reassigned merchant moves between employees');

  // ── bypass attempts are refused and restored ──
  await S.evaluate((ali) => { DB.clients[0].rep = ali; save(); }, ali); await sync(S);
  assert.equal(await S.evaluate((sara) => DB.clients[0].rep === sara, sara), true);
  await pull(M); assert.equal(await M.evaluate((sara) => DB.clients.find((c) => c.id === 'c-sara').rep === sara, sara), true);
  ok('reassign without permission refused and restored');

  await S.evaluate(() => { DB.uiVocabulary = { hacked: true }; save(); }); await sync(S);
  assert.equal(await S.evaluate(() => !DB.uiVocabulary.hacked), true); ok('settings edit without permission refused and restored');

  const raw = (p, body) => p.evaluate(async (body) => { const r = await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; }, body);
  let [st, res] = await raw(S, { ops: [{ c: 'reps', id: sara, data: { id: sara, active: true, permissions: { views: [], actions: ['viewAll'] } } }], kv: {} });
  assert.equal(st, 200); assert.equal(res.rejected.length, 1);
  await pull(M); assert.equal(await M.evaluate((sara) => DB.reps.find((r) => r.id === sara).permissions.actions.includes('viewAll'), sara), false);
  ok('employee cannot grant themselves permissions');
  [st, res] = await raw(S, { ops: [{ c: 'clients', id: 'c-ali', data: { id: 'c-ali', name: 'x', rep: sara } }], kv: {} });
  assert.equal(res.rejected.length, 1); ok("employee cannot overwrite another employee's merchant via the API");
  [st, res] = await raw(S, { ops: [{ c: 'audit', id: 'forged', data: { id: 'forged', who: 'x' } }, { c: 'audit', id: 'forged', del: true }], kv: {} });
  await pull(M); assert.equal(await M.evaluate(() => DB.audit.some((a) => a.id === 'forged')), true); ok('audit log cannot be deleted by employees');
  assert.equal(await S.evaluate(async () => (await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'z', username: 'zzz', name: 'zz', password: 'longenough1' }) })).status), 403);
  ok('employee cannot create accounts');

  // grant viewAll -> sara now receives every merchant
  await M.evaluate((sara) => { DB.reps.find((r) => r.id === sara).permissions.actions.push('viewAll'); save(); }, sara); await sync(M);
  await S.reload(); await S.waitForFunction(() => !!session, null, { timeout: 15000 });
  assert.deepEqual(await ids(S), ['c-ali', 'c-sara', 'c-sara2']); ok('session survives refresh; granting viewAll takes effect');

  // files
  const fid = await S.evaluate(async () => ZSync.uploadFile(new File(['hello زاجل'], 'ملاحظة.txt', { type: 'text/plain' })));
  assert.deepEqual(await M.evaluate(async (id) => { const f = await ZSync.fetchFile(id); return [await f.blob.text(), f.name]; }, fid), ['hello زاجل', 'ملاحظة.txt']);
  ok('file upload/download shared');

  // disable -> locked out immediately
  await M.evaluate((sara) => { DB.reps.find((r) => r.id === sara).active = false; save(); }, sara); await sync(M);
  assert.equal(await S.evaluate(async () => (await fetch('/api/state')).status), 401); ok('disabled account loses access immediately');

  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs) : 'no page errors');
  await b.close();
  if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
