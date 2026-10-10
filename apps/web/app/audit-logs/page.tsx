"use client";

import {useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";

type AuditRow={id:string;actor_user_id:string|null;actor_employee_id:string|null;action:string;module:string;entity_type:string;entity_id:string|null;request_id:string|null;ip_address:string|null;user_agent:string|null;before_data:unknown;after_data:unknown;metadata:unknown;created_at:string;actor_username:string;actor_employee_name:string|null};
type AuditOptions={modules:string[];actions:string[];actors:{id:string;username:string}[]};
const actionLabels:Record<string,string>={create:"إنشاء",update:"تعديل",delete:"حذف",approve:"اعتماد",reject:"رفض",pay:"صرف",repay:"سداد",transfer:"تحويل",settle:"تسوية",login:"تسجيل دخول",logout:"تسجيل خروج",close:"إقفال",auto_allocate:"توزيع تلقائي",update_allocations:"تعديل التوزيع",review:"مراجعة"};
const moduleLabels:Record<string,string>={finance:"المالية",cash_custody:"العهد النقدية",custody:"العهد",advances:"السلف",production:"الإنتاج",warehouse:"المخزن",orders:"الطلبيات",auth:"الدخول",users:"المستخدمون",payroll:"المرتبات",tasks:"المهام"};
const stringify=(value:unknown)=>value==null?"—":typeof value==="string"?value:JSON.stringify(value,null,2);

export default function AuditLogsPage(){
 const {has}=usePermissions();
 const [rows,setRows]=useState<AuditRow[]>([]);
 const [options,setOptions]=useState<AuditOptions>({modules:[],actions:[],actors:[]});
 const [filters,setFilters]=useState({from:"",to:"",module:"",action:"",actorUserId:"",entityType:"",q:""});
 const [loading,setLoading]=useState(false),[error,setError]=useState(""),[expanded,setExpanded]=useState<string[]>([]);
 async function load(next=filters){
  setLoading(true);setError("");
  try{
   const q=new URLSearchParams();for(const [key,value] of Object.entries(next))if(value.trim())q.set(key,value.trim());q.set("limit","500");
   const r=await api<{data:AuditRow[];options:AuditOptions}>("/api/audit-logs?"+q.toString());setRows(r.data);setOptions(r.options);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل النظام")}finally{setLoading(false)}
 }
 useEffect(()=>{if(has("audit.view"))void load()},[has]);
 function toggle(id:string){setExpanded(v=>v.includes(id)?v.filter(x=>x!==id):[...v,id])}
 return <div className="app-shell"><Sidebar active="/audit-logs"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">سجل النظام والعمليات</h1><p className="page-subtitle">سجل تدقيقي للعمليات المسجلة في المالية والإنتاج والمخزن وباقي أجزاء النظام.</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   <section className="card"><div className="card-header"><div><h2 className="card-title">البحث في السجل</h2><div className="form-hint">كل سجل يوضح الحساب الذي نفّذ العملية ووقت التنفيذ والبيانات قبل التغيير وبعده عند توفرها.</div></div><span className="count-badge">{rows.length.toLocaleString("ar-EG")}</span></div>
    <div className="form-grid finance-four-grid">
     <label>من تاريخ<input type="date" value={filters.from} onChange={e=>setFilters(v=>({...v,from:e.target.value}))}/></label>
     <label>إلى تاريخ<input type="date" value={filters.to} onChange={e=>setFilters(v=>({...v,to:e.target.value}))}/></label>
     <label>القسم<select value={filters.module} onChange={e=>setFilters(v=>({...v,module:e.target.value}))}><option value="">كل الأقسام</option>{options.modules.map(x=><option key={x} value={x}>{moduleLabels[x]||x}</option>)}</select></label>
     <label>نوع العملية<select value={filters.action} onChange={e=>setFilters(v=>({...v,action:e.target.value}))}><option value="">كل العمليات</option>{options.actions.map(x=><option key={x} value={x}>{actionLabels[x]||x}</option>)}</select></label>
     <label>الحساب الذي نفّذ العملية<select value={filters.actorUserId} onChange={e=>setFilters(v=>({...v,actorUserId:e.target.value}))}><option value="">كل الحسابات</option>{options.actors.map(x=><option key={x.id} value={x.id}>{x.username}</option>)}</select></label>
     <label>نوع السجل<input value={filters.entityType} onChange={e=>setFilters(v=>({...v,entityType:e.target.value}))} placeholder="مثال: production_entry"/></label>
     <label style={{gridColumn:"1/-1"}}>بحث بالاسم أو الكود أو البيانات<input value={filters.q} onChange={e=>setFilters(v=>({...v,q:e.target.value}))} placeholder="اسم الحساب، رقم الحركة، البيان أو محتوى التغيير"/></label>
    </div>
    <div className="form-actions"><button className="primary-button" disabled={loading} onClick={()=>void load()}>{loading?"جارٍ البحث...":"تطبيق الفلاتر"}</button><button className="secondary-button" onClick={()=>{const next={from:"",to:"",module:"",action:"",actorUserId:"",entityType:"",q:""};setFilters(next);void load(next)}}>مسح الفلاتر</button></div>
   </section>
   <section className="card"><div className="card-header"><div><h2 className="card-title">العمليات المسجلة</h2><div className="form-hint">اضغط «تفاصيل التغيير» لمراجعة البيانات المرتبطة بالعملية.</div></div></div>
    <div className="table-wrap"><table><thead><tr><th>التاريخ والوقت</th><th>الحساب المنفّذ</th><th>القسم</th><th>العملية</th><th>نوع السجل / المرجع</th><th>تفاصيل</th></tr></thead><tbody>
     {rows.map(x=><tr key={x.id}><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td><td><strong>{x.actor_username}</strong>{x.actor_employee_name&&<div className="form-hint">{x.actor_employee_name}</div>}</td><td>{moduleLabels[x.module]||x.module}</td><td>{actionLabels[x.action]||x.action}</td><td>{x.entity_type}<div className="form-hint mono">{x.entity_id||"—"}</div></td><td><button className="secondary-button" onClick={()=>toggle(x.id)}>{expanded.includes(x.id)?"إخفاء التفاصيل":"تفاصيل التغيير"}</button></td></tr>)}
     {!rows.length&&<tr><td colSpan={6}>{loading?"جارٍ تحميل السجل...":"لا توجد عمليات مطابقة للفلاتر."}</td></tr>}
    </tbody></table></div>
    {rows.filter(x=>expanded.includes(x.id)).map(x=><section className="card nested-card" key={x.id}>
     <div className="card-header"><div><h3 className="card-title">{moduleLabels[x.module]||x.module} · {actionLabels[x.action]||x.action}</h3><div className="form-hint">{new Date(x.created_at).toLocaleString("ar-EG")} · {x.actor_username} · {x.entity_type} · {x.entity_id||"بدون مرجع"}</div></div></div>
     <div className="detail-grid finance-detail"><div><b>معرّف الطلب</b><span className="mono">{x.request_id||"—"}</span></div><div><b>عنوان الاتصال</b><span>{x.ip_address||"—"}</span></div><div><b>الجهاز / المتصفح</b><span>{x.user_agent||"—"}</span></div></div>
     <div className="grid"><div><h4>قبل العملية</h4><pre className="audit-json">{stringify(x.before_data)}</pre></div><div><h4>بعد العملية</h4><pre className="audit-json">{stringify(x.after_data)}</pre></div></div>
     <details><summary>بيانات إضافية</summary><pre className="audit-json">{stringify(x.metadata)}</pre></details>
    </section>)}
   </section>
  </section>
 </main></div>
}
