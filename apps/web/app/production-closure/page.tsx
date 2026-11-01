"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {api} from "../../lib/api";
import {formatMoney} from "../../lib/format";

type Production={production_entry_id:string;employee_id:string;employee_code:string;employee_name:string;earned_amount:number|string;actual_paid_amount:number|string;historical_paid_amount:number|string;remaining_amount:number|string;classification:string;work_date:string;order_code:string|null;order_name:string|null;stage_name:string|null};
type Closure={id:string;employee_id:string;employee_code:string;employee_name:string;closed_at:string;notes:string;approved_production_count:number;production_amount_snapshot:number|string;status:"ACTIVE"|"REVERSED";reversal_reason:string|null};
const money=(v:number)=>formatMoney(Number(v||0));

export default function ProductionClosurePage(){
 const {has,session}=usePermissions();
 const allowed=has("worker_payments.pay");
 const isManager=Boolean(session?.roleCodes?.some(x=>["admin","manager","owner"].includes(x.toLowerCase())));
 const [configured,setConfigured]=useState<boolean|null>(null);
 const [password,setPassword]=useState("");
 const [unlocked,setUnlocked]=useState(false);
 const [setupPassword,setSetupPassword]=useState("");
 const [confirmPassword,setConfirmPassword]=useState("");
 const [changeMode,setChangeMode]=useState(false);
 const [newPassword,setNewPassword]=useState("");
 const [currentPassword,setCurrentPassword]=useState("");
 const [rows,setRows]=useState<Production[]>([]);
 const [closures,setClosures]=useState<Closure[]>([]);
 const [search,setSearch]=useState("");
 const [busy,setBusy]=useState("");
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");

 const load=useCallback(async()=>{
   const [production,closureRows]=await Promise.all([
    api<{data:Production[]}>("/api/worker-payments/historical-production-settlements"),
    api<{data:Closure[]}>("/api/worker-payments/employee-production-closures",{headers:{"x-production-closure-password":password}})
   ]);
   setRows(production.data);setClosures(closureRows.data);
 },[password]);

 useEffect(()=>{if(!allowed)return;api<{data:{configured:boolean}}>("/api/worker-payments/employee-production-closures/access-status").then(r=>setConfigured(r.data.configured)).catch(e=>setError(e instanceof Error?e.message:"تعذر التحقق من إعدادات القسم"));},[allowed]);

 const employees=useMemo(()=>{
  const grouped=new Map<string,{id:string;code:string;name:string;count:number;earned:number;remaining:number}>();
  for(const r of rows){const item=grouped.get(r.employee_id)||{id:r.employee_id,code:r.employee_code,name:r.employee_name,count:0,earned:0,remaining:0};item.count++;item.earned+=Number(r.earned_amount||0);item.remaining+=Number(r.remaining_amount||0);grouped.set(r.employee_id,item);}
  const q=search.trim().toLocaleLowerCase("ar-EG");
  return [...grouped.values()].filter(x=>!q||[x.name,x.code].join(" ").toLocaleLowerCase("ar-EG").includes(q)).sort((a,b)=>a.name.localeCompare(b.name,"ar-EG"));
 },[rows,search]);

 async function unlock(){
  setError("");setSuccess("");setBusy("unlock");
  try{await load();setUnlocked(true);}
  catch(e){setError(e instanceof Error?e.message:"كلمة المرور غير صحيحة أو تعذر تحميل البيانات");}
  finally{setBusy("");}
 }
 async function setup(){
  if(setupPassword.length<10||setupPassword!==confirmPassword){setError("تأكد من تطابق كلمتي المرور وأن تكون 10 أحرف على الأقل.");return;}
  setBusy("setup");setError("");
  try{await api("/api/worker-payments/employee-production-closures/access-setup",{method:"POST",body:JSON.stringify({password:setupPassword})});setConfigured(true);setPassword(setupPassword);setSuccess("تم إعداد كلمة مرور القسم. أدخلها لفتح القسم.");setSetupPassword("");setConfirmPassword("");}
  catch(e){setError(e instanceof Error?e.message:"تعذر إعداد كلمة المرور");}
  finally{setBusy("");}
 }
 async function changePassword(){
  if(newPassword.length<10){setError("كلمة المرور الجديدة يجب ألا تقل عن 10 أحرف.");return;}
  setBusy("change");setError("");
  try{await api("/api/worker-payments/employee-production-closures/access-change",{method:"POST",body:JSON.stringify({currentPassword,newPassword})});setPassword(newPassword);setSuccess("تم تغيير كلمة مرور القسم.");setChangeMode(false);setCurrentPassword("");setNewPassword("");}
  catch(e){setError(e instanceof Error?e.message:"تعذر تغيير كلمة المرور");}
  finally{setBusy("");}
 }
 async function closeEmployee(employee:{id:string;name:string}){
  const notes=window.prompt("سبب إقفال مستحقات الإنتاج للعامل "+employee.name+":","إقفال المستحقات القائمة حتى تاريخ التنفيذ");
  if(!notes||notes.trim().length<3)return;
  if(!window.confirm("سيتم إقفال سجلات الإنتاج المعتمدة الحالية فقط. لن تتغير الكميات أو الأسعار أو القيود المالية، وسيظل الإنتاج الجديد مستحقًا. هل تؤكد؟"))return;
  setBusy(employee.id);setError("");setSuccess("");
  try{await api("/api/worker-payments/employee-production-closures",{method:"POST",headers:{"x-production-closure-password":password},body:JSON.stringify({employeeId:employee.id,notes:notes.trim()})});setSuccess("تم إقفال مستحقات "+employee.name+" بنجاح.");await load();}
  catch(e){setError(e instanceof Error?e.message:"تعذر إقفال المستحقات");}
  finally{setBusy("");}
 }
 async function reverse(closure:Closure){
  const reason=window.prompt("سبب إلغاء الإقفال:");
  if(!reason||reason.trim().length<3)return;
  if(!window.confirm("سيتم إعادة المستحقات المشمولة إلى حالة الاستحقاق. هل تؤكد؟"))return;
  setBusy(closure.employee_id);setError("");setSuccess("");
  try{await api("/api/worker-payments/employee-production-closures/"+encodeURIComponent(closure.id)+"/reverse",{method:"PATCH",headers:{"x-production-closure-password":password},body:JSON.stringify({reason:reason.trim()})});setSuccess("تم إلغاء الإقفال.");await load();}
  catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء الإقفال");}
  finally{setBusy("");}
 }

 if(!allowed)return <main className="app-shell"><Sidebar active="/production-closure"/><section className="main-content"><div className="page-header"><h1>إقفال مستحقات الإنتاج</h1></div><div className="card">ليس لديك صلاحية دخول هذا القسم.</div></section></main>;
 return <main className="app-shell"><Sidebar active="/production-closure"/><section className="main-content">
  <div className="page-header"><div><h1>إقفال مستحقات الإنتاج</h1><p className="form-hint">قسم مستقل ومحمّي بكلمة مرور إضافية لإقفال مستحقات أي موظف.</p></div></div>
  {error&&<div className="alert alert-error">{error}</div>}{success&&<div className="alert alert-success">{success}</div>}
  {configured===null?<div className="card">جارٍ التحقق من إعدادات القسم…</div>:!configured?
   <section className="card"><h2>إعداد كلمة مرور القسم</h2><p className="form-hint">ينفذ مدير النظام الإعداد مرة واحدة. تُخزن كلمة المرور مشفرة تجزئيًا ولا يمكن عرضها لاحقًا.</p>
    {!isManager?<p>لم يتم إعداد كلمة مرور القسم بعد. تواصل مع مدير النظام.</p>:<>
     <label>كلمة المرور الجديدة</label><input type="password" value={setupPassword} onChange={e=>setSetupPassword(e.target.value)} minLength={10} autoComplete="new-password"/>
     <label>تأكيد كلمة المرور</label><input type="password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} autoComplete="new-password"/>
     <button className="primary-button" disabled={busy==="setup"} onClick={()=>void setup()}>{busy==="setup"?"جارٍ الإعداد…":"حفظ كلمة المرور"}</button>
    </>}
   </section>:
   !unlocked?<section className="card" style={{maxWidth:520,margin:"40px auto"}}><h2>القسم محمي</h2><p className="form-hint">أدخل كلمة مرور إقفال مستحقات الإنتاج للمتابعة.</p>
    <label>كلمة المرور</label><input type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void unlock();}} autoComplete="current-password"/>
    <button className="primary-button" disabled={!password||busy==="unlock"} onClick={()=>void unlock()}>{busy==="unlock"?"جارٍ التحقق…":"دخول"}</button>
   </section>:
   <>
    <div className="card" style={{marginBottom:16}}><div className="row" style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap",alignItems:"center"}}><div><strong>إدارة إقفالات الموظفين</strong><p className="form-hint">اختر أي موظف لديه إنتاج معتمد. الإقفال يشمل السجلات القائمة فقط.</p></div><div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{isManager&&<button className="secondary-button" onClick={()=>setChangeMode(x=>!x)}>تغيير كلمة المرور</button>}<button className="secondary-button" onClick={()=>{setUnlocked(false);setPassword("");setRows([]);setClosures([]);}}>قفل القسم</button></div></div>
     {changeMode&&<div className="form-grid"><label>كلمة المرور الحالية<input type="password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)}/></label><label>كلمة المرور الجديدة<input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><button className="primary-button" disabled={busy==="change"} onClick={()=>void changePassword()}>حفظ كلمة المرور الجديدة</button></div>}
    </div>
    <div className="card"><div className="form-row"><label>بحث عن موظف</label><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="اسم الموظف أو كوده…"/></div>
     <div className="table-wrap"><table><thead><tr><th>الموظف</th><th>سجلات الإنتاج</th><th>قيمة الإنتاج</th><th>المتبقي الحالي</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>
      {employees.map(emp=>{const active=closures.find(c=>c.employee_id===emp.id&&c.status==="ACTIVE");return <tr key={emp.id}><td>{emp.name}<div className="form-hint">{emp.code}</div></td><td>{emp.count}</td><td>{money(emp.earned)}</td><td>{money(emp.remaining)}</td><td>{active?<span className="status success">مقفل</span>:<span className="status warning">غير مقفل</span>}</td><td>{active?<button className="secondary-button" disabled={busy===emp.id} onClick={()=>void reverse(active)}>إلغاء الإقفال</button>:<button className="primary-button" disabled={busy===emp.id} onClick={()=>void closeEmployee({id:emp.id,name:emp.name})}>إقفال المستحقات الحالية</button>}</td></tr>;})}
      {!employees.length&&<tr><td colSpan={6}>لا توجد سجلات إنتاج مطابقة للبحث.</td></tr>}
     </tbody></table></div>
    </div>
   </>
  }
 </section></main>;
}
