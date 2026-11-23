import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPhone, findDuplicatePhones } from '../src/phones.js';

test('all common Iraqi forms map to one canonical number', () => {
  for (const f of ['07701234567', '7701234567', '+964 770 123 4567', '009647701234567', '964-770-123-4567', '+9640770 1234567', '٠٧٧٠١٢٣٤٥٦٧'])
    assert.equal(canonicalPhone(f), '9647701234567', f);
  assert.equal(canonicalPhone(''), ''); assert.equal(canonicalPhone('123'), '');
});

test('duplicates against existing merchants and within one batch', () => {
  const existing = [{ id: 'c1', phone: '07701234567', name: 'متجر أ', rep: 'u9' }];
  const ops = [
    { c: 'clients', id: 'n1', data: { id: 'n1', phone: '+964 770 123 4567' } }, // dup of c1
    { c: 'clients', id: 'n2', data: { id: 'n2', phone: '07801111111' } },
    { c: 'clients', id: 'n3', data: { id: 'n3', phone: '7801111111' } },        // dup of n2 (same batch)
    { c: 'clients', id: 'c1', data: { id: 'c1', phone: '0770 123 4567', name: 'متجر أ' } }, // same merchant, formatting only
    { c: 'clients', id: 'n4', data: { id: 'n4', phone: '' } },
  ];
  const r = findDuplicatePhones(ops, existing, new Map([['c1', existing[0]]]));
  assert.deepEqual([...r.keys()].sort(), ['n1', 'n3']);
  assert.equal(r.get('n1').name, 'متجر أ');
});

test('changing a phone to one used by someone else is caught', () => {
  const existing = [{ id: 'c1', phone: '07701234567' }, { id: 'c2', phone: '07809999999' }];
  const r = findDuplicatePhones([{ c: 'clients', id: 'c2', data: { id: 'c2', phone: '07701234567' } }], existing, new Map([['c2', existing[1]]]));
  assert.equal(r.get('c2').id, 'c1');
});
