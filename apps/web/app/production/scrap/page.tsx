"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Sidebar, usePermissions } from "../../../components/sidebar";
import { formatQuantity } from "../../../lib/format";
import { SearchableSelect } from "../../../components/searchable-select";

type ProductionEntry = { id:string; code:string; work_date:string; quantity:number|string; status:string; employee_id:string; employee_name:string; product_name:string; stage_name:string; shift_name:string; order_name?:string|null; order_code?:string|null; };
type Scrap = { id:string; production_entry_id:string; scrap_type:"WORKER_SCRAP"|"MANUFACTURING_DEFECT"; quantity:number|string; notes:string|null; created_at:string; production_code:string; work_date:string; production_quantity:number|string; status:string; employee_id:string; employee_name:string; product_name:string; stage_name:string; shift_name:string; order_code:string|null; order_name:string|null; scrap_ratio:number; };

export default function ProductionScrapPage(){
 const {has}=usePermissions();
 const [entries,setEntries]=useState<ProductionEntry[]>([]);
 const [rows,setRows]=useState<Scrap[]>([]);
 const [entryId,setEntryId]=useState("");
 const [scrapType,setScrapType]=useState<"WORKER_SCRAP"|"MANUFACTURING_DEFECT">("WORKER_SCRAP");
 const [quantity,setQuantity]=useState("");
 const [notes,setNotes]=useState("");
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const [success,setSuccess]=useState("");
 const [from,setFrom]=useState("");
 const [to,setTo]=useState("");
 const [filterType,setFilterType]=useState("");
 const [search,setSearch]=useState("");

 async function load(){
  setLoading(true);setError("");
  try{
   const [p,s]=await Promise.all([
    api<{data:ProductionEntry[]}>("/api/production"),
    api<{data:Scrap[]}>("/api/production/scrap")
   ]);
   setEntries(p.data.filter(x=>!["CANCELLED","REJECTED"].includes(x.status)));
   setRows(s.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل بيانات الهالك")}
  finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[]);
 const selected=entries.find(x=>x.id===entryId);
 const options=useMemo(()=>entries.map(x=>({value:x.id,label:`${x.employee_name} — ${x.product_name} — ${x.code}`,meta:`${x.work_date} · ${x.stage_name}`})),[entries]);
 const visible=useMemo(()=>rows.filter(x=>(!from||String(x.work_date).slice(0,10)>=from)&&(!to||String(x.work_date).slice(0,10)<=to)&&(!filterType||x.scrap_type===filterType)&&(!search||[x.employee_name,x.product_name,x.order_name||"",x.order_code||"",x.production_code,x.stage_name].join(" ").toLowerCase().includes(search.toLowerCase()))),[rows,from,to,filterType,search]);
 const total=visible.reduce((s,x)=>s+Number(x.quantity||0),0);
 const workerTotal=visible.filter(x=>x.scrap_type==="WORKER_SCRAP").reduce((s,x)=>s+Number(x.quantity||0),0);
 const defectTotal=visible.filter(x=>x.scrap_type==="MANUFACTURING_DEFECT").reduce((s,x)=>s+Number(x.quantity||0),0);
 async function submit(e:FormEvent){
  e.preventDefault();setError("");setSuccess("");
  const q=Number(quantity);
  if(!entryId)return setError("اختار سجل الإنتاج المرتبط بالهالك.");
  if(!Number.isFinite(q)||q<=0)return setError("أدخل كمية هالك أكبر من صفر.");
  setBusy(true);
  try{
   await api("/api/production/scrap",{method:"POST",body:JSON.stringify({productionEntryId:entryId,scrapType,quantity:q,notes:notes.trim()||null})});
   setQuantity("");setNotes("");setSuccess("تم تسجيل الهالك وربطه بسجل الإنتاج. لم يتم خصم المخزون مرة أخرى.");
   await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الهالك")}
  finally{setBusy(false)}
 }
 if(!has("production.view"))return <div className="app-shell"><Sidebar active="/production"/><main className="main"><section className="content"><div className="alert error">ليس لديك صلاحية عرض إنتاج العمال والهالك.</div></section></main></div>;
 return <div className="app-shell"><Sidebar active="/production"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">الهالك من الإنتاج</h1><p className="page-subtitle">تسجيل الهالك على سجل الإنتاج وتحليل الكميات حسب العامل والصنف والطلبية.</p></div><a className="secondary-button" href="/production">العودة لإنتاج العمال</a></header>
  <section className="content">
   {error&&<div role="alert" className="alert error">{error}</div>}{success&&<div role="status" className="alert success">{success}</div>}
   <div className="stats">
    <article className="card stat"><div className="stat-label">إجمالي الهالك</div><div className="stat-value">{formatQuantity(total,3)}</div><div className="stat-note">حسب الفلاتر الحالية</div></article>
    <article className="card stat warning"><div className="stat-label">هالك من العامل</div><div className="stat-value">{formatQuantity(workerTotal,3)}</div><div className="stat-note">مسجل على إنتاج العامل</div></article>
    <article className="card stat accent"><div className="stat-label">هالك عيب صناعة</div><div className="stat-value">{formatQuantity(defectTotal,3)}</div><div className="stat-note">عيب متعلق بعملية التصنيع</div></article>
   </div>
   {has("production.create")&&<form className="card production-form" onSubmit={submit}>
    <div className="card-header"><div><h2 className="card-title">إضافة هالك</h2><span className="form-hint">اختار سجل الإنتاج أولًا عشان نربط الهالك بالعامل والصنف والمرحلة والطلبية.</span></div></div>
    <div className="production-grid">
     <label style={{gridColumn:"1/-1"}}>سجل الإنتاج<SearchableSelect value={entryId} onChange={setEntryId} options={options} placeholder="اختار سجل الإنتاج" searchPlaceholder="ابحث باسم العامل أو الصنف أو كود الإنتاج"/></label>
     {selected&&<div className="form-hint" style={{gridColumn:"1/-1"}}>العامل: {selected.employee_name} · الصنف: {selected.product_name} · المرحلة: {selected.stage_name} · الكمية المسجلة: {formatQuantity(Number(selected.quantity),3)} · التاريخ: {String(selected.work_date).slice(0,10)}</div>}
     <label>نوع الهالك<select value={scrapType} onChange={e=>setScrapType(e.target.value as typeof scrapType)}><option value="WORKER_SCRAP">هالك من العامل</option><option value="MANUFACTURING_DEFECT">هالك عيب صناعة</option></select></label>
     <label>كمية الهالك<input type="number" min="0.001" step="0.001" value={quantity} onChange={e=>setQuantity(e.target.value)} required placeholder="اكتب الكمية"/></label>
     <label style={{gridColumn:"1/-1"}}>ملاحظات / سبب الهالك <span className="optional">(اختياري)</span><input value={notes} onChange={e=>setNotes(e.target.value)} maxLength={1000} placeholder="مثال: تلف أثناء الطباعة أو خطأ تشغيل"/></label>
    </div>
    <div className="form-actions"><button className="primary-button" disabled={busy||!has("production.create")}>{busy?"جارٍ الحفظ…":"تسجيل الهالك"}</button></div>
   </form>}
   <section className="card">
    <div className="card-header"><div><h2 className="card-title">سجل الهالك</h2><span className="form-hint">نسبة السجل = كمية الهالك ÷ كمية الإنتاج المسجلة. التسجيل تحليلي ولا يخصم المخزن مرة ثانية.</span></div></div>
    <div className="filters">
     <label>بحث<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="العامل، الصنف، الطلبية…"/></label>
     <label>من تاريخ<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
     <label>إلى تاريخ<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
     <label>نوع الهالك<select value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="">الكل</option><option value="WORKER_SCRAP">هالك من العامل</option><option value="MANUFACTURING_DEFECT">هالك عيب صناعة</option></select></label>
    </div>
    {loading?<div className="empty-state">جارٍ تحميل السجلات…</div>:visible.length===0?<div className="empty-state">لا توجد سجلات هالك مطابقة للفلاتر.</div>:<div className="table-wrap"><table><thead><tr><th>التاريخ والوقت</th><th>العامل</th><th>الصنف / المرحلة</th><th>الطلبية</th><th>نوع الهالك</th><th>كمية الهالك</th><th>نسبة الهالك</th><th>ملاحظات</th></tr></thead><tbody>{visible.map(x=><tr key={x.id}><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td><td>{x.employee_name}</td><td>{x.product_name}<div className="form-hint">{x.stage_name}</div></td><td>{x.order_name||x.order_code||"—"}</td><td>{x.scrap_type==="WORKER_SCRAP"?"هالك من العامل":"هالك عيب صناعة"}</td><td>{formatQuantity(Number(x.quantity),3)}</td><td>{Number(x.scrap_ratio).toLocaleString("ar-EG",{maximumFractionDigits:2})}%</td><td>{x.notes||"—"}</td></tr>)}</tbody></table></div>}
   </section>
  </section>
 </main></div>;
}
