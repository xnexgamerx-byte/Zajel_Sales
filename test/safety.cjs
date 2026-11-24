// 1) Nothing may be written before the server data has been loaded (the page starts with built-in demo data).
// 2) "مسح جميع بيانات الشركة" really clears operational data and keeps the team, templates and settings.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'Admin12345!';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async () => { const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort()); await p.goto(BASE); await p.waitForSelector('#loginUser'); return p; };
  const P = await mk();
  // Simulate the race: authenticated, boot not finished, page still holds the demo defaults, then a save/flush/pagehide happens.
  const baseline = await P.evaluate(async (pw) => { await fetch('/api/login', { method: 'POST', body: JSON.stringify({ username: 'manager', password: pw }) }); const s = await (await fetch('/api/state')).json(); const c = s.collections; return { ids: (c.clients || []).map((x) => x.id), reps: (c.reps || []).map((x) => x.id), seq: s.seq }; }, ADMIN);
  const before = await P.evaluate(async (pw) => {
    await ZSync.login('manager', pw);               // user is set, but boot() has NOT run
    save(); await ZSync.flush(); await ZSync.pull();
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 800));
    const s = await (await fetch('/api/state')).json();
    return { clients: (s.collections.clients || []).map((x) => x.id), reps: (s.collections.reps || []).map((x) => x.id), seq: s.seq };
  }, ADMIN);
  assert.deepEqual(before.clients, baseline.ids, 'merchants changed before boot: ' + JSON.stringify({ baseline, before }));
  assert.deepEqual(before.reps, baseline.reps, 'team changed before boot');
  assert.ok(!before.clients.includes('c1') && !before.reps.includes('rep1'), 'demo data reached the server');
  console.log('ok: no writes before the server data is loaded');

  await P.evaluate(() => ZSync.boot()); await P.evaluate(() => { session = { id: 'manager', name: 'مدير', role: 'manager' }; });
  assert.ok(await P.evaluate(() => DB.templates.length) > 0); console.log('ok: server data loaded after boot');

  // add data + a team member, then clear
  await P.evaluate(async () => {
    const id = uid(); await ZSync.saveUser({ id, username: 'keepme', name: 'يبقى', password: 'Passw0rd!x' });
    DB.reps.push({ id, name: 'يبقى', username: 'keepme', role: 'sales', active: true, preset: 'sales', permissions: zjuClonePreset('sales') });
    DB.clients.unshift({ id: 'c-x', name: 'تاجر مؤقت', stage: 'جديد', phone: '07709990001', rep: id });
    DB.tasks.unshift({ id: 't-x', client: 'c-x', title: 'مهمة', rep: id, done: false });
    DB.materials.unshift({ id: 'm-x', title: 'مادة', type: 'نص', content: 'x' });
    save(); await ZSync.flush();
  });
  const repsBefore = await P.evaluate(async () => ((await (await fetch('/api/state')).json()).collections.reps || []).length);
  const cleared = await P.evaluate(async () => {
    window.confirm = () => true; resetData(); await ZSync.flush();
    const s = await (await fetch('/api/state')).json(); const c = s.collections;
    return { clients: (c.clients || []).length, tasks: (c.tasks || []).length, materials: (c.materials || []).length, reps: (c.reps || []).length, templates: (c.templates || []).length };
  });
  assert.deepEqual([cleared.clients, cleared.tasks, cleared.materials], [0, 0, 0], JSON.stringify(cleared));
  assert.equal(cleared.reps, repsBefore, 'team kept'); assert.ok(cleared.templates > 0, 'templates kept');
  console.log('ok: clear removes merchants/tasks/materials and keeps team + templates', JSON.stringify(cleared));
  const login2 = await (await mk()); await login2.fill('#loginUser', 'keepme'); await login2.fill('#loginPass', 'Passw0rd!x'); await login2.click('button[type=submit]');
  await login2.waitForFunction(() => typeof session !== 'undefined' && !!session, null, { timeout: 15000 }); console.log('ok: employees can still log in after the clear');
  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs) : 'no page errors');
  await b.close(); if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
