/* Zajel sync layer — replaces browser-only storage with the shared server.
 * Injected by scripts/build.mjs. Relies on globals from the app script: DB, uid, render, modal, session, view, toast.
 *
 * How the single `DB` object maps to the server:
 *   - top-level arrays                        -> collection "<key>"            (one record per item, by item.id)
 *   - arrays of objects nested in an object   -> collection "<key>__<sub>"     (e.g. marketing__campaigns)
 *   - everything else                         -> "kv" documents (whole value, last write wins)
 * Per-item records mean two employees editing different clients/tasks never overwrite each other.
 */
window.ZSync = (() => {
  // Demo content shipped inside the original HTML. Never published to the server.
  const DEMO_COLLS = ['reps', 'clients', 'activities', 'tasks', 'audit', 'escalations', 'materials', 'smart__quotes', 'smart__enrichments', 'social__campaigns', 'marketing__campaigns', 'marketing__tasks', 'marketing__content', 'marketing__tests'];
  const SEP = '__';
  let seq = 0, snap = {}, kvSnap = {}, timer = null, flushing = false, dirtyAgain = false, poller = null, online = true, user = null;

  async function api(path, opt = {}) {
    const r = await fetch('/api' + path, { credentials: 'same-origin', ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error((j && j.error) || ('خطأ ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  // ----- DB <-> flat view -----
  const isObjArray = (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !Array.isArray(x));
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v);

  /** Returns { colls: {name: array}, kv: {key: value} } view of current DB (arrays are live references). */
  function flat() {
    const colls = {}, kv = {};
    for (const k of Object.keys(DB)) {
      const v = DB[k];
      if (typeof v === 'function') continue;
      if (Array.isArray(v) && isObjArray(v)) colls[k] = v;
      else if (plain(v)) {
        const rest = {};
        for (const [sk, sv] of Object.entries(v)) { if (Array.isArray(sv) && isObjArray(sv)) colls[k + SEP + sk] = sv; else rest[sk] = sv; }
        kv[k] = rest;
      } else kv[k] = v;
    }
    return { colls, kv };
  }
  function setColl(name, arr) {
    const i = name.indexOf(SEP);
    if (i < 0) { DB[name] = arr; return; }
    const k = name.slice(0, i), sk = name.slice(i + SEP.length);
    if (!plain(DB[k])) DB[k] = {};
    DB[k][sk] = arr;
  }
  function setKv(k, v) {
    if (plain(DB[k]) && plain(v)) { // keep nested collections that are stored separately
      const keep = {};
      for (const [sk, sv] of Object.entries(DB[k])) if (Array.isArray(sv) && isObjArray(sv) && !(sk in v)) keep[sk] = sv;
      DB[k] = { ...v, ...keep };
    } else DB[k] = v;
  }

  function takeSnapshot() {
    const { colls, kv } = flat();
    snap = {}; kvSnap = {};
    for (const [n, arr] of Object.entries(colls)) { snap[n] = new Map(); for (const it of arr) if (it.id) snap[n].set(it.id, JSON.stringify(it)); }
    for (const [k, v] of Object.entries(kv)) kvSnap[k] = JSON.stringify(v);
  }

  function diff() {
    const { colls, kv: kvAll } = flat();
    const ops = [], kv = {};
    for (const [n, arr] of Object.entries(colls)) {
      const prev = snap[n] || new Map(), seen = new Set();
      for (const it of arr) {
        if (!it.id) it.id = uid();
        seen.add(it.id);
        if (prev.get(it.id) !== JSON.stringify(it)) ops.push({ c: n, id: it.id, data: it });
      }
      for (const id of prev.keys()) if (!seen.has(id)) ops.push({ c: n, id, del: true });
    }
    for (const [n, prev] of Object.entries(snap)) if (!(n in colls)) for (const id of prev.keys()) ops.push({ c: n, id, del: true });
    for (const [k, v] of Object.entries(kvAll)) if (kvSnap[k] !== JSON.stringify(v)) kv[k] = v;
    return { ops, kv };
  }

  function markSynced(ops, kv) {
    for (const o of ops) {
      if (!snap[o.c]) snap[o.c] = new Map();
      if (o.del) snap[o.c].delete(o.id); else snap[o.c].set(o.id, JSON.stringify(o.data));
    }
    for (const k of Object.keys(kv)) kvSnap[k] = JSON.stringify(kv[k]);
  }

  function setStatus(ok) {
    if (online === ok) return;
    online = ok;
    try { toast(ok ? 'عاد الاتصال بالخادم' : 'لا يوجد اتصال بالخادم — التعديلات ستُرسل تلقائياً عند عودته'); } catch (_) {}
  }

  const post = (ops, kv, seed) => api('/sync', { method: 'POST', body: JSON.stringify({ ops, kv, ...(seed ? { seed: true } : {}) }) });

  async function flush() {
    if (!user) return;
    if (flushing) { dirtyAgain = true; return; }
    flushing = true;
    try {
      do {
        dirtyAgain = false;
        const { ops, kv } = diff();
        if (!ops.length && !Object.keys(kv).length) break;
        const chunks = Math.max(1, Math.ceil(ops.length / 400));
        for (let i = 0; i < chunks; i++) {
          const part = ops.slice(i * 400, (i + 1) * 400), pkv = i === 0 ? kv : {};
          const res = await post(part, pkv);
          markSynced(part, pkv);
          if (res && res.rejected && res.rejected.length) await restoreRejected(res.rejected);
        }
        setStatus(true);
      } while (dirtyAgain);
    } catch (e) {
      if (e.status === 401) { try { toast('انتهت الجلسة، سجّل الدخول مرة أخرى'); } catch (_) {} logoutLocal(); }
      else if (e.status === 403 || e.status === 400) { try { toast(e.message); } catch (_) {} }
      else { setStatus(false); clearTimeout(timer); timer = setTimeout(flush, 5000); }
    } finally { flushing = false; }
  }
  /** The server refused some edits (permissions): put those items back to the server's version. */
  async function restoreRejected(rejected) {
    try { toast(rejected[0].error || 'بعض التعديلات غير مسموحة لحسابك'); } catch (_) {}
    const state = await api('/state');
    const live = flat().colls;
    for (const r of rejected) {
      if (r.k) { if (r.k in state.kv) { setKv(r.k, state.kv[r.k]); kvSnap[r.k] = JSON.stringify(state.kv[r.k]); } continue; }
      const server = (state.collections[r.c] || []).find((x) => x && x.id === r.id);
      let arr = live[r.c];
      if (!arr) { arr = []; setColl(r.c, arr); live[r.c] = arr; }
      const i = arr.findIndex((x) => x && x.id === r.id);
      if (server) { if (i >= 0) arr[i] = server; else arr.unshift(server); (snap[r.c] ||= new Map()).set(r.id, JSON.stringify(server)); }
      else {
        if (i >= 0) arr.splice(i, 1); if (snap[r.c]) snap[r.c].delete(r.id);
        // A refused new merchant may be open in the side drawer; close it so the page doesn't reference a missing record.
        try { if (r.c === 'clients' && drawerId === r.id) drawerId = null; } catch (_) {}
      }
    }
    try { if (session && !modal && !typing()) render(); } catch (_) {}
  }

  function queue() { clearTimeout(timer); timer = setTimeout(flush, 350); }

  async function boot() {
    const state = await api('/state');
    if (!state.seeded && user && user.role === 'manager') {
      // First run: publish built-in templates/playbooks (not the demo clients) so every employee sees the same content.
      for (const n of Object.keys(flat().colls)) if (DEMO_COLLS.includes(n)) setColl(n, []);
      if (DB.smart) DB.smart = { ...DB.smart, dailyQuota: {}, routing: {} };
      snap = {}; kvSnap = {};
      const { ops, kv } = diff();
      await post([], kv, true);
      for (let i = 0; i < ops.length; i += 400) await post(ops.slice(i, i + 400), {});
      markSynced(ops, kv);
      seq = (await api('/state')).seq;
    } else {
      for (const n of Object.keys(flat().colls)) setColl(n, state.collections[n] || []);
      for (const [n, arr] of Object.entries(state.collections)) if (!(n in flat().colls)) setColl(n, arr);
      for (const [k, v] of Object.entries(state.kv)) setKv(k, v);
      seq = state.seq;
      takeSnapshot();
    }
    startPolling();
  }

  const typing = () => { const a = document.activeElement; return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };

  async function pull() {
    if (!user || flushing) return;
    try {
      const ch = await api('/changes?since=' + seq);
      setStatus(true);
      const { ops: localOps, kv: localKv } = diff(); // unsent local edits win over incoming ones
      const dirty = new Set(localOps.map((o) => o.c + '/' + o.id));
      let changed = false;
      const live = flat().colls;
      for (const o of ch.ops) {
        if (dirty.has(o.c + '/' + o.id)) continue;
        let arr = live[o.c];
        if (!arr) { arr = []; setColl(o.c, arr); live[o.c] = arr; }
        const i = arr.findIndex((x) => x && x.id === o.id);
        if (o.del) { if (i >= 0) { arr.splice(i, 1); changed = true; } if (snap[o.c]) snap[o.c].delete(o.id); continue; }
        const str = JSON.stringify(o.data);
        if (snap[o.c] && snap[o.c].get(o.id) === str) continue; // our own write echoed back
        if (i >= 0) arr[i] = o.data; else arr.unshift(o.data);
        (snap[o.c] ||= new Map()).set(o.id, str); changed = true;
      }
      for (const [k, v] of Object.entries(ch.kv)) {
        if (k in localKv) continue;
        const str = JSON.stringify(v); if (kvSnap[k] === str) continue;
        setKv(k, v); kvSnap[k] = str; changed = true;
      }
      seq = ch.seq;
      if (changed && session && !modal && !typing()) render();
    } catch (e) { if (e.status === 401) logoutLocal(); else setStatus(false); }
  }
  function startPolling() { clearInterval(poller); poller = setInterval(() => { if (!document.hidden) pull(); }, 8000); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  window.addEventListener('pagehide', () => {
    if (!user) return;
    const { ops, kv } = diff();
    if (ops.length || Object.keys(kv).length) { try { fetch('/api/sync', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops, kv }) }); } catch (_) {} }
  });

  function logoutLocal() { clearInterval(poller); user = null; try { session = null; view = 'dashboard'; render(); } catch (_) {} }

  return {
    queue, flush, pull,
    get user() { return user; },
    async login(username, password) { const r = await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) }); user = r.user; return user; },
    async restore() { try { const r = await api('/me'); user = r.user; await boot(); return user; } catch (_) { user = null; return null; } },
    boot,
    async logout() { clearInterval(poller); clearTimeout(timer); try { await flush(); } catch (_) {} try { await api('/logout', { method: 'POST' }); } catch (_) {} user = null; },
    changePassword: (current, next) => api('/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
    saveUser: (u) => api('/users', { method: 'POST', body: JSON.stringify(u) }),
    async uploadFile(file) {
      const r = await fetch('/api/files', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }, body: file });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'تعذر رفع الملف'); return j.id;
    },
    async fetchFile(id) {
      const r = await fetch('/api/files/' + id, { credentials: 'same-origin' }); if (!r.ok) throw new Error('الملف غير موجود');
      const m = /filename\*=UTF-8''([^;]+)/i.exec(r.headers.get('content-disposition') || '');
      return { blob: await r.blob(), name: m ? decodeURIComponent(m[1]) : 'file' };
    },
  };
})();
