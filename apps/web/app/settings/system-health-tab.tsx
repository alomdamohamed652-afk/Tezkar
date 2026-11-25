"use client";
import {useEffect,useState} from "react";
import {api} from "../../lib/api";

type Health={
 status:string;
 serverTime:string;
 database:{status:string;latencyMs:number|null};
 diagnostics:{
  migrations:{countAvailable:boolean;latestAvailable:boolean};
  backupExportAudit:{available:boolean};
  failedLoginCount:{available:boolean};
  recentFailedLogins:{available:boolean};
 };
 migrations:{count:number;last:{version:string;appliedAt:string}|null};
 lastBackupAt:string|null;
 failedLogins24h:number;
 recentFailedLogins:Array<{at:string;username:string|null;ip:string|null}>;
 recentErrors:Array<{at:string;route:string;method:string;name:string}>;
};

function fmt(value:string|null){return value?new Date(value).toLocaleString("ar-EG",{timeZone:"Africa/Cairo"}):"—";}

export function SystemHealthTab(){
 const [health,setHealth]=useState<Health|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[refreshedAt,setRefreshedAt]=useState<Date|null>(null);
 async function load(){try{const result=await api<Health>("/api/health/admin");setHealth(result);setError("");}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل صحة النظام");}finally{setLoading(false);setRefreshedAt(new Date());}}
 useEffect(()=>{void load();const timer=setInterval(()=>void load(),60000);return()=>clearInterval(timer);},[]);
 return <section>
 {error&&<div className="alert error">{error}</div>}
 {loading&&<div className="card">جارٍ تحميل صحة النظام...</div>}
 {health&&<>
  {Object.values(health.diagnostics).some(group=>Object.values(group).some(available=>!available))&&<div className="alert error">بعض بيانات التشخيص غير متاحة بسبب فشل استعلام أو اختلاف في المخطط؛ القيم الافتراضية لا تعني عدم وجود سجلات.</div>}
  <div className="stats">
   <div className={"card stat"+(health.database.status==="ok"?"":" warning")}><div className="stat-label">قاعدة البيانات</div><div className="stat-value">{health.database.status==="ok"?"تعمل":"متوقفة"}</div><div className="stat-note">{health.database.latencyMs!==null?"زمن الاستجابة "+Math.round(health.database.latencyMs)+" مللي ثانية":"لا يمكن الوصول إليها"}</div></div>
   <div className="card stat"><div className="stat-label">آخر نسخة احتياطية</div><div className="stat-value" style={{fontSize:18}}>{fmt(health.lastBackupAt)}</div><div className="stat-note">{!health.diagnostics.backupExportAudit.available?"تعذر قراءة سجل التصدير":health.lastBackupAt?"آخر عملية تصدير مسجلة في سجل العمليات، وليست إثبات نسخة كاملة قابلة للاسترجاع":"لا يوجد سجل تصدير"}</div></div>
   <div className="card stat"><div className="stat-label">آخر migration</div><div className="stat-value" dir="ltr" style={{fontSize:14,wordBreak:"break-all",textAlign:"right"}}>{health.migrations.last?health.migrations.last.version:"—"}</div><div className="stat-note">{!health.diagnostics.migrations.latestAvailable||!health.diagnostics.migrations.countAvailable?"تعذر قراءة سجل migrations":health.migrations.last?"طُبقت "+fmt(health.migrations.last.appliedAt):"لا يوجد سجل"} · الإجمالي {health.diagnostics.migrations.countAvailable?health.migrations.count:"غير متاح"}</div></div>
   <div className={"card stat"+(health.failedLogins24h>0?" warning":"")}><div className="stat-label">محاولات دخول فاشلة (24 ساعة)</div><div className="stat-value">{health.failedLogins24h.toLocaleString("ar-EG")}</div></div>
  </div>
  <section className="card"><div className="card-header"><h2 className="card-title">أخطاء الخادم الأخيرة</h2><span>{health.recentErrors.length} خطأ منذ آخر تشغيل للخادم</span></div>
   {health.recentErrors.length===0?<div className="empty">لا توجد أخطاء مسجلة منذ آخر تشغيل للخادم.</div>:
   <div className="table-wrap"><table><thead><tr><th>التوقيت</th><th>المسار</th><th>الطريقة</th><th>النوع</th></tr></thead><tbody>{health.recentErrors.map((e,i)=><tr key={i}><td>{fmt(e.at)}</td><td className="mono">{e.route}</td><td>{e.method}</td><td>{e.name}</td></tr>)}</tbody></table></div>}
  </section>
  <section className="card"><div className="card-header"><h2 className="card-title">محاولات الدخول الفاشلة الأخيرة</h2></div>
   {health.recentFailedLogins.length===0?<div className="empty">لا توجد محاولات دخول فاشلة مسجلة.</div>:
   <div className="table-wrap"><table><thead><tr><th>التوقيت</th><th>اسم المستخدم</th><th>عنوان الاتصال</th></tr></thead><tbody>{health.recentFailedLogins.map((f,i)=><tr key={i}><td>{fmt(f.at)}</td><td dir="ltr">{f.username??"—"}</td><td dir="ltr">{f.ip??"—"}</td></tr>)}</tbody></table></div>}
  </section>
  {refreshedAt&&<p className="page-subtitle">آخر تحديث: {refreshedAt.toLocaleTimeString("ar-EG",{timeZone:"Africa/Cairo"})} · وقت الخادم {fmt(health.serverTime)}</p>}
 </>}
 </section>;
}
