// Zajel Sales — Cloudflare Worker: auth + shared data sync + files + integration API.
// Data model mirrors the front-end's single `DB` object:
//   array keys  -> `records` rows (one row per item, keyed by item.id)
//   other keys  -> `kv` rows (whole value, last write wins)
// Every write batch gets a monotonically increasing `seq`; clients pull changes since their last seq.

import { permsFor, canReadColl, canSeeRecord, checkWrite, checkKv } from './permissions.js';
import { findDuplicatePhones } from './phones.js';
import { handleKnowledge } from './knowledge.js';

const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const fail = (status, error) => json({ error }, status);

// ---------- crypto ----------
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  // Workers cap PBKDF2 at 100k iterations.
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: 100000 }, key, 256));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s) => b64u(enc.encode(s));
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function signToken(env, payload) {
  const body = b64uStr(JSON.stringify(payload));
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}
async function verifyToken(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  if (!timingSafeEqual(sig, await hmac(env.SESSION_SECRET, body))) return null;
  try {
    const p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
const randHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

// ---------- helpers ----------
const SESSION_TTL = 60 * 60 * 24 * 14;
const COLL_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;
const MAX_BATCH = 500;

function cookie(name, value, maxAge, req) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
const getCookie = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

// Returns {id, role, name} or null. role: 'manager' | 'sales' | 'integration'
async function authenticate(req, env) {
  const auth = req.headers.get('authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers.get('x-api-key');
  if (key && env.INTEGRATION_API_KEY && timingSafeEqual(key, env.INTEGRATION_API_KEY)) {
    return { id: 'integration', role: 'integration', name: 'Integration' };
  }
  const p = await verifyToken(env, getCookie(req, 'zs'));
  if (!p) return null;
  const u = await env.DB.prepare('SELECT id, username, name, role FROM users WHERE id = ?').bind(p.uid).first();
  if (!u) return null;
  if (u.role !== 'manager') {
    const row = await env.DB.prepare("SELECT data, deleted FROM records WHERE coll = 'reps' AND id = ?").bind(u.id).first();
    const rep = row && !row.deleted ? JSON.parse(row.data || '{}') : null;
    // An employee without a team record (or disabled) has no access.
    if (!rep || rep.active === false) return null;
    u.rep = rep;
  }
  return u;
}
const publicUser = (u) => ({ id: u.id, name: u.name, role: u.role, username: u.username });

/** Ids of merchants assigned to the user — used to scope rows for employees without "viewAll". */
async function ownClientIds(env, p) {
  if (p.viewAll) return null;
  const r = await env.DB.prepare("SELECT id FROM records WHERE coll = 'clients' AND deleted = 0 AND json_extract(data, '$.rep') = ?").bind(p.id).all();
  return new Set(r.results.map((x) => x.id));
}
const isAdmin = (u) => u.role === 'manager' || u.role === 'integration';

async function nextSeq(env) {
  const r = await env.DB.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k = 'seq' RETURNING v").first();
  return Number(r.v);
}
const currentSeq = async (env) => Number((await env.DB.prepare("SELECT v FROM meta WHERE k = 'seq'").first()).v);

// ---------- handlers ----------
async function ensureAdmin(env) {
  const exists = await env.DB.prepare("SELECT 1 AS x FROM users WHERE role = 'manager' LIMIT 1").first();
  if (exists || !env.ADMIN_PASSWORD) return;
  const salt = randHex(16);
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, username, name, role, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('manager', 'manager', 'مدير المبيعات', 'manager', await pbkdf2(env.ADMIN_PASSWORD, salt), salt, new Date().toISOString()).run();
}

async function login(req, env) {
  const body = await readJson(req);
  const username = String(body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!username || !password) return fail(400, 'أدخل اسم المستخدم وكلمة المرور');
  await ensureAdmin(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  // Always run a hash so response time doesn't reveal whether the user exists.
  const hash = await pbkdf2(password, u ? u.pass_salt : '00'.repeat(16));
  if (!u || !timingSafeEqual(hash, u.pass_hash)) return fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  if (u.role !== 'manager') {
    const rep = await env.DB.prepare("SELECT data, deleted FROM records WHERE coll = 'reps' AND id = ?").bind(u.id).first();
    if (!rep || rep.deleted || JSON.parse(rep.data || '{}').active === false) return fail(403, 'الحساب معطّل أو غير مرتبط بالفريق. تواصل مع المدير');
  }
  const token = await signToken(env, { uid: u.id, exp: Math.floor(Date.now() / 1000) + SESSION_TTL });
  return json({ user: { id: u.id, name: u.name, role: u.role, username: u.username } }, 200, { 'set-cookie': cookie('zs', token, SESSION_TTL, req) });
}

async function getState(env, p) {
  const [recs, kvs, seq, seeded] = await Promise.all([
    env.DB.prepare('SELECT coll, id, data FROM records WHERE deleted = 0').all(),
    env.DB.prepare('SELECT k, v FROM kv').all(),
    currentSeq(env),
    env.DB.prepare("SELECT v FROM meta WHERE k = 'seeded'").first(),
  ]);
  const own = await ownClientIds(env, p);
  const collections = {};
  for (const r of recs.results) {
    if (!canReadColl(p, r.coll)) continue;
    const d = JSON.parse(r.data);
    if (canSeeRecord(p, r.coll, d, own)) (collections[r.coll] ||= []).push(d);
  }
  const kv = {};
  for (const r of kvs.results) kv[r.k] = JSON.parse(r.v);
  return { seq, seeded: !!seeded, collections, kv };
}

async function getChanges(env, p, since) {
  const [recs, kvs, seq] = await Promise.all([
    env.DB.prepare('SELECT coll, id, data, deleted FROM records WHERE seq > ?').bind(since).all(),
    env.DB.prepare('SELECT k, v FROM kv WHERE seq > ?').bind(since).all(),
    currentSeq(env),
  ]);
  const own = await ownClientIds(env, p);
  const ops = [];
  for (const r of recs.results) {
    if (!canReadColl(p, r.coll)) continue;
    if (r.deleted) { ops.push({ c: r.coll, id: r.id, del: true }); continue; }
    const d = JSON.parse(r.data);
    // A row that is no longer visible (e.g. merchant reassigned to someone else) is removed on the client.
    ops.push(canSeeRecord(p, r.coll, d, own) ? { c: r.coll, id: r.id, data: d } : { c: r.coll, id: r.id, del: true });
  }
  return {
    seq,
    ops,
    kv: Object.fromEntries(kvs.results.map((r) => [r.k, JSON.parse(r.v)])),
  };
}

async function loadOld(env, ops) {
  const old = new Map();
  for (let i = 0; i < ops.length; i += 100) {
    const part = ops.slice(i, i + 100);
    const res = await env.DB.batch(part.map((o) => env.DB.prepare('SELECT coll, id, data FROM records WHERE coll = ? AND id = ? AND deleted = 0').bind(o.c, o.id)));
    res.forEach((r) => { const row = r.results[0]; if (row) old.set(row.coll + '/' + row.id, JSON.parse(row.data)); });
  }
  return old;
}

async function applySync(env, user, body) {
  const ops = Array.isArray(body?.ops) ? body.ops : [];
  const kv = body?.kv && typeof body.kv === 'object' ? body.kv : {};
  if (ops.length > MAX_BATCH || Object.keys(kv).length > 100) return fail(413, 'الدفعة كبيرة جداً');
  for (const o of ops) {
    if (!o || !COLL_RE.test(o.c || '') || typeof o.id !== 'string' || !o.id || o.id.length > 128) return fail(400, 'عملية غير صالحة');
    if (!o.del && (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data))) return fail(400, 'بيانات غير صالحة');
    if (!o.del && o.data.id !== o.id) return fail(400, 'معرّف السجل لا يطابق');
  }
  for (const k of Object.keys(kv)) if (!COLL_RE.test(k)) return fail(400, 'مفتاح غير صالح');
  if (body?.seed && !isAdmin(user)) return fail(403, 'غير مسموح');

  // Per-op permission check: allowed ops are applied, the rest are reported back so the client restores them.
  const p = permsFor(user, user.rep);
  const rejected = [];
  let accepted = ops;
  const acceptedKv = {};
  if (!p.admin) {
    const old = await loadOld(env, ops);
    const own = await ownClientIds(env, p);
    // A merchant created in this same batch counts as the user's own when assigned to them.
    for (const o of ops) if (o.c === 'clients' && !o.del && o.data.rep === p.id && own) own.add(o.id);
    const owns = (id) => !own || own.has(id);
    accepted = [];
    for (const o of ops) {
      const verdict = checkWrite(p, o, old.get(o.c + '/' + o.id), owns);
      if (verdict === null) accepted.push(o);
      else if (verdict !== 'skip') rejected.push({ c: o.c, id: o.id, error: verdict });
    }
  }
  // Duplicate merchant phones — checked against every merchant, including ones this user can't see.
  const clientOps = accepted.filter((o) => o.c === 'clients' && !o.del);
  if (clientOps.length) {
    const existing = (await env.DB.prepare("SELECT id, json_extract(data, '$.phone') AS phone, json_extract(data, '$.name') AS name, json_extract(data, '$.rep') AS rep FROM records WHERE coll = 'clients' AND deleted = 0").all()).results;
    const dup = findDuplicatePhones(clientOps, existing, new Map(existing.map((r) => [r.id, r])));
    if (dup.size) {
      accepted = accepted.filter((o) => !(o.c === 'clients' && !o.del && dup.has(o.id)));
      for (const [id, hit] of dup) {
        const rep = hit.rep && hit.rep !== 'manager' ? await env.DB.prepare("SELECT json_extract(data, '$.name') AS name FROM records WHERE coll = 'reps' AND id = ? AND deleted = 0").bind(hit.rep).first() : null;
        const who = hit.rep === 'manager' ? ' لدى المدير' : rep?.name ? ` لدى ${rep.name}` : '';
        rejected.push({ c: 'clients', id, error: `رقم الهاتف مسجل مسبقاً للتاجر «${hit.name || 'بدون اسم'}»${who}. افتح ملفه أو تواصل مع المسؤول بدل التكرار` });
      }
    }
  }
  for (const [k, v] of Object.entries(kv)) {
    const err = checkKv(p, k);
    if (err) rejected.push({ k, error: err }); else acceptedKv[k] = v;
  }
  if (!accepted.length && !Object.keys(acceptedKv).length && !body?.seed) return json({ seq: await currentSeq(env), rejected });

  const seq = await nextSeq(env);
  const stmts = [];
  for (const o of accepted) {
    if (o.del) stmts.push(env.DB.prepare('INSERT INTO records (coll,id,data,deleted,seq) VALUES (?,?,NULL,1,?) ON CONFLICT(coll,id) DO UPDATE SET data=NULL, deleted=1, seq=excluded.seq').bind(o.c, o.id, seq));
    else stmts.push(env.DB.prepare('INSERT INTO records (coll,id,data,deleted,seq) VALUES (?,?,?,0,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, deleted=0, seq=excluded.seq').bind(o.c, o.id, JSON.stringify(o.data), seq));
  }
  for (const [k, v] of Object.entries(acceptedKv)) {
    stmts.push(env.DB.prepare('INSERT INTO kv (k,v,seq) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, seq=excluded.seq').bind(k, JSON.stringify(v), seq));
  }
  if (body?.seed) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded', '1')"));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return json({ seq, rejected });
}

async function saveUser(env, body) {
  const username = String(body?.username || '').trim().toLowerCase();
  const id = String(body?.id || '');
  const name = String(body?.name || '').trim();
  const password = body?.password ? String(body.password) : '';
  if (!id || id === 'manager' || id === 'integration') return fail(400, 'معرّف غير صالح');
  if (!USERNAME_RE.test(username) || username === 'manager') return fail(400, 'اسم المستخدم: 3 إلى 32 حرفاً إنجليزياً أو رقماً أو . _ -');
  if (name.length < 2) return fail(400, 'الاسم قصير');
  const existing = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  const clash = await env.DB.prepare('SELECT id FROM users WHERE username = ? AND id != ?').bind(username, id).first();
  if (clash) return fail(409, 'اسم المستخدم مستخدم من قبل');
  if (!existing && password.length < 8) return fail(400, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  if (password && password.length < 8) return fail(400, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  if (existing) {
    if (password) {
      const salt = randHex(16);
      await env.DB.prepare('UPDATE users SET username=?, name=?, pass_hash=?, pass_salt=? WHERE id=?').bind(username, name, await pbkdf2(password, salt), salt, id).run();
    } else await env.DB.prepare('UPDATE users SET username=?, name=? WHERE id=?').bind(username, name, id).run();
  } else {
    const salt = randHex(16);
    await env.DB.prepare('INSERT INTO users (id,username,name,role,pass_hash,pass_salt,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, username, name, 'sales', await pbkdf2(password, salt), salt, new Date().toISOString()).run();
  }
  return json({ ok: true });
}

async function changeOwnPassword(env, user, body) {
  const cur = String(body?.current || ''), next = String(body?.next || '');
  if (next.length < 8) return fail(400, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  if (!u || !timingSafeEqual(await pbkdf2(cur, u.pass_salt), u.pass_hash)) return fail(401, 'كلمة المرور الحالية غير صحيحة');
  const salt = randHex(16);
  await env.DB.prepare('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?').bind(await pbkdf2(next, salt), salt, user.id).run();
  return json({ ok: true });
}

// ---------- files (R2) ----------
const MAX_FILE = 100 * 1024 * 1024;
async function uploadFile(req, env, user) {
  const name = decodeURIComponent(req.headers.get('x-filename') || 'file');
  const type = req.headers.get('content-type') || 'application/octet-stream';
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_FILE) return fail(413, 'الملف كبير جداً');
  const id = randHex(16);
  await env.FILES.put(id, req.body, { httpMetadata: { contentType: type } });
  const head = await env.FILES.head(id);
  await env.DB.prepare('INSERT INTO files (id,name,type,size,owner,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, name.slice(0, 255), type, head?.size ?? len, user.id, new Date().toISOString()).run();
  return json({ id, name, type, size: head?.size ?? len });
}
async function downloadFile(env, id) {
  const meta = await env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
  const obj = meta && (await env.FILES.get(id));
  if (!obj) return fail(404, 'الملف غير موجود');
  return new Response(obj.body, {
    headers: {
      'content-type': meta.type || 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name || 'file')}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
    },
  });
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return fail(500, 'SESSION_SECRET غير مضبوط');
    const path = url.pathname.slice(4); // keep leading slash
    const method = req.method;

    try {
      if (path === '/health') return json({ ok: true });
      if (path === '/login' && method === 'POST') return await login(req, env);
      if (path === '/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('zs', '', 0, req) });

      const user = await authenticate(req, env);
      if (!user) return fail(401, 'يلزم تسجيل الدخول');

      // CSRF guard for cookie sessions: state-changing requests must be same-origin.
      if (method !== 'GET' && user.role !== 'integration') {
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin) return fail(403, 'طلب غير مسموح');
      }

      const perms = permsFor(user, user.rep);
      if (path.startsWith('/kn/')) return await handleKnowledge(req, env, perms, path.slice(3));
      if (path === '/me' && method === 'GET') return json({ user: publicUser(user) });
      if (path === '/state' && method === 'GET') return json(await getState(env, perms));
      if (path === '/changes' && method === 'GET') return json(await getChanges(env, perms, Number(url.searchParams.get('since')) || 0));
      if (path === '/sync' && method === 'POST') {
        const body = await readJson(req);
        if (!body) return fail(400, 'JSON غير صالح');
        return await applySync(env, user, body);
      }
      if (path === '/password' && method === 'POST') {
        if (user.role === 'integration') return fail(403, 'غير مسموح');
        return await changeOwnPassword(env, user, await readJson(req));
      }
      if (path === '/users' && method === 'POST') {
        if (!isAdmin(user)) return fail(403, 'للمدير فقط');
        return await saveUser(env, await readJson(req));
      }
      if (path === '/files' && method === 'POST') return await uploadFile(req, env, user);
      const fm = path.match(/^\/files\/([a-f0-9]{32})$/);
      if (fm && method === 'GET') return await downloadFile(env, fm[1]);
      if (fm && method === 'DELETE') {
        if (!isAdmin(user)) return fail(403, 'للمدير فقط');
        await env.FILES.delete(fm[1]);
        await env.DB.prepare('DELETE FROM files WHERE id = ?').bind(fm[1]).run();
        return json({ ok: true });
      }
      return fail(404, 'غير موجود');
    } catch (e) {
      console.error('API error', e && e.stack || e);
      return fail(500, 'خطأ في الخادم');
    }
  },
};
