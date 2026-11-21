// Builds public/index.html from original/zajel-original.html.
// The original is never edited. Every change below is a small, explicit patch, and each patch must
// match exactly once — otherwise the build fails, so nothing is silently skipped or applied twice.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = readFileSync(resolve(root, 'original/zajel-original.html'), 'utf8');
const syncJs = readFileSync(resolve(root, 'src/client/zajel-sync.js'), 'utf8');

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
 }catch(err){zjuLoginMsg(err.message||'تعذر تسجيل الدخول')}finally{zjuBusy=false}
};
`);
patch('logout', 'window.logout=()=>{zkKey=\'\';', "window.logout=()=>{ZSync.logout();zkKey='';");

// Restore the session after a page refresh (cookie), instead of always showing the login page.
patch('boot-render', '\nrender();\n</script></body></html>', `
ZSync.restore().then(u=>{
  if(u){const r=DB.reps.find(x=>x.id===u.id);session=u.role==='manager'?{id:'manager',name:u.name||'مدير المبيعات',role:'manager'}:{id:u.id,name:u.name,role:'sales'};view=zjuView('dashboard')?'dashboard':((r&&r.permissions&&r.permissions.views)||[])[0]||'dashboard'}
  render();
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

mkdirSync(resolve(root, 'public'), { recursive: true });
writeFileSync(resolve(root, 'public/index.html'), html);
console.log(`built public/index.html (${(html.length / 1024).toFixed(0)} KB)`);
