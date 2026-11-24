// Change-my-own-password through the real dialog.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'Admin12345!';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async () => { const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort()); await p.goto(BASE); return p; };
  const login = async (p, u, pw) => { await p.fill('#loginUser', u); await p.fill('#loginPass', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !!session, null, { timeout: 15000 }); };
  const tag = Date.now().toString(36).slice(-5), user = 'pw' + tag;
  const M = await mk(); await login(M, 'manager', ADMIN);
  await M.evaluate(async (u) => { const id = uid(); await ZSync.saveUser({ id, username: u, name: 'اختبار كلمة السر', password: 'Old-Passw0rd!' }); DB.reps.push({ id, name: 'اختبار كلمة السر', username: u, role: 'sales', active: true, preset: 'sales', permissions: zjuClonePreset('sales') }); save(); await ZSync.flush(); }, user);

  const E = await mk(); await login(E, user, 'Old-Passw0rd!');
  const fill = async (cur, nxt, again) => { await E.fill('[name=current]', cur); await E.fill('[name=next]', nxt); await E.fill('[name=again]', again); await E.click('.modal button[type=submit]'); };
  await E.click('.profile-mini'); await E.waitForSelector('.modal [name=current]'); console.log('ok: account chip opens the dialog');
  await fill('Old-Passw0rd!', 'New-Passw0rd!1', 'different-1234'); await E.waitForSelector('#pwd-msg:not([hidden])');
  assert.match(await E.textContent('#pwd-msg'), /غير متطابقتين/); console.log('ok: mismatch refused');
  await fill('wrong-current-1', 'New-Passw0rd!1', 'New-Passw0rd!1'); await E.waitForFunction(() => /غير صحيحة/.test(document.getElementById('pwd-msg').textContent));
  console.log('ok: wrong current password refused by the server');
  await fill('Old-Passw0rd!', 'New-Passw0rd!1', 'New-Passw0rd!1'); await E.waitForSelector('.modal', { state: 'detached' }); console.log('ok: password changed');

  const O = await mk(); await O.fill('#loginUser', user); await O.fill('#loginPass', 'Old-Passw0rd!'); await O.click('button[type=submit]');
  await O.waitForSelector('#zju-login-error:not([hidden])'); console.log('ok: old password no longer works');
  await login(await mk(), user, 'New-Passw0rd!1'); console.log('ok: new password works');
  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs) : 'no page errors');
  await b.close(); if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
