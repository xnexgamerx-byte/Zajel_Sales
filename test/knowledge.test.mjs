import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKnWrite } from '../src/knowledge.js';

const K = (o) => ({ read: true, manage: false, approve: false, admin: false, ...o });
const draft = { id: 'kd1', document_id: 'kdoc', text: 'نص', status: 'pending', approved_at: '' };

test('manager can do everything', () => {
  assert.equal(checkKnWrite(K({ admin: true }), { k: 'documents', id: 'kdoc', del: true }), null);
});
test('read-only users cannot change the library', () => {
  assert.match(checkKnWrite(K(), { k: 'documents', id: 'kdoc', data: { id: 'kdoc' } }), /تشغيل مكتبة المعرفة/);
});
test('operators upload and edit, but cannot delete books or approve', () => {
  const op = K({ manage: true });
  assert.equal(checkKnWrite(op, { k: 'documents', id: 'kdoc', data: { id: 'kdoc' } }), null);
  assert.equal(checkKnWrite(op, { k: 'drafts', id: 'kd1', data: { ...draft, text: 'معدل' } }, draft), null);
  assert.match(checkKnWrite(op, { k: 'documents', id: 'kdoc', del: true }, { id: 'kdoc' }), /للمدير/);
  assert.match(checkKnWrite(op, { k: 'drafts', id: 'kd1', data: { ...draft, status: 'approved', approved_at: 'x' } }, draft), /اعتماد/);
  assert.match(checkKnWrite(op, { k: 'drafts', id: 'kd2', data: { ...draft, id: 'kd2', status: 'approved' } }, undefined), /اعتماد/, 'cannot create pre-approved');
});
test('approvers approve or reject, but cannot rewrite the text', () => {
  const ap = K({ approve: true });
  assert.equal(checkKnWrite(ap, { k: 'drafts', id: 'kd1', data: { ...draft, status: 'approved', approved_at: 'x', updated_at: 'y' } }, draft), null);
  assert.equal(checkKnWrite(ap, { k: 'drafts', id: 'kd1', data: { ...draft, status: 'rejected' } }, draft), null);
  assert.match(checkKnWrite(ap, { k: 'drafts', id: 'kd1', data: { ...draft, status: 'approved', text: 'نص آخر' } }, draft), /تعديل نص/);
  assert.match(checkKnWrite(ap, { k: 'ideas', id: 'ki', data: { id: 'ki' } }), /تشغيل/);
});
test('unknown kinds are refused', () => {
  assert.match(checkKnWrite(K({ admin: true }), { k: 'pages', id: 'x', data: { id: 'x' } }), /غير معروف/);
});
