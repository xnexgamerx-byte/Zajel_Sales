// Acceptance check from PROJECT_BRIEF: every one of the 24 screens opens with no JavaScript errors.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort());
  await p.goto(BASE); await p.fill('#loginUser', 'manager'); await p.fill('#loginPass', process.env.ADMIN_PASSWORD || 'Admin12345!');
  await p.click('button[type=submit]'); await p.waitForFunction(() => !!session);
  const views = await p.evaluate(() => navItems.map((n) => n.id || n[0] || n.view));
  let bad = 0;
  for (const v of views) {
    const before = errs.length;
    await p.evaluate((x) => go(x), v); await p.waitForTimeout(150);
    const len = await p.evaluate(() => document.body.innerText.length);
    const ok = errs.length === before && len > 200;
    if (!ok) bad++;
    console.log(ok ? 'ok  ' : 'FAIL', v);
  }
  console.log(`${views.length} screens, ${bad} failing, ${errs.length} page errors`, errs.slice(0, 3));
  await b.close(); process.exit(bad || errs.length || views.length !== 24 ? 1 : 0);
})();
