# واجهة الربط (API)

الأساس: `https://<نطاقك>/api` — كل الردود JSON.
للنظام الخارجي: أرسل `Authorization: Bearer <INTEGRATION_API_KEY>` (صلاحية كاملة كالمدير، بدون كوكيز).
للمستخدمين: `POST /login` يضع كوكي جلسة `zs` (HttpOnly).

## نموذج البيانات
- مصفوفات النظام ← مجموعات (collections)، عنصر لكل سجل بمعرّف `id`:
  `clients`, `tasks`, `activities`, `reps`, `templates`, `materials`, `audit`, `escalations`
- قوائم داخل كائنات ← `marketing__campaigns`, `marketing__tasks`, `marketing__content`, `marketing__tests`, `social__templates`, `social__campaigns`, `smart__quotes`, `smart__enrichments`
- باقي الإعدادات ← `kv` (مثل `marketing`, `social`, `smart`, `rejectionTemplates`).

## النقاط
| الطلب | الوصف |
|---|---|
| `POST /login` `{username,password}` | دخول. بعد 8 محاولات خاطئة يرجع `429` لمدة 15 دقيقة |
| `POST /logout` | خروج |
| `GET /me` | المستخدم الحالي |
| `GET /state` | كل البيانات المسموح للمستخدم رؤيتها: `{seq, seeded, collections, kv}` |
| `GET /changes?since=<seq>` | التغييرات بعد رقم معين: `{seq, ops:[{c,id,data}|{c,id,del:true}], kv}` |
| `POST /sync` `{ops:[...], kv:{...}}` | كتابة: `{c,id,data}` لإضافة/تعديل، `{c,id,del:true}` لحذف. حتى 500 عملية. الرد `{seq, rejected:[{c,id,error}|{k,error}]}` — العمليات المرفوضة بسبب الصلاحيات تُذكر ولا تُطبَّق |
| `POST /users` `{id,username,name,password?}` | إنشاء/تعديل حساب موظف (مدير فقط) |
| `POST /password` `{current,next}` | تغيير كلمة مروري |
| `POST /files` (جسم الملف + `X-Filename`) | رفع ملف ← `{id}` |
| `GET /files/:id` · `DELETE /files/:id` | تنزيل · حذف (حذف للمدير) |
| `GET /kn/state` | مكتبة المعرفة: `{documents, ideas, drafts, jobs, facts}` (يتطلب شاشة المكتبة) |
| `POST /kn/sync` `{ops:[{k,id,data}|{k,id,del:true}], facts?}` | كتابة المكتبة، `k` ∈ documents/ideas/drafts/jobs. الرد `{rejected:[...]}` |
| `GET /kn/pages/:doc` · `PUT /kn/pages/:doc/:chunk` · `DELETE /kn/pages/:doc` | نص صفحات الكتاب (مقاطع من 50 صفحة) |
| `GET/PUT/DELETE /kn/source/:doc` | ملف PDF الأصلي (لـ OCR لاحق) |
| `GET /backup` · `GET /backups` · `POST /backups/run` | نسخ احتياطي (مدير/مفتاح الربط فقط): تنزيل فوري · قائمة نسخ R2 · تشغيل نسخة الآن |
| `GET /health` | فحص الحياة |

مثال: إضافة عميل من نظام خارجي
```bash
curl -X POST https://<نطاقك>/api/sync -H "Authorization: Bearer $KEY" \
  -d '{"ops":[{"c":"clients","id":"ext-1001","data":{"id":"ext-1001","name":"متجر النور","stage":"جديد","phone":"0770..."}}]}'
```
> حقول سجل العميل وغيره هي نفس حقول الواجهة الحالية؛ أي سجل مكتوب بنفس الشكل يظهر عند الموظفين خلال ثوانٍ.
