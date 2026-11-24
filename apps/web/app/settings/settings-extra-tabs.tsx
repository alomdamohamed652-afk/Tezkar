"use client";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../../lib/api";

type RegistrationRequest={id:string;full_name:string;username:string;phone:string|null;status:string;created_at:string};
type Role={id:string;code:string;name:string;is_system:boolean;is_active:boolean};
type Employee={id:string;code:string;full_name:string;phone?:string|null;is_active:boolean};
type ApprovalChoice={roleCode:string;accountType:"employee"|"standalone";employeeId:string;createEmployee:boolean};

export function RegistrationRequestsTab(){
  const [requests,setRequests]=useState<RegistrationRequest[]>([]);
  const [roles,setRoles]=useState<Role[]>([]);
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [choices,setChoices]=useState<Record<string,ApprovalChoice>>({});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [reqs,roleResult,employeeResult]=await Promise.all([
        api<{data:RegistrationRequest[]}>("/api/registration-requests"),
        api<{data:Role[]}>("/api/roles"),
        api<{data:Employee[]}>("/api/employees")
      ]);
      const activeRoles=roleResult.data.filter(r=>r.is_active&&r.code!=="manager");
      setRequests(reqs.data);
      setRoles(activeRoles);
      setEmployees(employeeResult.data.filter(e=>e.is_active));
      setChoices(current=>{
        const next={...current};
        for(const req of reqs.data){
          if(!next[req.id])next[req.id]={
            roleCode:activeRoles.find(r=>r.code==="employee")?.code??activeRoles.find(r=>!r.is_system)?.code??activeRoles[0]?.code??"",
            accountType:"standalone",
            employeeId:"",
            createEmployee:false
          };
        }
        return next;
      });
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل طلبات التسجيل أو قائمة الموظفين");}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();},[load]);

  function updateChoice(id:string,patch:Partial<ApprovalChoice>){
    setChoices(current=>({ ...current,[id]:{...(current[id]??{roleCode:"",accountType:"standalone",employeeId:"",createEmployee:false}),...patch} }));
  }

  async function review(item:RegistrationRequest,action:"approve"|"reject"){
    setBusy(item.id);setError("");setMessage("");
    try{
      if(action==="approve"){
        const choice=choices[item.id];
        if(!choice?.roleCode)throw new Error("اختار الدور قبل تفعيل الحساب");
        if(choice.accountType==="employee"&&!choice.employeeId&&!choice.createEmployee)throw new Error("اختار موظفًا موجودًا أو إنشاء ملف موظف جديد");
        await api("/api/registration-requests/"+item.id+"/approve",{
          method:"POST",
          body:JSON.stringify({roleCode:choice.roleCode,accountType:choice.accountType,employeeId:choice.accountType==="employee"?choice.employeeId||null:null,createEmployee:choice.accountType==="employee"&&choice.createEmployee})
        });
        setMessage("تم تفعيل حساب "+item.username+(choice.accountType==="employee"?(choice.createEmployee?" وإنشاء ملف موظف جديد له بكود EMP تلقائي.":" وربطه بملف الموظف المختار."):" كمستخدم مستقل.")+" ويمكنه الدخول باليوزر أو رقم الموبايل.");
      }else{
        const reason=window.prompt("سبب الرفض (اختياري):")??"";
        await api("/api/registration-requests/"+item.id+"/reject",{method:"POST",body:JSON.stringify({reason})});
        setMessage("تم رفض طلب "+item.username+".");
      }
      await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر مراجعة الطلب");}
    finally{setBusy(null);}
  }

  return <div>
    <div className="settings-embed-head"><div><h2 className="card-title">طلبات إنشاء الحسابات</h2><p className="settings-help">فعّل الحساب، اختار صلاحياته، وحدد هل يرتبط بموظف موجود أم يكون مستخدمًا مستقلًا.</p></div><button className="secondary-btn" onClick={()=>void load()} disabled={loading}>تحديث القائمة</button></div>
    {error&&<div className="alert error" role="alert">{error}</div>}{message&&<div className="alert success" role="status">{message}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12,marginBottom:16}}>
        <div style={{padding:15,borderRadius:14,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1e40af"}}><strong style={{display:"block",fontSize:13}}>ربط بحساب عامل</strong><span style={{fontSize:12}}>اختار موظفًا موجودًا ليرتبط حساب الدخول بملفه وسجلاته.</span></div>
        <div style={{padding:15,borderRadius:14,background:"#f5f3ff",border:"1px solid #ddd6fe",color:"#5b21b6"}}><strong style={{display:"block",fontSize:13}}>مستخدم مستقل</strong><span style={{fontSize:12}}>ينشئ حساب دخول وصلاحيات بدون ربطه بملف موظف.</span></div>
      </div>
      <section className="card">
        <div className="card-header"><div><h2 className="card-title">طلبات معلّقة</h2><p className="form-hint">رقم الموبايل إلزامي وسيُستخدم لتسجيل الدخول بجانب اسم المستخدم.</p></div><span>{requests.length} طلب</span></div>
        {loading?<p className="empty">جاري تحميل الطلبات...</p>:requests.length===0?<p className="empty">مفيش طلبات تسجيل معلّقة حاليًا.</p>:<div className="table-scroll"><table><thead><tr><th>الاسم والبيانات</th><th>نوع الحساب</th><th>الدور</th><th>ربط الموظف</th><th>الإجراء</th></tr></thead><tbody>
          {requests.map(item=>{
            const choice=choices[item.id]??{roleCode:"",accountType:"standalone" as const,employeeId:""};
            return <tr key={item.id}>
              <td><strong>{item.full_name}</strong><div dir="ltr" style={{textAlign:"right",fontSize:12,color:"var(--muted,#64748b)"}}>{item.username}</div><div style={{fontSize:12,fontWeight:800,color:"#047857",marginTop:4}}>{item.phone||"طلب قديم بدون رقم موبايل"}</div><small style={{color:"var(--muted,#64748b)"}}>{new Date(item.created_at).toLocaleString("ar-EG")}</small></td>
              <td><div style={{display:"grid",gap:7,minWidth:150}}>
                <label style={{display:"flex",alignItems:"center",gap:7,padding:8,borderRadius:9,border:choice.accountType==="employee"?"1px solid #93c5fd":"1px solid var(--border,#e2e8f0)",background:choice.accountType==="employee"?"#eff6ff":"transparent",fontSize:12,fontWeight:800}}><input type="radio" name={"account-"+item.id} checked={choice.accountType==="employee"} onChange={()=>updateChoice(item.id,{accountType:"employee"})}/> حساب عامل</label>
                <label style={{display:"flex",alignItems:"center",gap:7,padding:8,borderRadius:9,border:choice.accountType==="standalone"?"1px solid #c4b5fd":"1px solid var(--border,#e2e8f0)",background:choice.accountType==="standalone"?"#f5f3ff":"transparent",fontSize:12,fontWeight:800}}><input type="radio" name={"account-"+item.id} checked={choice.accountType==="standalone"} onChange={()=>updateChoice(item.id,{accountType:"standalone",employeeId:"",createEmployee:false})}/> مستخدم مستقل</label>
              </div></td>
              <td><select style={{minWidth:135}} value={choice.roleCode} onChange={e=>updateChoice(item.id,{roleCode:e.target.value})} aria-label={"دور "+item.username}><option value="">اختار الدور</option>{roles.map(role=><option key={role.id} value={role.code}>{role.name}</option>)}</select></td>
              <td>{choice.accountType==="employee"?<select style={{minWidth:190,maxWidth:240}} value={choice.employeeId} onChange={e=>updateChoice(item.id,e.target.value==="__new_employee__"?{employeeId:"",createEmployee:true}:{employeeId:e.target.value,createEmployee:false})} aria-label={"الموظف المرتبط "+item.username}><option value="">اختار الموظف</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name} — {employee.code}{employee.phone?" · "+employee.phone:""}</option>)}<option value="__new_employee__">＋ إنشاء ملف موظف جديد (كود EMP تلقائي)</option></select>:<span style={{display:"inline-flex",padding:"7px 10px",borderRadius:8,background:"#f5f3ff",color:"#6d28d9",fontSize:12,fontWeight:800}}>بدون ربط بموظف</span>}</td>
              <td><div className="form-actions" style={{flexWrap:"wrap",minWidth:140}}><button className="primary-button" disabled={busy===item.id||!choice.roleCode||(choice.accountType==="employee"&&!choice.employeeId&&!choice.createEmployee)||!item.phone} onClick={()=>void review(item,"approve")}>{busy===item.id?"جاري التنفيذ...":"موافقة وتفعيل"}</button><button className="danger-button" disabled={busy===item.id} onClick={()=>void review(item,"reject")}>رفض</button></div>{!item.phone&&<small style={{display:"block",color:"#b91c1c",marginTop:5}}>الطلب قديم؛ يلزم إعادة التسجيل برقم موبايل.</small>}</td>
            </tr>;
          })}
        </tbody></table></div>}
      </section>
  </div>;
}

type Item={id:string;requested_login:string;requested_phone:string|null;username:string|null;full_name:string|null;user_code:string|null;employee_code:string|null;employee_name:string|null;created_at:string};

export function PasswordResetRequestsTab(){
 const [items,setItems]=useState<Item[]>([]); const [error,setError]=useState(""); const [loading,setLoading]=useState(true);
 const load=useCallback(async()=>{setLoading(true);setError("");try{const result=await api<{data:Item[]}>("/api/password-reset-requests");setItems(result.data??[]);}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الطلبات");}finally{setLoading(false);}},[]);
 useEffect(()=>{void load();},[load]);
 async function reject(id:string){if(!confirm("تأكيد رفض طلب إعادة تعيين كلمة المرور؟"))return;try{await api("/api/password-reset-requests/"+id+"/reject",{method:"POST"});await load();}catch(e){setError(e instanceof Error?e.message:"تعذر رفض الطلب");}}
 async function approve(item:Item){const temporaryPassword=prompt("اكتب كلمة مرور مؤقتة قوية (12 حرفًا على الأقل). سلّمها لصاحب الحساب بشكل آمن.");if(!temporaryPassword)return;if(temporaryPassword.length<12){setError("كلمة المرور المؤقتة لازم تكون 12 حرفًا على الأقل");return;}try{const result=await api<{message?:string}>("/api/password-reset-requests/"+item.id+"/approve",{method:"POST",body:JSON.stringify({temporaryPassword})});alert(result.message??"تم اعتماد الطلب");await load();}catch(e){setError(e instanceof Error?e.message:"تعذر اعتماد الطلب");}}
 return <div>
    <div className="settings-embed-head"><div><h2 className="card-title">طلبات إعادة تعيين كلمة المرور</h2><p className="settings-help">راجع هوية صاحب الحساب قبل اعتماد أي طلب.</p></div><button className="secondary-btn" onClick={()=>void load()} disabled={loading}>تحديث القائمة</button></div>
    {error?<div className="alert error" role="alert">{error}</div>:null}<section className="card"><div className="card-header"><h2 className="card-title">الطلبات المعلّقة</h2><span className="count-badge">{items.length} طلب</span></div>{loading?<p className="empty">جاري تحميل الطلبات...</p>:items.length===0?<p className="empty">لا توجد طلبات معلّقة حاليًا.</p>:<div style={{display:"grid",gap:14}}>{items.map(i=><article key={i.id} style={{border:"1px solid var(--border,#e2e8f0)",borderRadius:14,padding:18,display:"grid",gap:10}}><div style={{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><strong>{i.full_name??"حساب غير معروف"}</strong><span>{new Date(i.created_at).toLocaleString("ar-EG")}</span></div><div>بيانات الطلب: {i.requested_login} {i.requested_phone?("• "+i.requested_phone):""}</div><div>الحساب: {i.username??"غير مطابق لحساب"} {i.user_code?("• كود المستخدم "+i.user_code):""} {i.employee_code?("• "+i.employee_code):""} {i.employee_name?("• "+i.employee_name):""}</div><div className="form-actions"><button className="primary-button" onClick={()=>void approve(i)}>اعتماد وتعيين كلمة مؤقتة</button><button className="danger-button" onClick={()=>void reject(i.id)}>رفض الطلب</button></div></article>)}</div>}</section>
  </div>;
}

type CountReport = { source: Array<{table:string;status:string;exactRows:string|null}>; target: Array<{table:string;status:string;exactRows:string|null}>; note:string };
type TransferPlan = { readyOrder: Array<{table:string;estimatedRows:number;dependsOn:string[]}>; blocked:Array<{table:string;reason:string;dependencies:string[]}>; deferred:Array<{table:string;reason:string;dependencies:string[]}>; totals:{sourceTables:number;readyTables:number;blockedTables:number;deferredTables:number}; writeEnabled:false; note:string };
type Inspection = {
  source: { tableCount: number; estimatedRows: number; foreignKeyCount: number };
  target: { tableCount: number; estimatedRows: number; foreignKeyCount: number };
  comparison: Array<{ table: string; status: string; sourceEstimate: number; targetEstimate: number; dependencies: string[]; hasPrimaryKey: boolean; differences: string[] }>;
  blockers: Array<{ table: string; status: string; differences: string[] }>;
  unsupportedSchemas?: { source: string[]; target: string[] };
  globalObjectDifferences?: Record<string, {
    source: number; target: number;
    differences: { missingInTarget: string[]; missingInSource: string[] };
  }>;
  note: string;
  objectComparison?: Record<string, {
    source: number;
    target: number;
    differences: { missingInTarget: string[]; missingInSource: string[] };
  }>;
  sourceFeatures?: { views: number; materializedViews: number; triggers: number; extensions: number; largeObjects: number; customTypes: number; routines: number; sequences: number };
  targetFeatures?: { views: number; materializedViews: number; triggers: number; extensions: number; largeObjects: number; customTypes: number; routines: number; sequences: number };
};
const labels: Record<string,string> = {compatible:"متوافق مبدئيًا",schema_mismatch:"اختلاف في البنية",source_only:"غير موجود في الوجهة",target_only:"موجود في الوجهة فقط"};

export function DataTransferTab(){
  const [report,setReport]=useState<Inspection|null>(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [selectedTables,setSelectedTables]=useState("public.users, public.employees");
  const [countReport,setCountReport]=useState<CountReport|null>(null);
  const [countLoading,setCountLoading]=useState(false);
  const [countError,setCountError]=useState("");
  const [plan,setPlan]=useState<TransferPlan|null>(null);
  const [planLoading,setPlanLoading]=useState(false);
  const [planError,setPlanError]=useState("");
  async function inspect(){setReport(null);setLoading(true);setError("");try{setReport(await api<Inspection>("/api/admin/data-transfer/inspection"));}catch(e){setError(e instanceof Error?e.message:"تعذر فحص القاعدتين");}finally{setLoading(false);}}
  async function inspectPlan(){setPlan(null);setPlanLoading(true);setPlanError("");try{setPlan(await api<TransferPlan>("/api/admin/data-transfer/plan"));}catch(e){setPlanError(e instanceof Error?e.message:"تعذر إنشاء خطة النقل");}finally{setPlanLoading(false);}}
  async function inspectCounts(){setCountReport(null);setCountLoading(true);setCountError("");try{const query=new URLSearchParams({tables:selectedTables});setCountReport(await api<CountReport>("/api/admin/data-transfer/counts?"+query.toString()));}catch(e){setCountError(e instanceof Error?e.message:"تعذر فحص أعداد السجلات");}finally{setCountLoading(false);}}
  return <div className="space-y-6">
    <div className="settings-embed-head"><div><h2 className="card-title">فحص وترحيل قاعدة البيانات</h2><p className="settings-help">فحص القاعدتين ومقارنة البنية قبل اعتماد أي نقل من النظام القديم.</p></div></div>
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">فحص للقراءة فقط. لن يتم تعديل القاعدة القديمة أو إدخال بيانات في القاعدة الجديدة.</div>
    <section className="rounded-xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">فحص الاتصال ومقارنة المخطط</h2><p className="mt-1 text-sm text-slate-500">الجداول والأعمدة والمفاتيح والعلاقات.</p></div><button onClick={inspect} disabled={loading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading?"جارٍ الفحص...":"ابدأ الفحص"}</button></div>{error&&<p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}</section>
    <section className="rounded-xl border bg-white p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">خطة ترتيب النقل المبدئية</h2><p className="mt-1 text-sm text-slate-500">يرتب الجداول المتوافقة بنيويًا فقط حسب علاقات المفاتيح الخارجية؛ لا يعني ذلك اعتماد جاهزيتها لنقل البيانات.</p></div><button onClick={inspectPlan} disabled={planLoading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{planLoading?"جارٍ إعداد الخطة...":"إنشاء معاينة الخطة"}</button></div>{planError&&<p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{planError}</p>}{plan&&<><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">{[["جداول المصدر",plan.totals.sourceTables],["متوافقة بنيويًا مبدئيًا",plan.totals.readyTables],["مستبعدة",plan.totals.blockedTables],["دورات/اعتماد دائري",plan.totals.deferredTables]].map(([label,count])=><div key={label as string} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{label as string}</p><p className="mt-1 text-xl font-bold">{(count as number).toLocaleString("ar-EG")}</p></div>)}</div><p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">معاينة بنيوية فقط — لا تعني جاهزية نقل البيانات. حالة Sequences الحالية (last_value/is_called) غير مفحوصة ويجب تسويتها بعد أي نقل. الكتابة معطلة ولم يتم نقل أو تعديل أي بيانات.</p><h3 className="mt-4 font-medium">الترتيب المقترح</h3>{plan.readyOrder.length? <ol className="mt-2 space-y-2">{plan.readyOrder.map((item,index)=><li key={item.table} className="flex flex-wrap justify-between gap-2 rounded-lg border p-3 text-sm"><span><b>{index+1}. {item.table}</b><span className="block text-xs text-slate-500">يعتمد على: {item.dependsOn.join("، ")||"لا توجد تبعيات"}</span></span><span className="text-slate-500">تقدير المصدر: {item.estimatedRows.toLocaleString("ar-EG")}</span></li>)}</ol>:<p className="mt-2 text-sm text-slate-500">لا توجد جداول جاهزة للترتيب حاليًا.</p>}{(plan.blocked.length>0||plan.deferred.length>0)&&<details className="mt-4"><summary className="cursor-pointer text-sm font-semibold">عرض الجداول المستبعدة والمؤجلة</summary><div className="mt-2 space-y-2">{[...plan.blocked,...plan.deferred].map(item=><div key={item.table} className="rounded-lg border border-amber-200 p-3 text-sm"><b>{item.table}</b><p className="mt-1 text-slate-600">{item.reason}</p>{item.dependencies.length>0&&<p className="mt-1 text-xs text-slate-500">التبعيات: {item.dependencies.join("، ")}</p>}</div>)}</div></details>}<p className="mt-3 text-xs text-slate-500">{plan.note}</p></>}</section>
    <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">فحص الأعداد الفعلية للجداول</h2><p className="mt-1 text-sm text-slate-500">أدخل من جدول إلى 5 جداول بصيغة public.table. الفحص قراءة فقط وبمهلة محدودة لكل جدول.</p><div className="mt-3 flex flex-col gap-3 sm:flex-row"><input aria-label="أسماء الجداول" value={selectedTables} onChange={event=>setSelectedTables(event.target.value)} className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" placeholder="public.users, public.employees"/><button onClick={inspectCounts} disabled={countLoading} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{countLoading?"جارٍ فحص الأعداد...":"فحص الأعداد الفعلية"}</button></div>{countError&&<p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{countError}</p>}{countReport&&<div className="mt-4 grid gap-3 sm:grid-cols-2">{[["المصدر",countReport.source],["الوجهة",countReport.target]].map(([name,rows])=><div key={name as string} className="rounded-lg bg-slate-50 p-3"><h3 className="mb-2 font-medium">{name as string}</h3>{(rows as CountReport["source"]).map(row=><div key={row.table} className="flex justify-between gap-2 border-t py-2 text-sm"><span dir="ltr">{row.table}</span><b>{row.status==="counted"?Number(row.exactRows).toLocaleString("ar-EG"):row.status}</b></div>)}</div>)}</div>}<p className="mt-3 text-xs text-slate-500">{countReport?.note??"لا يتم نسخ أو تعديل أي بيانات في هذا الفحص."}</p></section>
    {report&&<><section className="grid gap-3 sm:grid-cols-2">{[["القاعدة القديمة",report.source],["القاعدة الجديدة",report.target]].map(([name,value])=>{const v=value as Inspection["source"];return <div key={name as string} className="rounded-xl border bg-white p-5"><p className="text-sm text-slate-500">{name as string}</p><p className="mt-2 text-2xl font-bold">{v.tableCount.toLocaleString("ar-EG")} جدول</p><p className="mt-1 text-sm">تقدير السجلات: {v.estimatedRows.toLocaleString("ar-EG")}</p><p className="text-sm">العلاقات: {v.foreignKeyCount.toLocaleString("ar-EG")}</p></div>})}</section>
    {report.sourceFeatures&&report.targetFeatures&&<section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">كائنات قاعدة البيانات الإضافية</h2><p className="mt-1 text-sm text-slate-500">هذه العناصر لا تكفي مقارنة الجداول وحدها لضمان نقلها؛ نعرضها كجزء من فحص ما قبل النقل.</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{[["المصدر",report.sourceFeatures],["الوجهة",report.targetFeatures]].map(([name,value])=>{const v=value as NonNullable<Inspection["sourceFeatures"]>;return <div key={name as string} className="rounded-lg bg-slate-50 p-3"><p className="mb-2 font-medium">{name as string}</p><div className="grid grid-cols-2 gap-2 text-sm">{[["Views",v.views],["Materialized views",v.materializedViews],["Triggers",v.triggers],["Extensions",v.extensions],["Large objects",v.largeObjects],["Custom types",v.customTypes],["Routines",v.routines],["Sequences",v.sequences]].map(([label,count])=><p key={label as string}>{label as string}: <b>{(count as number).toLocaleString("ar-EG")}</b></p>)}</div></div>})}</div></section>}
    {report.globalObjectDifferences&&<section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">صلاحيات ونطاق الـSchemas</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{Object.entries(report.globalObjectDifferences).map(([key,item])=><div key={key} className="rounded-lg border p-3"><h3 className="font-medium">{({schemas:"ملكية وصلاحيات الـSchemas",defaultPrivileges:"Default Privileges",databaseAccess:"Database ACL وملكية القاعدة",roles:"خصائص الأدوار",roleMemberships:"عضويات الأدوار"} as Record<string,string>)[key]??key}</h3><p className="mt-2 text-sm">المصدر {item.source} / الوجهة {item.target}</p><p className="text-sm">اختلافات ناقصة بالوجهة: {item.differences.missingInTarget.length}</p><p className="text-sm">اختلافات موجودة بالوجهة فقط: {item.differences.missingInSource.length}</p>{[...item.differences.missingInTarget.map(value=>"ناقص بالوجهة: "+value),...item.differences.missingInSource.map(value=>"موجود بالوجهة فقط: "+value)].map((value,index)=><p key={index} dir="ltr" className="mt-1 break-all rounded bg-amber-50 p-2 text-xs">{value}</p>)}</div>)}</div>{report.unsupportedSchemas&&<div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"><b>مخططات خارج نطاق النقل المدعوم</b><p className="mt-1">المصدر: {report.unsupportedSchemas.source.join("، ")||"لا يوجد"}</p><p>الوجهة: {report.unsupportedSchemas.target.join("، ")||"لا يوجد"}</p></div>}</section>}
    {report.blockers.length>0&&<section className="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 className="font-semibold">تفاصيل الموانع المكتشفة ({report.blockers.length})</h2><div className="mt-3 space-y-2">{report.blockers.map((item,index)=><div key={item.table+":"+index} className="rounded-lg border border-amber-200 bg-white p-3 text-sm"><b dir="ltr">{item.table}</b><p className="mt-1 text-slate-600">{item.differences.join("، ")}</p></div>)}</div></section>}
    {report.objectComparison&&<section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">تفاصيل مقارنة كائنات قاعدة البيانات</h2><p className="mt-1 text-sm text-slate-500">المقارنة حسب التعريف البنيوي، ولا تعتبر اختلاف أسماء الفهارس أو القيود اختلافًا وحده.</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{Object.entries(report.objectComparison).map(([key,item])=><div key={key} className="rounded-lg border p-4"><div className="flex items-center justify-between gap-2"><h3 className="font-medium">{({indexes:"الفهارس",constraints:"القيود",views:"العروض",materializedViews:"العروض المادية",triggers:"المشغلات",extensions:"الإضافات",customTypes:"الأنواع المخصصة",routines:"الدوال والإجراءات",sequences:"التسلسلات"} as Record<string,string>)[key]??key}</h3><span className="text-xs text-slate-500">المصدر {item.source} / الوجهة {item.target}</span></div><p className="mt-2 text-sm">ناقص في الوجهة: <b>{item.differences.missingInTarget.length.toLocaleString("ar-EG")}</b></p><p className="text-sm">موجود بالوجهة فقط: <b>{item.differences.missingInSource.length.toLocaleString("ar-EG")}</b></p>{(item.differences.missingInTarget.length>0||item.differences.missingInSource.length>0)&&<details className="mt-3 text-xs"><summary className="cursor-pointer font-medium">عرض تفاصيل الاختلافات</summary><div className="mt-2 space-y-2 break-all"><div><p className="font-semibold">ناقص في الوجهة</p>{item.differences.missingInTarget.map((value,index)=><p key={index} className="mt-1 rounded bg-amber-50 p-2">{value}</p>)}</div><div><p className="font-semibold">موجود في الوجهة فقط</p>{item.differences.missingInSource.map((value,index)=><p key={index} className="mt-1 rounded bg-slate-50 p-2">{value}</p>)}</div></div></details>}</div>)}</div></section>}
    <section className="rounded-xl border bg-white p-5"><div className="flex justify-between gap-2"><h2 className="font-semibold">نتيجة مقارنة الجداول</h2><span className="text-sm text-slate-500">{report.comparison.length.toLocaleString("ar-EG")} جدول</span></div>{report.blockers.length>0&&<p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">توجد {report.blockers.length.toLocaleString("ar-EG")} حالة تحتاج مراجعة قبل تصميم خطة النقل.</p>}<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[680px] text-right text-sm"><thead className="bg-slate-50"><tr><th className="p-3">الجدول</th><th className="p-3">الحالة</th><th className="p-3">المصدر (تقديري)</th><th className="p-3">الوجهة (تقديري)</th><th className="p-3">الملاحظات</th></tr></thead><tbody>{report.comparison.map(x=><tr key={x.table} className="border-t align-top"><td className="p-3 font-medium">{x.table}</td><td className="p-3">{labels[x.status]??x.status}</td><td className="p-3">{x.sourceEstimate.toLocaleString("ar-EG")}</td><td className="p-3">{x.targetEstimate.toLocaleString("ar-EG")}</td><td className="p-3">{x.differences.join("، ")||"لا توجد فروق بنيوية مكتشفة"}</td></tr>)}</tbody></table></div><p className="mt-4 text-xs text-slate-500">{report.note}</p></section></>}
  </div>;
}

type Device={deviceName:string|null;deviceType:string|null;browser:string|null;os:string|null;ip:string|null;lastSeenAt:string|null};
type Account={id:string;username:string;full_name:string|null;is_active:boolean;last_login_at:string|null;active_devices:number;actions_30d:number;devices:Device[]};
type Audit={id:string;created_at:string;action:string;module:string;entity_type:string;entity_id:string|null;ip_address:string|null;user_agent:string|null;metadata:Record<string,unknown>;username:string|null;full_name:string|null};

export function AdminSecurityTab(){
 const [accounts,setAccounts]=useState<Account[]>([]),[logs,setLogs]=useState<Audit[]>([]),[page,setPage]=useState(1),[username,setUsername]=useState(""),[search,setSearch]=useState(""),[error,setError]=useState(""),[loading,setLoading]=useState(true);
 async function loadAccounts(){const result=await api<{data:Account[]}>("/api/admin/security/accounts");setAccounts(result.data);}
 async function loadAudit(nextPage=page,nextSearch=search){const qs=new URLSearchParams({page:String(nextPage),limit:"50"});if(nextSearch.trim())qs.set("username",nextSearch.trim());const result=await api<{data:Audit[]}>("/api/admin/security/audit?"+qs.toString());setLogs(result.data);}
 useEffect(()=>{Promise.all([loadAccounts(),loadAudit(1,"")]).catch(e=>setError(e instanceof Error?e.message:"تعذر تحميل بيانات الأمان")).finally(()=>setLoading(false));},[]);
 async function applySearch(e:FormEvent){e.preventDefault();setPage(1);setSearch(username);try{await loadAudit(1,username)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل النشاط")}}
 async function changePage(next:number){setPage(next);try{await loadAudit(next,search)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل النشاط")}}
 return <div>
    <div className="settings-embed-head"><div><h2 className="card-title">أمان الحسابات وسجل النشاط</h2><p className="settings-help">الأجهزة النشطة، تفاعل الحسابات، ومحاولات الدخول والعمليات المسجلة.</p></div></div>
    {error&&<div className="alert error">{error}</div>}{loading&&<div className="card">جارٍ تحميل بيانات الأمان...</div>}
 <section className="card"><div className="card-header"><h2 className="card-title">الحسابات والأجهزة</h2><span>{accounts.length} حساب</span></div><div className="table-wrap"><table><thead><tr><th>الحساب</th><th>الحالة</th><th>الأجهزة النشطة</th><th>عمليات آخر 30 يوم</th><th>آخر دخول</th><th>تفاصيل الأجهزة</th></tr></thead><tbody>{accounts.map(a=><tr key={a.id}><td><strong>{a.full_name||a.username}</strong><div className="muted">{a.username}</div></td><td>{a.is_active?"نشط":"موقوف"}</td><td>{a.active_devices}</td><td>{a.actions_30d}</td><td>{a.last_login_at?new Date(a.last_login_at).toLocaleString("ar-EG"):"لم يسجل دخول"}</td><td>{a.devices.length===0?"لا توجد جلسات نشطة":a.devices.map((d,i)=><div key={i} className="security-device"><strong>{d.deviceName||d.deviceType||"جهاز"}</strong><span>{[d.browser,d.os].filter(Boolean).join(" • ")||"معلومات المتصفح غير متاحة"}</span><small>{d.ip||"—"}{d.lastSeenAt?" • "+new Date(d.lastSeenAt).toLocaleString("ar-EG"):""}</small></div>)}</td></tr>)}</tbody></table></div></section>
 <section className="card"><div className="card-header"><h2 className="card-title">سجل العمليات (Audit Log)</h2></div><form className="form-actions" onSubmit={applySearch}><input aria-label="بحث باسم المستخدم" placeholder="ابحث باسم المستخدم" value={username} onChange={e=>setUsername(e.target.value)}/><button className="primary-button">بحث</button></form><div className="table-wrap"><table><thead><tr><th>التوقيت</th><th>المستخدم</th><th>الإجراء</th><th>الوحدة</th><th>الكيان</th><th>عنوان الاتصال</th><th>تفاصيل</th></tr></thead><tbody>{logs.map(a=><tr key={a.id}><td>{new Date(a.created_at).toLocaleString("ar-EG")}</td><td>{a.full_name||a.username||"النظام"}</td><td>{a.action}</td><td>{a.module}</td><td>{a.entity_type}{a.entity_id?" • "+a.entity_id.slice(0,8):""}</td><td>{a.ip_address||"—"}</td><td><details><summary>عرض</summary><pre className="audit-json">{JSON.stringify(a.metadata||{},null,2)}</pre><small>{a.user_agent||""}</small></details></td></tr>)}</tbody></table></div><div className="form-actions"><button className="secondary-button" disabled={page<=1} onClick={()=>changePage(page-1)}>السابق</button><span>صفحة {page}</span><button className="secondary-button" disabled={logs.length<50} onClick={()=>changePage(page+1)}>التالي</button></div></section>
  </div>;
}
