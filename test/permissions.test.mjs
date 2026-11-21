import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permsFor, canSeeRecord, checkWrite, checkKv } from '../src/permissions.js';

const SALES = { views: ['dashboard', 'clients', 'pipeline', 'tasks'], actions: ['addClient', 'editClient', 'changeStage', 'contact', 'followups', 'whatsapp', 'reengage'] };
const VIEWER = { views: ['dashboard', 'clients'], actions: [] };
const sales = permsFor({ id: 'u1', role: 'sales' }, { permissions: SALES });
const viewer = permsFor({ id: 'u2', role: 'sales' }, { permissions: VIEWER });
const manager = permsFor({ id: 'manager', role: 'manager' });
const supervisor = permsFor({ id: 'u3', role: 'sales' }, { permissions: { views: ['clients', 'quotes'], actions: ['viewAll', 'assign', 'editClient', 'quotesEdit'] } });
const owns = (set) => (id) => set.has(id);
const own = new Set(['c1']);
const mineClient = { id: 'c1', rep: 'u1', stage: 'جديد' };
const otherClient = { id: 'c9', rep: 'u9', stage: 'جديد' };

test('manager and integration can do everything', () => {
  assert.equal(checkWrite(manager, { c: 'reps', id: 'x', data: { id: 'x' } }), null);
  assert.equal(checkKv(manager, 'uiVocabulary'), null);
  assert.equal(checkWrite(permsFor({ id: 'integration', role: 'integration' }), { c: 'clients', id: 'z', del: true }, otherClient, () => false), null);
});

test('employees can never edit the team (no privilege escalation)', () => {
  assert.match(checkWrite(sales, { c: 'reps', id: 'u1', data: { id: 'u1', permissions: { actions: ['viewAll'] } } }, {}), /للمدير/);
  assert.match(checkWrite(supervisor, { c: 'reps', id: 'u3', data: { id: 'u3' } }, {}), /للمدير/);
});

test('read scoping: employee without viewAll sees only own merchants and their rows', () => {
  assert.equal(canSeeRecord(sales, 'clients', mineClient, own), true);
  assert.equal(canSeeRecord(sales, 'clients', otherClient, own), false);
  assert.equal(canSeeRecord(sales, 'tasks', { id: 't', client: 'c1' }, own), true);
  assert.equal(canSeeRecord(sales, 'tasks', { id: 't', client: 'c9', rep: 'u9' }, own), false);
  assert.equal(canSeeRecord(sales, 'activities', { id: 'a', client: 'c9', rep: 'u1' }, own), true, 'own activity stays visible');
  assert.equal(canSeeRecord(supervisor, 'clients', otherClient, null), true);
  assert.equal(canSeeRecord(sales, 'templates', { id: 'x' }, own), true);
});

test('read scoping: screens the employee cannot open are not sent', () => {
  assert.equal(canSeeRecord(sales, 'audit', { id: 'a' }, own), false);
  assert.equal(canSeeRecord(sales, 'marketing__campaigns', { id: 'm' }, own), false);
  assert.equal(canSeeRecord(supervisor, 'smart__quotes', { id: 'q', client: 'c9' }, null), true);
});

test('merchant writes follow ownership and actions', () => {
  assert.equal(checkWrite(sales, { c: 'clients', id: 'n', data: { id: 'n', rep: 'u1' } }, undefined, owns(own)), null, 'create own');
  assert.match(checkWrite(sales, { c: 'clients', id: 'n', data: { id: 'n', rep: 'u9' } }, undefined, owns(own)), /الإسناد/, 'create for someone else');
  assert.equal(checkWrite(sales, { c: 'clients', id: 'c1', data: { ...mineClient, phone: '1' } }, mineClient, owns(own)), null, 'edit own');
  assert.match(checkWrite(sales, { c: 'clients', id: 'c9', data: { ...otherClient, phone: '1' } }, otherClient, owns(own)), /غير مسند/, 'edit other');
  assert.match(checkWrite(sales, { c: 'clients', id: 'c1', data: { ...mineClient, rep: 'u9' } }, mineClient, owns(own)), /الإسناد/, 'reassign w/o assign');
  assert.equal(checkWrite(supervisor, { c: 'clients', id: 'c9', data: { ...otherClient, rep: 'u1' } }, otherClient, () => true), null, 'supervisor reassigns');
  assert.match(checkWrite(viewer, { c: 'clients', id: 'c1', data: { ...mineClient, rep: 'u2', phone: 'x' } }, { ...mineClient, rep: 'u2' }, () => true), /غير مسموح/, 'viewer is read-only');
  const noStage = permsFor({ id: 'u1', role: 'sales' }, { permissions: { views: [], actions: ['editClient'] } });
  assert.match(checkWrite(noStage, { c: 'clients', id: 'c1', data: { ...mineClient, stage: 'تعاقد' } }, mineClient, owns(own)), /المرحلة/);
});

test('social leads can be routed to other reps by marketing', () => {
  const mk = permsFor({ id: 'm1', role: 'sales' }, { permissions: { views: ['social'], actions: ['socialEdit'] } });
  assert.equal(checkWrite(mk, { c: 'clients', id: 'n', data: { id: 'n', rep: 'u9', socialLead: true } }, undefined, () => false), null);
  assert.match(checkWrite(mk, { c: 'clients', id: 'n', data: { id: 'n', rep: 'u9' } }, undefined, () => false), /الإسناد/);
});

test('audit log is append-only', () => {
  assert.equal(checkWrite(sales, { c: 'audit', id: 'a1', data: { id: 'a1' } }, undefined, owns(own)), null);
  assert.equal(checkWrite(sales, { c: 'audit', id: 'a1', data: { id: 'a1', action: 'edited' } }, { id: 'a1' }, owns(own)), 'skip');
  assert.equal(checkWrite(sales, { c: 'audit', id: 'a1', del: true }, { id: 'a1' }, owns(own)), 'skip');
});

test('approvals need the approve permission', () => {
  const editor = permsFor({ id: 'u5', role: 'sales' }, { permissions: { views: ['quotes'], actions: ['viewAll', 'quotesEdit'] } });
  const q = { id: 'q1', client: 'c1', status: 'pending' };
  assert.equal(checkWrite(editor, { c: 'smart__quotes', id: 'q1', data: { ...q, price: 5 } }, q, () => true), null);
  assert.match(checkWrite(editor, { c: 'smart__quotes', id: 'q1', data: { ...q, status: 'approved' } }, q, () => true), /اعتماد/);
  assert.match(checkWrite(editor, { c: 'smart__quotes', id: 'q2', data: { id: 'q2', status: 'approved' } }, undefined, () => true), /اعتماد/, 'cannot create pre-approved');
});

test('settings documents follow their edit permission', () => {
  assert.match(checkKv(sales, 'uiVocabulary'), /غير مسموح/);
  assert.match(checkKv(sales, 'marketing'), /غير مسموح/);
  assert.equal(checkKv(sales, 'version'), null);
  assert.match(checkKv(sales, 'somethingNew'), /غير مسموح/);
});
