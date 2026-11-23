// ── Zajel Knowledge: shared server storage (replaces IndexedDB) ─────────────────────────────
// Inserted by scripts/build.mjs inside the knowledge module, in place of openDb/load/persist and the
// PDF-source helpers. Processing (PDF.js, OCR, rules) is untouched; only storage changes.
// Page text is loaded per book on demand (books can be thousands of pages) and saved in 50-page chunks,
// so OCR on pages 109–120 uploads one small chunk, not the whole book.
const KN_KINDS = ['documents', 'ideas', 'drafts', 'jobs'], KN_CHUNK = 50;
let knSnap = { documents: new Map(), ideas: new Map(), drafts: new Map(), jobs: new Map() }, knFacts = '', knChunks = {}, knBusy = 0, knLoadedAt = 0;
async function knApi(path, opt = {}) {
  const r = await fetch('/api/kn' + path, { credentials: 'same-origin', ...opt });
  let j = null; try { j = await r.json(); } catch (_) {}
  if (!r.ok) throw Error((j && j.error) || ('تعذر الاتصال بالخادم (' + r.status + ')'));
  return j;
}
function knChunkMap(pages) {
  const m = new Map();
  for (const p of pages || []) { const c = Math.floor(((Number(p.page_no) || 1) - 1) / KN_CHUNK); if (!m.has(c)) m.set(c, []); m.get(c).push(p); }
  const out = new Map(); for (const [c, arr] of m) out.set(c, JSON.stringify(arr)); return out;
}
function knTakeSnap() { for (const k of KN_KINDS) knSnap[k] = new Map((state[k] || []).map((x) => [x.id, JSON.stringify(x)])); knFacts = state.facts || ''; }

async function load() {
  if (loaded && (knBusy > 0 || Date.now() - knLoadedAt < 15000)) return state;
  const r = await knApi('/state');
  if (!state.pages) state.pages = {};
  const fresh = new Map(r.documents.map((d) => [d.id, JSON.stringify(d)]));
  // Drop cached text of books that were removed, or changed by another employee (re-fetched on demand).
  for (const id of Object.keys(state.pages)) {
    const before = knSnap.documents.get(id);
    if (!fresh.has(id) || (before !== undefined && before !== fresh.get(id))) { delete state.pages[id]; delete knChunks[id]; }
  }
  for (const k of KN_KINDS) state[k] = r[k] || [];
  state.facts = r.facts || ''; state.version = 1;
  knTakeSnap(); loaded = true; knLoadedAt = Date.now();
  return state;
}

async function persist() {
  const ops = [];
  for (const k of KN_KINDS) {
    const prev = knSnap[k], seen = new Set();
    for (const x of state[k] || []) { if (!x || !x.id) continue; seen.add(x.id); if (prev.get(x.id) !== JSON.stringify(x)) ops.push({ k, id: x.id, data: x }); }
    for (const id of prev.keys()) if (!seen.has(id)) ops.push({ k, id, del: true });
  }
  // Page text first, so a book is never visible to others before its text exists.
  const docIds = new Set((state.documents || []).map((d) => d.id));
  for (const [id, pages] of Object.entries(state.pages || {})) {
    if (!docIds.has(id)) continue;
    const cur = knChunkMap(pages), prev = knChunks[id] || new Map();
    for (const [c, s] of cur) if (prev.get(c) !== s) await knApi('/pages/' + id + '/' + c, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: s });
    for (const c of prev.keys()) if (!cur.has(c)) await knApi('/pages/' + id + '/' + c, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '[]' });
    knChunks[id] = cur;
  }
  for (const id of knSnap.documents.keys()) if (!docIds.has(id)) { try { await knApi('/pages/' + id, { method: 'DELETE' }); } catch (_) {} delete knChunks[id]; }
  const rejected = [];
  const factsChanged = (state.facts || '') !== knFacts;
  for (let i = 0; i < Math.max(1, Math.ceil(ops.length / 1500)); i++) {
    const part = ops.slice(i * 1500, (i + 1) * 1500);
    if (!part.length && !(i === 0 && factsChanged)) continue;
    const body = { ops: part }; if (i === 0 && factsChanged) body.facts = state.facts || '';
    const r = await knApi('/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    rejected.push(...(r.rejected || []));
  }
  knTakeSnap();
  if (rejected.length) { // put refused edits back to the server's version, then report why
    const busy = knBusy; knBusy = 0; knLoadedAt = 0;
    try { await load(); } finally { knBusy = busy; }
    throw Error(rejected[0].error);
  }
}

async function savePDFSource(id, file) {
  const r = await fetch('/api/kn/source/' + id, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': file.type || 'application/pdf' }, body: file });
  if (!r.ok) { let j = null; try { j = await r.json(); } catch (_) {} throw Error((j && j.error) || 'تعذر حفظ PDF الأصلي على الخادم'); }
}
async function getPDFSource(id) {
  try { const r = await fetch('/api/kn/source/' + id, { credentials: 'same-origin' }); return r.ok ? await r.blob() : null; } catch (_) { return null; }
}
async function deletePDFSource(id) { try { await fetch('/api/kn/source/' + id, { method: 'DELETE', credentials: 'same-origin' }); } catch (_) {} }

async function knEnsurePages(id) {
  await load();
  if (!id || state.pages[id] || !state.documents.some((d) => d.id === id)) return;
  const arr = await knApi('/pages/' + encodeURIComponent(id));
  state.pages[id] = arr; knChunks[id] = knChunkMap(arr);
}
async function knEnsureAll() { await load(); for (const d of state.documents) await knEnsurePages(d.id); }
// Operations refresh stale data first, then hold the cache steady while they run (OCR can take minutes).
const knWrap = (fn) => async (...a) => { await load(); knBusy++; try { return await fn(...a); } finally { knBusy--; } };
function knReset() { state = EMPTY(); loaded = false; knChunks = {}; knLoadedAt = 0; knTakeSnap(); }
