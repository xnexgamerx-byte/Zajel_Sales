// API-level checks (no browser): login throttling, session invalidation, backups, security headers.
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_PASSWORD || 'Admin12345!';
const ok = (m) => console.log('ok:', m);

class Client {
  constructor() { this.cookie = ''; }
  async req(path, { method = 'GET', body, raw } = {}) {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) { const m = /zs=([^;]*)/.exec(sc); if (m) this.cookie = m[1] ? 'zs=' + m[1] : ''; }
    if (raw) return r;
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }
  login(u, p) { return this.req('/api/login', { method: 'POST', body: { username: u, password: p } }); }
}
const tag = Date.now().toString(36).slice(-5);

// --- security headers on the page
{
  const r = await fetch(BASE + '/');
  assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('strict-transport-security') || '', /max-age/); ok('security headers are set on the page');
}

// --- brute-force throttling (throwaway username so the real accounts are never locked)
{
  const c = new Client(); const u = 'nobody' + tag; const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await c.login(u, 'wrong-password-' + i)).status);
  assert.deepEqual(codes.slice(0, 8), Array(8).fill(401), JSON.stringify(codes));
  assert.deepEqual(codes.slice(8), [429, 429], JSON.stringify(codes));
  const m = new Client(); assert.equal((await m.login('manager', ADMIN)).status, 200); ok('8 failures then 429; a different username/account is unaffected');
}

// --- accounts for the session tests
const M = new Client(); assert.equal((await M.login('manager', ADMIN)).status, 200);
const id = 'u' + tag, user = 'sec' + tag;
assert.equal((await M.req('/api/users', { method: 'POST', body: { id, username: user, name: 'اختبار أمان', password: 'First-Passw0rd!' } })).status, 200);
const rep = { id, name: 'اختبار أمان', username: user, role: 'sales', active: true, preset: 'sales', permissions: { views: ['dashboard', 'clients'], actions: ['addClient'] } };
assert.equal((await M.req('/api/sync', { method: 'POST', body: { ops: [{ c: 'reps', id, data: rep }] } })).status, 200);

// --- changing my password signs out my other devices, not this one
{
  const A = new Client(), B = new Client();
  assert.equal((await A.login(user, 'First-Passw0rd!')).status, 200); assert.equal((await B.login(user, 'First-Passw0rd!')).status, 200);
  assert.equal((await B.req('/api/state')).status, 200);
  assert.equal((await A.req('/api/password', { method: 'POST', body: { current: 'First-Passw0rd!', next: 'Second-Passw0rd!' } })).status, 200);
  assert.equal((await A.req('/api/state')).status, 200, 'the device that changed it stays signed in');
  assert.equal((await B.req('/api/state')).status, 401, 'the other device is signed out'); ok('password change signs out other devices only');
}
// --- manager resetting an employee's password signs them out everywhere
{
  const A = new Client(); assert.equal((await A.login(user, 'Second-Passw0rd!')).status, 200); assert.equal((await A.req('/api/state')).status, 200);
  assert.equal((await M.req('/api/users', { method: 'POST', body: { id, username: user, name: 'اختبار أمان', password: 'Third-Passw0rd!' } })).status, 200);
  assert.equal((await A.req('/api/state')).status, 401); assert.equal((await new Client().login(user, 'Third-Passw0rd!')).status, 200); ok('manager password reset signs the employee out');
}

// --- backups
{
  const E = new Client(); assert.equal((await E.login(user, 'Third-Passw0rd!')).status, 200);
  assert.equal((await E.req('/api/backup')).status, 403); assert.equal((await E.req('/api/backups')).status, 403); assert.equal((await E.req('/api/backups/run', { method: 'POST' })).status, 403); ok('employees cannot read or trigger backups');
  const b = await M.req('/api/backup'); assert.equal(b.status, 200);
  assert.ok(b.body.collections && b.body.users && b.body.kv); assert.ok(!JSON.stringify(b.body).includes('pass_hash') && !JSON.stringify(b.body).includes('pass_salt'));
  assert.ok(b.body.users.some((x) => x.username === user)); ok('manager can download a backup (no password hashes inside)');
  const run = await M.req('/api/backups/run', { method: 'POST' }); assert.equal(run.status, 200); assert.match(run.body.key, /^backups\/\d{4}-\d\d-\d\d\.json$/);
  const sched = await fetch(BASE + '/__scheduled'); assert.equal(sched.status, 200, 'scheduled handler runs'); await new Promise((r) => setTimeout(r, 1000));
  const list = await M.req('/api/backups'); assert.ok(list.body.backups.some((x) => x.key === run.body.key && x.size > 100)); ok('daily backup (scheduled + manual) is stored in R2: ' + run.body.key);
}
console.log('security checks passed');
