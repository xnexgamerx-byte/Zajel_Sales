// Builds public/index.html from original/zajel-original.html.
// The original is never edited. Every change below is a small, explicit patch, and each patch must
// match exactly once — otherwise the build fails, so nothing is silently skipped or applied twice.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Windows checkouts may convert line endings (CRLF); patches are written for LF, so normalise on read.
const lf = (t) => t.replace(/\r\n?/g, '\n');
let html = lf(readFileSync(resolve(root, 'original/zajel-original.html'), 'utf8'));
const syncJs = lf(readFileSync(resolve(root, 'src/client/zajel-sync.js'), 'utf8'));
const knStoreJs = lf(readFileSync(resolve(root, 'src/client/kn-store.js'), 'utf8'));

const count = (s, sub) => s.split(sub).length - 1;
function patch(name, from, to) {
  const n = count(html, from);
  if (n !== 1) throw new Error(`Patch "${name}": expected exactly 1 match, found ${n}`);
  html = html.replace(from, () => to);
}
function patchRange(name, startMarker, endMarker, to) {
  if (count(html, startMarker) !== 1) throw new Error(`Patch "${name}": start marker matches ${count(html, startMarker)}`);
  const a = html.indexOf(startMarker);
  const b = html.indexOf(endMarker, a);
  if (b < 0) throw new Error(`Patch "${name}": end marker not found`);
  html = html.slice(0, a) + to + html.slice(b);
}

// ── 1. Sync layer loads before the app scripts ─────────────────────────────────────────────
{
  const i = html.indexOf('<script>');
  if (i < 0) throw new Error('no <script> found');
  html = html.slice(0, i) + `<script>\n${syncJs}\n</script>\n` + html.slice(i);
}

// ── 2. Storage: browser localStorage -> shared server ──────────────────────────────────────
patch('db-init',
  "let DB;try{DB=JSON.parse(localStorage.getItem(STORAGE)||localStorage.getItem('zajel_crm_standalone_v2'))||defaultData()}catch(e){DB=defaultData()}",
  'let DB=defaultData();');
patch('db-migrate',
  'if(migrateLegacyStages(DB)){try{localStorage.setItem(STORAGE,JSON.stringify(DB))}catch(e){}}',
  'migrateLegacyStages(DB);');
patch('save',
  "const save=()=>{try{localStorage.setItem(STORAGE,JSON.stringify(DB))}catch(e){toast('مساحة المتصفح ممتلئة؛ صدّر نسخة احتياطية')}};",
  'const save=()=>{ZSync.queue()};');

// ── 3. Real authentication (server-side) ───────────────────────────────────────────────────
patchRange('login', 'window.doLogin=async e=>{', 'window.logout=', `window.doLogin=async e=>{
 e.preventDefault();if(zjuBusy)return;
 zjuClearLoginMsg();
 const user=zjuUsername(document.getElementById('loginUser').value),pass=document.getElementById('loginPass').value;
 zjuBusy=true;
 try{
  const u=await ZSync.login(user,pass);
  await ZSync.boot();
  session=u.role==='manager'?{id:'manager',name:u.name||'مدير المبيعات',role:'manager'}:{id:u.id,name:u.name,role:'sales'};
  const r=DB.reps.find(x=>x.id===u.id);
  view=zjuView('dashboard')?'dashboard':((r&&r.permissions&&r.permissions.views)||[])[0]||'dashboard';
  render();toast('مرحباً '+session.name);
  if(zjuView('knowledge'))zkLoad();
 }catch(err){zjuLoginMsg(err.message||'تعذر تسجيل الدخول')}finally{zjuBusy=false}
};
`);
patch('logout', 'window.logout=()=>{zkKey=\'\';', "window.logout=()=>{ZSync.logout();zkKey='';");

// Restore the session after a page refresh (cookie), instead of always showing the login page.
patch('boot-render', '\nrender();\n</script></body></html>', `
ZSync.restore().then(u=>{
  if(u){const r=DB.reps.find(x=>x.id===u.id);session=u.role==='manager'?{id:'manager',name:u.name||'مدير المبيعات',role:'manager'}:{id:u.id,name:u.name,role:'sales'};view=zjuView('dashboard')?'dashboard':((r&&r.permissions&&r.permissions.views)||[])[0]||'dashboard'}
  render();
  if(u&&zjuView('knowledge'))zkLoad();
}).catch(()=>render());
</script></body></html>`);

// ── 4. Employee accounts: password hashing moves to the server ─────────────────────────────
patchRange('save-user', 'let salted=null;if(password){', "log((r?'تعديل صلاحيات وحساب '", `const rid=id||uid();
  await ZSync.saveUser({id:rid,username,name,password:password||undefined});
  if(r){r.name=name;r.username=username;r.permissions={views,actions};r.preset=data.preset||'sales'}
  else DB.reps.push({id:rid,name,username,role:'sales',active:true,preset:data.preset||'sales',permissions:{views,actions}});
  `);
patch('save-user-log', "log((r?'تعديل صلاحيات وحساب ':'إضافة حساب تجريبي ')+name);modal='';render();toast('حُفظ الحساب والصلاحيات في هذا المتصفح فقط');",
  "log((r?'تعديل صلاحيات وحساب ':'إضافة حساب ')+name);modal='';render();toast('تم حفظ الحساب والصلاحيات');");
patch('toggle-user-text', "' حساب '+r.name+' في هذه النسخة التجريبية؟'", "' حساب '+r.name+'؟'");

// ── 5. Files: IndexedDB -> R2 ──────────────────────────────────────────────────────────────
patchRange('store-file', 'async function storeFile(file){', 'window.downloadMaterial=', 'async function storeFile(file){return ZSync.uploadFile(file)}\n');
patchRange('download-material', 'window.downloadMaterial=async id=>{', '\n\n// ══ Zajel Smart Lite ══',
  "window.downloadMaterial=async id=>{try{const f=await ZSync.fetchFile(id);downloadBlob(f.blob,f.name)}catch(e){toast('تعذر قراءة المرفق')}};");

// ── 6. Wording that is no longer true once the data is shared ──────────────────────────────
patchRange('login-demo-notes', '<div class="zju-login-help">', '</div></div><div class="login-right">', '');
patch('login-user-default', 'placeholder="manager / ahmad / noor" value="manager" dir="ltr"', 'placeholder="اسم المستخدم" value="" dir="ltr"');
patch('account-menu-warning',
  /* eslint-disable-next-line */
  'const zjuAccountMenu=()=>`<div class="zju-demo-warning">هذه إدارة حسابات وصلاحيات تجريبية في المتصفح فقط، وليست حماية أمنية فعلية. البيانات والحسابات لا تتزامن بين الأجهزة، ولا يجوز رفع بيانات تجار حقيقية قبل تجهيز خادم وقاعدة بيانات وصلاحيات API.</div>`;',
  'const zjuAccountMenu=()=>``;');
patch('settings-data-note',
  'تُخزن سجلات CRM في localStorage لهذا المتصفح. ملفات المكتبة والتسجيلات في IndexedDB. ليس هذا نظام مشاركة بين أجهزة.',
  'البيانات محفوظة على الخادم ومشتركة بين جميع الموظفين، وتتحدّث تلقائياً. ينصح بتنزيل نسخة JSON بشكل دوري.');
patch('reset-confirm', "confirm('إعادة جميع سجلات النسخة التجريبية إلى البداية؟')",
  "confirm('تحذير: سيتم حذف جميع سجلات الشركة المشتركة لدى كل الموظفين نهائياً. هل أنت متأكد؟')");
patch('import-confirm', "confirm('استبدال بيانات التجربة الحالية؟')", "confirm('سيتم استبدال بيانات الشركة المشتركة لدى كل الموظفين بمحتوى الملف. متابعة؟')");

patch('topbar-note', '<div class="top-note">نسخة عرض محلية</div>', '<div class="top-note">نظام الفريق</div>');
patch('lexicon-note', 'التعديلات محفوظة في هذا المتصفح ضمن النسخة التجريبية ويمكن تصديرها مع نسخة JSON', 'التعديلات محفوظة على الخادم ومشتركة مع كل الموظفين ويمكن تصديرها مع نسخة JSON');

// ── 7. Knowledge library: IndexedDB -> shared server storage ───────────────────────────────
patchRange('kn-storage', 'function openDb(){', 'const hasUsefulText=', knStoreJs + '\n');
if (html.includes('openDb(')) throw new Error('kn-storage: openDb still referenced');
patch('kn-exports',
  'window.ZajelKnowledge={load,snapshot,addFile,analyze,ocrDocument,importInsights,updateDraft,review,saveFacts,removeDocument,exportBackup,importBackup,ruleMatches};',
  'window.ZajelKnowledge={load,snapshot,addFile:knWrap(addFile),analyze:knWrap(async(id,o)=>{await knEnsurePages(id);return analyze(id,o)}),ocrDocument:knWrap(async(id,o)=>{await knEnsurePages(id);return ocrDocument(id,o)}),importInsights:knWrap(async(id,d)=>{await knEnsurePages(id);return importInsights(id,d)}),updateDraft:knWrap(updateDraft),review:knWrap(review),saveFacts:knWrap(saveFacts),removeDocument:knWrap(removeDocument),exportBackup,importBackup:knWrap(importBackup),ruleMatches,loadPages:knWrap(knEnsurePages),loadAllPages:knWrap(knEnsureAll),reset:knReset};');
// Load only after login (the server needs a session), and refresh whenever the screen is opened.
patch('kn-no-preload', "window.addEventListener('DOMContentLoaded',zkLoad,{once:true});", '');
patch('kn-on-open', "window.go=v=>{if(!zjuView(v)){toast('هذا القسم غير متاح لحسابك');return;}contractPopup=null;view=v;",
  "window.go=v=>{if(!zjuView(v)){toast('هذا القسم غير متاح لحسابك');return;}contractPopup=null;view=v;if(v==='knowledge')zkLoad();");
patch('kn-logout', "window.logout=()=>{ZSync.logout();", "window.logout=()=>{ZSync.logout();try{ZajelKnowledge.reset()}catch(_){}");
patch('kn-show-pages', 'window.zkShowPages=id=>{zkPagesDoc=id;zkPreviewStart=1;render();};',
  "window.zkShowPages=async id=>{try{await ZajelKnowledge.loadPages(id);zkSync();}catch(e){return toast(e.message)}zkPagesDoc=id;zkPreviewStart=1;render();};");
patch('kn-export', "window.zkExport=()=>{if(!zkAdmin())return toast('التصدير يتطلب المدير');",
  "window.zkExport=async()=>{if(!isManager())return toast('التصدير يتطلب المدير');try{await ZajelKnowledge.loadAllPages()}catch(e){return toast(e.message)}");
// The team screen's knowledge permissions now actually apply (before, every library action was manager-only).
patch('kn-admin', 'const zkAdmin=()=>isManager();', "const zkAdmin=()=>isManager()||zjuCan('knowledgeManage');");
patch('kn-approve', "window.zkApprove=async id=>{if(!zkAdmin())return toast('الاعتماد يحتاج صلاحية المدير');",
  "window.zkApprove=async id=>{if(!(isManager()||zjuCan('knowledgeApprove')))return toast('الاعتماد يحتاج صلاحية «اعتماد رسائل المعرفة»');");
patch('kn-reject', "window.zkReject=async id=>{if(!zkAdmin())return toast('الرفض يحتاج صلاحية المدير');",
  "window.zkReject=async id=>{if(!(isManager()||zjuCan('knowledgeApprove')))return toast('الرفض يحتاج صلاحية «اعتماد رسائل المعرفة»');");
patch('kn-facts', "window.zkSaveFacts=async e=>{e.preventDefault();if(!zkAdmin())return;", "window.zkSaveFacts=async e=>{e.preventDefault();if(!isManager())return toast('الحقائق المعتمدة يعدّلها المدير فقط');");
patch('kn-delete', "window.zkDeleteDocument=async id=>{if(!zkAdmin())return toast('الحذف يتطلب صلاحية المدير');if(!confirm('حذف الملف وكل أفكاره ومسوداته نهائياً من هذا المتصفح؟'))return;",
  "window.zkDeleteDocument=async id=>{if(!isManager())return toast('الحذف يتطلب صلاحية المدير');if(!confirm('حذف الملف وكل أفكاره ومسوداته نهائياً من مكتبة الشركة لدى كل الموظفين؟'))return;");
patch('kn-import', "if(!zkAdmin())return toast('استعادة النسخة تتطلب المدير');", "if(!isManager())return toast('استعادة النسخة تتطلب المدير');");
patch('kn-text-count', '${zkData.documents.length} ملف في هذا المتصفح', '${zkData.documents.length} ملف في مكتبة الشركة');
patch('kn-text-storage', 'التخزين داخل هذا المتصفح باستخدام IndexedDB (وقد يُستخدم localStorage كبديل). لا تُشارك البيانات بين الأجهزة، وقد تُفقد بمسح بيانات الموقع. صدّر نسخة احتياطية بانتظام. هذا ليس نظام دخول آمن متعدد المستخدمين.',
  'المكتبة محفوظة على الخادم ومشتركة بين الموظفين حسب صلاحياتهم، والمعالجة (PDF وOCR) تتم في متصفح من يرفع الملف. صدّر نسخة احتياطية بانتظام.');
patch('kn-text-import', 'ستحل هذه النسخة محل بيانات مكتبة المعرفة الحالية على هذا المتصفح. متابعة؟', 'ستحل هذه النسخة محل مكتبة المعرفة المشتركة لدى كل الموظفين. متابعة؟');
patch('kn-text-source-field', 'ملف PDF الأصلي (اختياري إذا كان محفوظاً في هذا المتصفح، إلزامي للكتب المرفوعة قبل التحديث)', 'ملف PDF الأصلي (اختياري إذا كان محفوظاً على الخادم)');
patch('kn-text-templates', 'أُضيفت إلى قوالب CRM على هذا المتصفح', 'أُضيفت إلى قوالب CRM');
patch('kn-text-source-missing', 'نسخة PDF الأصلية غير محفوظة على هذا المتصفح. اختر الكتاب نفسه في حقل «ملف PDF الأصلي» ثم جرّب ثانية.', 'نسخة PDF الأصلية غير محفوظة على الخادم. اختر الكتاب نفسه في حقل «ملف PDF الأصلي» ثم جرّب ثانية.');

patch('kn-text-storage-badge', "التخزين: <b>هذا المتصفح</b></span><span>الصلاحية: <b>${zkAdmin()?'مدير':'عرض فقط'}</b></span>",
  "التخزين: <b>خادم الشركة</b></span><span>الصلاحية: <b>${isManager()?'مدير':zkAdmin()?'تشغيل المكتبة':(zjuCan('knowledgeApprove')?'اعتماد الرسائل':'عرض فقط')}</b></span>");

patch('kn-text-source-fail', 'تعذر حفظ الملف الأصلي بسبب سعة المتصفح؛ اختره مجدداً عند طلب OCR للصفحات.',
  'تعذر حفظ الملف الأصلي على الخادم (الحد 100 ميغابايت للملف الأصلي، أو انقطع الاتصال)؛ اختره مجدداً عند طلب OCR للصفحات.');

// ── 8. Change my own password (the account chip in the top bar opens the dialog) ───────────
patch('modal-password-hook', "function modalPage(){if(modal.startsWith('soc'))return socialModal();",
  "function modalPage(){if(modal==='changePassword')return pwdModal();if(modal.startsWith('soc'))return socialModal();");
patch('profile-chip', '<div class="profile-mini"><div class="avatar">',
  '<div class="profile-mini" role="button" tabindex="0" style="cursor:pointer" title="تغيير كلمة المرور" onclick="openPassword()" onkeydown="if(event.key===\'Enter\')openPassword()"><div class="avatar">');
patch('password-ui', 'function loginPage(){return `', `window.openPassword=()=>{modal='changePassword';render()};
function pwdModal(){return \`<div class="modal-bg" onclick="closeModal()"><div class="modal" onclick="event.stopPropagation()"><div class="drawer-head"><h3 class="modal-title">تغيير كلمة المرور</h3><button class="icon-btn" onclick="closeModal()">×</button></div><form onsubmit="savePassword(event)"><div class="fields"><div class="field wide"><label>كلمة المرور الحالية</label><input class="input" type="password" name="current" autocomplete="current-password" required dir="ltr"></div><div class="field wide"><label>كلمة المرور الجديدة (8 أحرف على الأقل)</label><input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required dir="ltr"></div><div class="field wide"><label>تأكيد كلمة المرور الجديدة</label><input class="input" type="password" name="again" autocomplete="new-password" minlength="8" required dir="ltr"></div></div><div id="pwd-msg" class="zju-login-alert" role="alert" hidden></div><div class="actions" style="margin-top:16px"><button class="btn coral" type="submit">حفظ كلمة المرور</button><button class="btn outline" type="button" onclick="closeModal()">إلغاء</button></div></form></div></div>\`}
window.savePassword=async e=>{e.preventDefault();if(zjuBusy)return;const d=dataForm(e),msg=document.getElementById('pwd-msg'),say=t=>{msg.textContent=t;msg.hidden=false};
 if(d.next!==d.again)return say('كلمتا المرور الجديدتان غير متطابقتين');
 if(d.next===d.current)return say('اختر كلمة مرور مختلفة عن الحالية');
 zjuBusy=true;try{await ZSync.changePassword(d.current,d.next);modal='';render();toast('تم تغيير كلمة المرور')}catch(err){say(err.message||'تعذر تغيير كلمة المرور')}finally{zjuBusy=false}};
function loginPage(){return \``);

// ── 9. Wording that stopped being true once the data moved to the shared server ────────────
// (Business disclaimers the owner wrote — quote price warning, demo campaign numbers — are left alone.)
function patchAll(name, from, to, expected) {
  const n = count(html, from);
  if (n !== expected) throw new Error(`Patch "${name}": expected ${expected} matches, found ${n}`);
  html = html.split(from).join(to);
}
patch('txt-stage-templates', 'تُحفظ القوالب داخل بيانات النموذج التجريبي في هذا المتصفح.', 'تُحفظ القوالب على الخادم وتظهر لكل الموظفين.');
patch('txt-consent-toast', "toast('حُفظ إذن التواصل في هذا المتصفح')", "toast('حُفظ إذن التواصل')");
patch('txt-perm-toast', 'هذه العملية غير متاحة ضمن صلاحيات حسابك التجريبي', 'هذه العملية غير متاحة ضمن صلاحيات حسابك');
patch('txt-team-sub', 'إدارة حسابات الموظفين التجريبية وصلاحيات الأقسام والإجراءات.', 'إدارة حسابات الموظفين وصلاحيات الأقسام والإجراءات.');
patch('txt-new-account-title', "'إضافة موظف وحساب دخول تجريبي'", "'إضافة موظف وحساب دخول'");
patch('txt-new-account-btn', "'إنشاء حساب تجريبي'", "'إنشاء حساب'");
patch('txt-team-hint', 'إدارة الفريق محصورة دائماً بحساب المدير التجريبي، حتى لو تم تعديل البيانات يدوياً.', 'إدارة الفريق محصورة دائماً بحساب المدير، ويتحقق السيرفر من ذلك.');
patchAll('txt-reset-label', 'إعادة ضبط البيانات التجريبية', 'مسح جميع بيانات الشركة', 2);
patch('txt-reset-toast', "toast('تم إعادة البيانات التجريبية')", "toast('تم مسح بيانات الشركة')");
patch('txt-mk-disclaimer', 'النسخة تجريبية محلية: لا نشر آلي،', 'ملاحظة: لا نشر آلي،');
patch('txt-import-limit', "'حد النسخة التجريبية 500 سطر في المرة'", "'الحد الأقصى 500 سطر في المرة'");
patch('txt-security-panel', 'تسجيل دخول حقيقي من السيرفر مع تجزئة قوية لكلمات المرور، جلسات آمنة HTTP-only، صلاحيات يتحقق منها السيرفر لكل طلب، سجل تدقيق، نسخ احتياطية مشفرة، تشفير الاتصال HTTPS، سياسات احتفاظ بالتسجيلات، وحدود أحجام للرفع.',
  'مُفعّل: تسجيل دخول من السيرفر مع تجزئة كلمات المرور، جلسات HTTP-only، صلاحيات يتحقق منها السيرفر لكل طلب، سجل تدقيق، وتشفير الاتصال HTTPS. المتبقي: نسخ احتياطية تلقائية، وسياسة احتفاظ بالتسجيلات.');
patch('txt-security-title', '<div class="panel-title">الأمان المطلوب للإنتاج</div>', '<div class="panel-title">حالة الأمان</div>');
patch('txt-audit-note', 'سجل المتصفح هنا تجريبي وقابل للتعديل أو الحذف. في النسخة الإنتاجية يجب أن يكون سجل التدقيق على الخادم بصلاحيات صارمة وتخزين مناسب.',
  'سجل التدقيق محفوظ على الخادم، ولا يستطيع الموظفون تعديله أو حذفه، ويُحتفظ بآخر 150 إجراءً.');
patch('txt-library-note', 'المواد النصية محفوظة محلياً في المتصفح. الملفات المرفوعة في النموذج تحفظ محلياً باستخدام IndexedDB (حتى 5 ميغابايت للملف)، ولا يراها باقي الموظفين على أجهزة أخرى.',
  'المواد النصية والملفات المرفوعة محفوظة على الخادم ويراها الموظفون حسب صلاحياتهم (حتى 5 ميغابايت للملف).');
patch('txt-pdf-note', 'إصدار PDF معتمد تلقائي غير متاح في النموذج التجريبي.', 'إصدار PDF معتمد تلقائي غير متاح في هذه النسخة.');
patch('txt-kn-loading', 'جارٍ تحميل المكتبة المحلية…', 'جارٍ تحميل المكتبة…');
patch('txt-ask-note', 'اختر أحد الأسئلة لعرض الإجابة معتمدة على بيانات العرض التجريبي.', 'اختر أحد الأسئلة لعرض الإجابة معتمدة على بيانات CRM.');

mkdirSync(resolve(root, 'public'), { recursive: true });
writeFileSync(resolve(root, 'public/index.html'), html);
console.log(`built public/index.html (${(html.length / 1024).toFixed(0)} KB)`);
