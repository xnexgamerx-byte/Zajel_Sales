// Shared knowledge library ("مكتبة المعرفة الذكية") — server side.
// The browser module keeps all its processing (PDF.js, OCR, rules); only storage moves here.
//   records (documents/ideas/drafts/jobs/facts) -> D1 table kn_records
//   page text                                  -> R2 kn/pages/<doc>/<chunk>.json  (50 pages per chunk)
//   original PDF for OCR                       -> R2 kn/source/<doc>

const KINDS = new Set(['documents', 'ideas', 'drafts', 'jobs']);
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_CHUNK_BYTES = 25 * 1024 * 1024;

/** Knowledge permissions derived from the general permission context (see permissions.js). */
export const knPerms = (p) => ({
  read: p.view('knowledge'),
  manage: p.can('knowledgeManage'),  // upload, analyse, OCR, edit drafts
  approve: p.can('knowledgeApprove'), // approve / reject drafts
  admin: p.admin,                     // delete files, facts, restore backups
});

const reviewFields = ({ status, approved_at, updated_at, ...rest } = {}) => JSON.stringify(rest);

/** Returns null if allowed, otherwise an Arabic reason. Pure — unit tested. */
export function checkKnWrite(k, op, old) {
  if (!KINDS.has(op.k)) return 'نوع بيانات غير معروف';
  if (k.admin) return null;
  if (op.k === 'documents' && op.del) return 'حذف ملفات المكتبة للمدير فقط';
  if (op.k === 'drafts' && !op.del) {
    const st = op.data.status;
    const reviewing = (['approved', 'rejected'].includes(st) && old?.status !== st) || (!!op.data.approved_at && op.data.approved_at !== (old?.approved_at || ''));
    if (reviewing && !k.approve) return 'اعتماد أو رفض الرسائل يحتاج صلاحية «اعتماد رسائل المعرفة»';
    if (reviewing && !k.manage) return old && reviewFields(old) === reviewFields(op.data) ? null : 'صلاحية الاعتماد لا تسمح بتعديل نص الرسالة';
  }
  return k.manage ? null : 'تشغيل مكتبة المعرفة يحتاج صلاحية «تشغيل مكتبة المعرفة الذكية»';
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

async function listKeys(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const r = await bucket.list({ prefix, cursor });
    keys.push(...r.objects.map((o) => o.key));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return keys;
}

async function state(env) {
  const rows = (await env.DB.prepare('SELECT kind, id, data FROM kn_records WHERE deleted = 0').all()).results;
  const out = { documents: [], ideas: [], drafts: [], jobs: [], facts: '' };
  for (const r of rows) {
    const d = JSON.parse(r.data);
    if (r.kind === 'facts') out.facts = d.facts || '';
    else if (out[r.kind]) out[r.kind].push(d);
  }
  return out;
}

async function sync(env, k, body) {
  const ops = Array.isArray(body?.ops) ? body.ops : [];
  if (ops.length > 2000) return fail(413, 'الدفعة كبيرة جداً');
  for (const o of ops) {
    if (!o || !KINDS.has(o.k) || typeof o.id !== 'string' || !ID_RE.test(o.id)) return fail(400, 'عملية غير صالحة');
    if (!o.del && (!o.data || typeof o.data !== 'object' || Array.isArray(o.data) || o.data.id !== o.id)) return fail(400, 'بيانات غير صالحة');
  }
  const old = new Map();
  for (let i = 0; i < ops.length; i += 100) {
    const res = await env.DB.batch(ops.slice(i, i + 100).map((o) => env.DB.prepare('SELECT kind, id, data FROM kn_records WHERE kind = ? AND id = ? AND deleted = 0').bind(o.k, o.id)));
    res.forEach((r) => { const row = r.results[0]; if (row) old.set(row.kind + '/' + row.id, JSON.parse(row.data)); });
  }
  const rejected = [], stmts = [], at = new Date().toISOString();
  for (const o of ops) {
    const err = checkKnWrite(k, o, old.get(o.k + '/' + o.id));
    if (err) { rejected.push({ k: o.k, id: o.id, error: err }); continue; }
    stmts.push(o.del
      ? env.DB.prepare('INSERT INTO kn_records (kind,id,data,deleted,updated_at) VALUES (?,?,NULL,1,?) ON CONFLICT(kind,id) DO UPDATE SET data=NULL, deleted=1, updated_at=excluded.updated_at').bind(o.k, o.id, at)
      : env.DB.prepare('INSERT INTO kn_records (kind,id,data,deleted,updated_at) VALUES (?,?,?,0,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, deleted=0, updated_at=excluded.updated_at').bind(o.k, o.id, JSON.stringify(o.data), at));
  }
  if (typeof body?.facts === 'string') {
    if (!k.admin) rejected.push({ facts: true, error: 'الحقائق المعتمدة يعدّلها المدير فقط' });
    else stmts.push(env.DB.prepare("INSERT INTO kn_records (kind,id,data,deleted,updated_at) VALUES ('facts','facts',?,0,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at").bind(JSON.stringify({ facts: body.facts.slice(0, 4000) }), at));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ ok: true, rejected });
}

/** Routes under /api/kn/*. `path` starts after "/kn". */
export async function handleKnowledge(req, env, p, path) {
  const k = knPerms(p);
  if (!k.read) return fail(403, 'مكتبة المعرفة غير متاحة لحسابك');
  const m = req.method;
  if (path === '/state' && m === 'GET') return json(await state(env));
  if (path === '/sync' && m === 'POST') {
    let body; try { body = await req.json(); } catch { return fail(400, 'JSON غير صالح'); }
    return sync(env, k, body);
  }

  if ((path.startsWith('/pages/') || path.startsWith('/source/')) && !env.FILES) return fail(503, 'تخزين الملفات غير مفعّل في هذه النسخة التجريبية');

  let r = path.match(/^\/pages\/([A-Za-z0-9_-]{1,100})$/);
  if (r && m === 'GET') {
    const pages = [];
    for (const key of await listKeys(env.FILES, `kn/pages/${r[1]}/`)) { const o = await env.FILES.get(key); if (o) pages.push(...(await o.json())); }
    pages.sort((a, b) => a.page_no - b.page_no);
    return json(pages);
  }
  if (r && m === 'DELETE') {
    if (!k.admin) return fail(403, 'حذف ملفات المكتبة للمدير فقط');
    const keys = await listKeys(env.FILES, `kn/pages/${r[1]}/`);
    for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000));
    return json({ ok: true });
  }
  r = path.match(/^\/pages\/([A-Za-z0-9_-]{1,100})\/(\d{1,4})$/);
  if (r && m === 'PUT') {
    if (!k.manage && !k.admin) return fail(403, 'تشغيل مكتبة المعرفة يحتاج صلاحية «تشغيل مكتبة المعرفة الذكية»');
    const text = await req.text();
    if (text.length > MAX_CHUNK_BYTES) return fail(413, 'مقطع الصفحات كبير جداً');
    let arr; try { arr = JSON.parse(text); } catch { return fail(400, 'JSON غير صالح'); }
    if (!Array.isArray(arr) || arr.some((x) => !x || typeof x.page_no !== 'number')) return fail(400, 'صفحات غير صالحة');
    if (arr.length) await env.FILES.put(`kn/pages/${r[1]}/${r[2].padStart(4, '0')}.json`, text, { httpMetadata: { contentType: 'application/json' } });
    else await env.FILES.delete(`kn/pages/${r[1]}/${r[2].padStart(4, '0')}.json`);
    return json({ ok: true });
  }

  r = path.match(/^\/source\/([A-Za-z0-9_-]{1,100})$/);
  if (r) {
    const key = `kn/source/${r[1]}`;
    if (m === 'GET') {
      const o = await env.FILES.get(key);
      if (!o) return fail(404, 'الملف الأصلي غير محفوظ');
      return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'application/pdf', 'cache-control': 'private, max-age=3600' } });
    }
    if (m === 'PUT') {
      if (!k.manage && !k.admin) return fail(403, 'تشغيل مكتبة المعرفة يحتاج صلاحية');
      await env.FILES.put(key, req.body, { httpMetadata: { contentType: req.headers.get('content-type') || 'application/pdf' } });
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      if (!k.admin) return fail(403, 'حذف ملفات المكتبة للمدير فقط');
      await env.FILES.delete(key);
      return json({ ok: true });
    }
  }
  return fail(404, 'غير موجود');
}
