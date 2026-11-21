// A sales employee performs everyday actions through the app's own handlers (the same code the buttons run).
// None of them may be refused by the server. Run after e2e.cjs (needs: manager account, fresh-ish DB).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'Admin12345!';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async () => { const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort()); await p.goto(BASE); return p; };
  const login = async (p, u, pw) => { await p.fill('#loginUser', u); await p.fill('#loginPass', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !!session, null, { timeout: 15000 }); };
  const M = await mk(); await login(M, 'manager', ADMIN);
  const user = 'flow' + Date.now().toString(36).slice(-5);
  const rid = await M.evaluate(async (u) => { const id = uid(); await ZSync.saveUser({ id, username: u, name: 'موظف الاختبار', password: 'Passw0rd!x' }); DB.reps.push({ id, name: 'موظف الاختبار', username: u, role: 'sales', active: true, preset: 'sales', permissions: zjuClonePreset('sales') }); save(); await ZSync.flush(); return id; }, user);

  const S = await mk(); await login(S, user, 'Passw0rd!x');
  // record every refusal the server sends back
  await S.evaluate(() => { window.__rejected = []; const f = window.fetch; window.fetch = async (...a) => { const r = await f(...a); if (String(a[0]).includes('/api/sync')) r.clone().json().then((j) => (j.rejected || []).forEach((x) => window.__rejected.push(x))).catch(() => {}); return r; }; });
  const step = async (name, fn, arg) => { await S.evaluate(fn, arg); await S.evaluate(() => ZSync.flush()); await S.waitForTimeout(100); const rej = await S.evaluate(() => window.__rejected.splice(0)); assert.deepEqual(rej, [], name + ' was refused: ' + JSON.stringify(rej)); console.log('ok:', name); };

  await step('add merchant (form)', () => { const f = document.createElement('form'); for (const [k, v] of Object.entries({ name: 'متجر الورد', phone: '07701234567', city: 'بغداد', orders: '30', category: 'ملابس', source: 'زيارة' })) { const i = document.createElement('input'); i.name = k; i.value = v; f.appendChild(i); } document.body.appendChild(f); submitClient({ preventDefault() {}, target: f, currentTarget: f }); });
  const cid = await S.evaluate(() => DB.clients.find((c) => c.name === 'متجر الورد')?.id);
  assert.ok(cid, 'merchant created'); assert.equal(await S.evaluate((id) => getClient(id).rep === session.id, cid), true);
  await step('edit merchant field', (id) => changeField(id, 'city', 'البصرة'), cid);
  await step('change objection', (id) => changeObjection(id, 'السعر غير مناسب'), cid);
  await step('change stage', (id) => changeStage(id, 'تم التواصل'), cid);
  await step('add follow-up task', (id) => { const f = document.createElement('form'); for (const [k, v] of Object.entries({ client: id, title: 'اتصال ثاني', date: today(), priority: 'عالية' })) { const i = document.createElement('input'); i.name = k; i.value = v; f.appendChild(i); } document.body.appendChild(f); submitTask({ preventDefault() {}, target: f, currentTarget: f }); }, cid);
  await step('complete task', () => toggleTask(DB.tasks[DB.tasks.length - 1].id));
  await step('log contact', (id) => { const f = document.createElement('form'); for (const [k, v] of Object.entries({ type: 'اتصال', text: 'تم الاتصال وشرح الخدمة', dealPhase: 'contacted' })) { const i = document.createElement('input'); i.name = k; i.value = v; f.appendChild(i); } document.body.appendChild(f); return submitActivity({ preventDefault() {}, target: f, currentTarget: f }, id); }, cid);
  await step('smart follow-up', (id) => createCadenceTask(id), cid);
  for (const v of await S.evaluate(() => ZJU_VIEWS.map((x) => x[0]).filter((v) => zjuView(v)))) await S.evaluate((v) => go(v), v);
  console.log('ok: opened every screen allowed for the employee');

  // manager sees all of it
  await M.evaluate(() => ZSync.pull());
  assert.equal(await M.evaluate((id) => { const c = getClient(id); return c && c.city === 'البصرة' && c.stage === 'تم التواصل'; }, cid), true);
  assert.ok(await M.evaluate((id) => DB.activities.some((a) => a.client === id), cid));
  console.log('ok: manager sees the employee\'s work');
  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs) : 'no page errors');
  await b.close(); if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
