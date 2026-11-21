// Server-side permission policy. Mirrors the UI's ZJU_VIEWS / ZJU_ACTIONS (set per employee by the
// manager in "الفريق والصلاحيات"), but enforced on the server so the browser can't bypass it.
// Pure functions only — unit-tested in test/permissions.test.mjs.

/** Build the permission context for a user. `rep` is the user's record in the `reps` collection. */
export function permsFor(user, rep) {
  const admin = user.role === 'manager' || user.role === 'integration';
  const views = new Set(admin ? [] : rep?.permissions?.views || []);
  const actions = new Set(admin ? [] : rep?.permissions?.actions || []);
  return {
    id: user.id,
    admin,
    view: (v) => admin || views.has(v),
    can: (a) => admin || actions.has(a),
    any: (...a) => admin || a.some((x) => actions.has(x)),
    get viewAll() { return admin || actions.has('viewAll'); },
  };
}

// ── Read ────────────────────────────────────────────────────────────────────────────────────
// Collections that need a specific screen (view) to be readable at all.
const COLL_VIEW = {
  audit: 'audit',
  marketing__campaigns: 'marketing', marketing__tasks: 'marketing', marketing__content: 'marketing', marketing__tests: 'marketing',
  social__campaigns: 'social',
  smart__quotes: 'quotes',
  smart__enrichments: 'enrich',
};
// Collections whose rows belong to a merchant (client) and are scoped to the employee's own merchants.
const CLIENT_SCOPED = new Set(['activities', 'tasks', 'escalations', 'smart__quotes', 'smart__enrichments']);

export const canReadColl = (p, coll) => !COLL_VIEW[coll] || p.view(COLL_VIEW[coll]);

/**
 * Whether a single record is visible to the user.
 * `ownClients` is the Set of client ids assigned to the user (only needed when !p.viewAll).
 */
export function canSeeRecord(p, coll, data, ownClients) {
  if (!canReadColl(p, coll)) return false;
  if (p.viewAll || !data) return true;
  if (coll === 'clients') return data.rep === p.id;
  if (CLIENT_SCOPED.has(coll)) return data.rep === p.id || data.createdById === p.id || (data.client != null && ownClients.has(data.client)) || (data.client == null && data.rep == null);
  return true;
}
export const needsClientScope = (p) => !p.viewAll;

// ── Write ───────────────────────────────────────────────────────────────────────────────────
const CLIENT_UPDATE = ['editClient', 'changeStage', 'assign', 'contact', 'followups', 'whatsapp', 'reengage', 'addClient', 'socialEdit', 'quotesEdit'];
const ACTIVITY_WRITE = ['contact', 'changeStage', 'followups', 'whatsapp', 'reengage', 'addClient', 'socialEdit'];
const TASK_WRITE = ['followups', 'contact', 'changeStage', 'assign', 'addClient'];
const SKIP = 'skip'; // silently ignore (not an error the user needs to see)

const changed = (a, b, k) => JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null);
const becameApproved = (old, data) => (data?.status === 'approved' && old?.status !== 'approved') || changed(old, data, 'approvedAt') || changed(old, data, 'approvedBy');

/**
 * Check one write op. Returns null when allowed, 'skip' to drop it silently, or an Arabic reason string.
 * @param op   {c, id, data?, del?}
 * @param old  current server value of the record (undefined if new)
 * @param ownsClient (clientId) => boolean — whether the merchant is assigned to this user
 */
export function checkWrite(p, op, old, ownsClient) {
  if (p.admin) return null;
  const { c, data, del } = op;
  const mine = (rec) => p.viewAll || rec?.rep === p.id;
  const clientOk = (rec) => p.viewAll || rec?.client == null || ownsClient(rec.client) || rec?.rep === p.id;

  switch (c) {
    case 'reps':
      return 'إدارة الفريق للمدير فقط';
    case 'audit':
      return old || del ? SKIP : null; // append-only
    case 'clients': {
      if (del) return p.can('editClient') && mine(old) ? null : 'حذف التاجر غير مسموح لحسابك';
      if (!old) {
        if (!p.any('addClient', 'socialEdit')) return 'إضافة تاجر غير مسموحة لحسابك';
        const toOther = data.rep && data.rep !== p.id;
        if (toOther && !p.can('assign') && !(p.can('socialEdit') && data.socialLead)) return 'إسناد التاجر لموظف آخر يحتاج صلاحية الإسناد';
        return null;
      }
      if (!mine(old)) return 'هذا التاجر غير مسند لك';
      if (!p.any(...CLIENT_UPDATE)) return 'تعديل التاجر غير مسموح لحسابك';
      if (changed(old, data, 'stage') && !p.can('changeStage')) return 'تغيير المرحلة غير مسموح لحسابك';
      if (changed(old, data, 'rep') && !p.can('assign')) return 'إسناد التاجر يحتاج صلاحية الإسناد';
      return null;
    }
    case 'activities':
      if (del) return 'حذف سجل التواصل غير مسموح';
      if (!p.any(...ACTIVITY_WRITE)) return 'تسجيل التواصل غير مسموح لحسابك';
      return clientOk(data) && (!old || clientOk(old)) ? null : 'هذا التاجر غير مسند لك';
    case 'tasks':
      if (!p.any(...TASK_WRITE)) return 'إدارة المتابعات غير مسموحة لحسابك';
      return clientOk(del ? old : data) && (!old || clientOk(old)) ? null : 'هذه المتابعة لتاجر غير مسند لك';
    case 'escalations':
      if (old || del) return p.can('assign') ? null : 'معالجة التصعيد للمدير أو المشرف';
      return p.any('contact', 'changeStage') && clientOk(data) ? null : 'طلب التصعيد غير مسموح لحسابك';
    case 'templates':
      return p.can('templatesEdit') ? null : 'تحرير القوالب غير مسموح لحسابك';
    case 'materials':
      return p.can('libraryEdit') ? null : 'إدارة المكتبة غير مسموحة لحسابك';
    case 'marketing__campaigns': case 'marketing__tasks': case 'marketing__content': case 'marketing__tests':
      return p.can('marketingEdit') ? null : 'تعديل التسويق غير مسموح لحسابك';
    case 'social__templates':
      return p.any('socialEdit', 'templatesEdit') ? null : 'تعديل قوالب السوشيال غير مسموح لحسابك';
    case 'social__campaigns':
      if (!p.can('socialEdit')) return 'إدارة حملات السوشيال غير مسموحة لحسابك';
      if (!del && becameApproved(old, data) && !p.can('campaignApprove')) return 'اعتماد الحملات غير مسموح لحسابك';
      return null;
    case 'smart__quotes':
      if (!p.any('quotesEdit', 'quotesApprove')) return 'عروض الأسعار غير مسموحة لحسابك';
      if (!del && becameApproved(old, data) && !p.can('quotesApprove')) return 'اعتماد عروض الأسعار غير مسموح لحسابك';
      if (!p.can('quotesEdit') && !(old && !del)) return 'إنشاء أو حذف العروض غير مسموح لحسابك';
      return clientOk(del ? old : data) ? null : 'هذا التاجر غير مسند لك';
    case 'smart__enrichments':
      return p.any('editClient', 'contact') ? null : 'غير مسموح لحسابك';
    default:
      return 'نوع بيانات غير معروف — للمدير فقط';
  }
}

const KV_RULE = {
  version: () => true,
  marketing: (p) => p.can('marketingEdit'),
  social: (p) => p.can('socialEdit'),
  smart: (p) => p.any('quotesEdit', 'quotesApprove', 'assign', 'contact', 'editClient'),
  rejectionTemplates: (p) => p.any('reengageEdit', 'templatesEdit'),
  tradeMarketingTemplates: (p) => p.any('reengageEdit', 'templatesEdit'),
  stageMessages: (p) => p.any('templatesEdit', 'settingsEdit'),
  salesPlaybook: (p) => p.any('coachEdit', 'templatesEdit'),
  uiVocabulary: (p) => p.can('settingsEdit'),
};
export const checkKv = (p, key) => (p.admin || (KV_RULE[key] ? KV_RULE[key](p) : p.can('settingsEdit')) ? null : 'تعديل هذه الإعدادات غير مسموح لحسابك');
