// Phone canonicalisation + duplicate detection for merchants (server-side, sees every merchant).
// The UI compares phones differently in different screens; this catches all common Iraqi forms:
//   07701234567 · 7701234567 · +964 770 123 4567 · 009647701234567 · 964-770-123-4567  ->  9647701234567
export function canonicalPhone(raw) {
  let d = String(raw ?? '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('9640')) d = '964' + d.slice(4);
  if (/^07\d{9}$/.test(d)) d = '964' + d.slice(1);
  else if (/^7\d{9}$/.test(d)) d = '964' + d;
  return d.length >= 9 ? d : '';
}

/**
 * Find merchant ops whose phone is already used by another merchant (or by an earlier op in the same batch).
 * @param ops       accepted client ops ({c:'clients', id, data})
 * @param existing  [{id, phone, name, rep}] all live merchants on the server
 * @param oldById   Map id -> current server record (to skip unchanged phones)
 * @returns Map opId -> the conflicting merchant {id, name, rep}
 */
export function findDuplicatePhones(ops, existing, oldById) {
  const byPhone = new Map();
  for (const c of existing) { const p = canonicalPhone(c.phone); if (p) byPhone.set(p, byPhone.get(p) || c); }
  const conflicts = new Map();
  for (const o of ops) {
    if (o.c !== 'clients' || o.del) continue;
    const p = canonicalPhone(o.data.phone);
    if (!p) continue;
    const old = oldById.get(o.id);
    if (old && canonicalPhone(old.phone) === p) { byPhone.set(p, byPhone.get(p) || { id: o.id }); continue; } // phone unchanged
    const hit = byPhone.get(p);
    if (hit && hit.id !== o.id) { conflicts.set(o.id, hit); continue; }
    byPhone.set(p, { id: o.id, name: o.data.name, rep: o.data.rep });
  }
  return conflicts;
}
