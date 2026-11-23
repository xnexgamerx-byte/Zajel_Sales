// Shared knowledge library end-to-end: manager + operator (knowledgeManage) + sales (read-only) in separate browsers.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'Admin12345!';
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async () => { const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errs.push(e.message)); await p.route(/fonts\.(googleapis|gstatic)|cdnjs|jsdelivr/, (r) => r.abort()); await p.goto(BASE); return p; };
  const login = async (p, u, pw) => { await p.fill('#loginUser', u); await p.fill('#loginPass', pw); await p.click('button[type=submit]'); await p.waitForFunction(() => !!session, null, { timeout: 15000 }); };
  const ok = (m) => console.log('ok:', m);
  const tag = Date.now().toString(36).slice(-5);

  const M = await mk(); await login(M, 'manager', ADMIN);
  const mkUser = (u, preset) => M.evaluate(async ([u, preset]) => { const id = uid(); await ZSync.saveUser({ id, username: u, name: u, password: 'Passw0rd!x' }); DB.reps.push({ id, name: u, username: u, role: 'sales', active: true, preset, permissions: zjuClonePreset(preset) }); save(); await ZSync.flush(); return id; }, [u, preset]);
  await mkUser('op' + tag, 'marketing'); const salesId = await mkUser('sl' + tag, 'sales');

  // Manager uploads a 60-page text book (2 page chunks on the server).
  const docId = await M.evaluate(async (tag) => {
    const para = 'الثقة والشفافية مع التاجر مهمة جداً، ويجب فهم احتياج العميل والاستماع له قبل تقديم أي عرض. ';
    const text = Array.from({ length: 60 }, (_, i) => ('صفحة ' + (i + 1) + ' ' + para).repeat(110).slice(0, 10000)).join('');
    const doc = await ZajelKnowledge.addFile(new File([text], 'كتاب-' + tag + '.txt', { type: 'text/plain' }), 'rules', {});
    return doc.id;
  }, tag);
  const mSnap = await M.evaluate(() => { const s = ZajelKnowledge.snapshot(); return { docs: s.documents.length, ideas: s.ideas.length, drafts: s.drafts.length }; });
  assert.ok(mSnap.docs >= 1); ok(`manager uploaded a 60-page book (${mSnap.ideas} ideas, ${mSnap.drafts} drafts)`);
  const serverPages = await M.evaluate(async (id) => (await (await fetch('/api/kn/pages/' + id)).json()).length, docId);
  assert.equal(serverPages, 60); ok('page text stored on the server (60 pages)');

  // Operator (marketing preset: knowledgeManage) sees it on another device; text loads on demand.
  const O = await mk(); await login(O, 'op' + tag, 'Passw0rd!x');
  await O.evaluate(() => go('knowledge')); await O.waitForFunction(() => !zkLoading, null, { timeout: 15000 });
  assert.equal(await O.evaluate((id) => zkData.documents.some((d) => d.id === id), docId), true);
  assert.equal(await O.evaluate((id) => !!ZajelKnowledge.snapshot().pages[id], docId), false, 'text not downloaded until needed');
  await O.evaluate((id) => zkShowPages(id), docId); await O.waitForTimeout(300);
  assert.equal(await O.evaluate((id) => (ZajelKnowledge.snapshot().pages[id] || []).length, docId), 60);
  assert.match(await O.evaluate(() => document.body.innerText), /صفحة 1 /); ok('another employee sees the book; page preview loads its text on demand');
  await O.evaluate((id) => ZajelKnowledge.analyze(id, { startPage: 13, endPage: 20 }), docId);
  ok('operator can analyse a page range');
  const draftId = await M.evaluate(async () => { await ZajelKnowledge.load(); return null; });
  void draftId;

  // Operator cannot approve or delete; sales (read-only) cannot upload.
  const firstDraft = await O.evaluate(() => ZajelKnowledge.snapshot().drafts.find((d) => d.status !== 'approved' && !d.warning)?.id);
  if (firstDraft) {
    const err = await O.evaluate(async (id) => { try { await ZajelKnowledge.review(id, 'approved'); return 'no error'; } catch (e) { return e.message; } }, firstDraft);
    assert.match(err, /اعتماد/); assert.equal(await O.evaluate((id) => ZajelKnowledge.snapshot().drafts.find((d) => d.id === id).status, firstDraft) !== 'approved', true);
    ok('operator without approve permission cannot approve (restored)');
    await M.evaluate(() => { ZajelKnowledge.reset(); }); // force fresh load
    await M.evaluate(async (id) => { await ZajelKnowledge.load(); await ZajelKnowledge.review(id, 'approved'); }, firstDraft);
    await O.evaluate(() => ZajelKnowledge.reset()); await O.evaluate(() => ZajelKnowledge.load());
    assert.equal(await O.evaluate((id) => ZajelKnowledge.snapshot().drafts.find((d) => d.id === id).status, firstDraft), 'approved'); ok('manager approval visible to the operator');
  } else console.log('note: no reviewable drafts generated; approval path covered by unit tests');
  const delErr = await O.evaluate(async (id) => { try { await ZajelKnowledge.removeDocument(id); return 'no error'; } catch (e) { return e.message; } }, docId);
  assert.match(delErr, /للمدير/); assert.equal(await O.evaluate((id) => ZajelKnowledge.snapshot().documents.some((d) => d.id === id), docId), true);
  ok('operator cannot delete books (restored)');

  const S = await mk(); await login(S, 'sl' + tag, 'Passw0rd!x');
  await S.evaluate(() => go('knowledge')); await S.waitForFunction(() => !zkLoading, null, { timeout: 15000 });
  assert.equal(await S.evaluate((id) => zkData.documents.some((d) => d.id === id), docId), true); ok('sales employee can read the shared library');
  const upErr = await S.evaluate(async () => { try { await ZajelKnowledge.addFile(new File(['الثقة '.repeat(200)], 'x.txt', { type: 'text/plain' })); return 'no error'; } catch (e) { return e.message; } });
  assert.match(upErr, /صلاحية/); assert.equal(await S.evaluate(() => ZajelKnowledge.snapshot().documents.some((d) => d.filename === 'x.txt')), false);
  ok('read-only employee cannot upload');
  assert.equal(await S.evaluate(async (id) => (await fetch('/api/kn/source/' + id, { method: 'PUT', body: 'x' })).status, docId), 403);
  ok('read-only employee cannot replace the original PDF');

  // Original PDF storage (used by OCR on later page ranges)
  const pdfOk = await O.evaluate(async (id) => { const r = await fetch('/api/kn/source/' + id, { method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Blob(['%PDF-1.4 test']) }); const g = await fetch('/api/kn/source/' + id); return r.ok && (await g.text()) === '%PDF-1.4 test'; }, docId);
  assert.equal(pdfOk, true); ok('original PDF stored and readable from another device');

  // Manager deletes -> gone everywhere, text and source removed
  await M.evaluate(async (id) => { ZajelKnowledge.reset(); await ZajelKnowledge.removeDocument(id); }, docId);
  assert.equal(await M.evaluate(async (id) => (await (await fetch('/api/kn/pages/' + id)).json()).length, docId), 0);
  assert.equal(await M.evaluate(async (id) => (await fetch('/api/kn/source/' + id)).status, docId), 404);
  await O.evaluate(() => ZajelKnowledge.reset()); await O.evaluate(() => ZajelKnowledge.load());
  assert.equal(await O.evaluate((id) => ZajelKnowledge.snapshot().documents.some((d) => d.id === id), docId), false); ok('manager delete removes the book, its text and its PDF for everyone');

  // A user without the knowledge screen gets nothing
  await M.evaluate((id) => { const r = DB.reps.find((x) => x.id === id); r.permissions.views = r.permissions.views.filter((v) => v !== 'knowledge'); save(); }, salesId); await M.evaluate(() => ZSync.flush());
  assert.equal(await S.evaluate(async () => (await fetch('/api/kn/state')).status), 403); ok('employee without the knowledge screen cannot read it');

  console.log(errs.length ? 'PAGE ERRORS: ' + JSON.stringify(errs) : 'no page errors');
  await b.close(); if (errs.length) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message || e); process.exit(1); });
