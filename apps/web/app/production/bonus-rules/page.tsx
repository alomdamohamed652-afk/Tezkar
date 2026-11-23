"use client";

import {useCallback,useEffect,useState} from "react";
import {Sidebar,usePermissions} from "../../../components/sidebar";
import {api} from "../../../lib/api";

type Rule={id:string;name:string;stage_id:string;stage_name:string;product_id:string|null;scope:string;min_quantity:string;bonus_amount:string;description:string;is_active:boolean};
type Stage={id:string;name:string};
const blank={name:"",stageId:"",minQuantity:"",bonusAmount:"",description:""};

export default function BonusRulesPage(){
 const {has}=usePermissions();
 const canManage=has("production.bonus_rules.manage");
 const [rules,setRules]=useState<Rule[]>([]);
 const [stages,setStages]=useState<Stage[]>([]);
 const [form,setForm]=useState(blank);
 const [error,setError]=useState("");
 const [saving,setSaving]=useState(false);
 const load=useCallback(async()=>{
  try{
   const [r,s]=await Promise.all([api<{data:Rule[]}>("/api/production/bonus-rules"),api<{data:Stage[]}>("/api/stages")]);
   setRules(r.data);setStages(s.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر التحميل")}
 },[]);
 useEffect(()=>{void load()},[load]);
 async function create(){
  setError("");setSaving(true);
  try{
   await api("/api/production/bonus-rules",{method:"POST",body:JSON.stringify({name:form.name,stageId:form.stageId,minQuantity:Number(form.minQuantity),bonusAmount:Number(form.bonusAmount),description:form.description})});
   setForm(blank);await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر الحفظ")}
  finally{setSaving(false)}
 }
 async function toggle(r:Rule){
  try{await api(`/api/production/bonus-rules/${r.id}`,{method:"PATCH",body:JSON.stringify({isActive:!r.is_active})});await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر التعديل")}
 }
 async function remove(r:Rule){
  if(!confirm(`حذف قاعدة "${r.name}"؟ البونص اللي اتضاف قبل كده مش هيتأثر.`))return;
  try{await api(`/api/production/bonus-rules/${r.id}`,{method:"DELETE"});await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر الحذف")}
 }
 const valid=form.name.trim().length>=2&&form.stageId&&Number(form.minQuantity)>0&&Number(form.bonusAmount)>0&&form.description.trim().length>=2;
 return <div className="app-shell"><Sidebar active="/production/bonus-rules"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">قواعد البونص التلقائي</h1><p className="page-subtitle">لو سجل إنتاج واحد وصل للكمية في المرحلة، بيتضاف البونص فوراً كتسوية عادية يقدر الأدمن يعدلها أو يحذفها.</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   {canManage&&<section className="card"><div className="card-header"><h2 className="card-title">قاعدة جديدة</h2></div>
    <div className="form-grid">
     <label>اسم القاعدة<input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="مثال: بونص ١٥٠٠ قطعة"/></label>
     <label>المرحلة<select value={form.stageId} onChange={e=>setForm({...form,stageId:e.target.value})}><option value="">اختر المرحلة</option>{stages.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
     <label>الكمية في السجل الواحد (على الأقل)<input dir="ltr" inputMode="decimal" value={form.minQuantity} onChange={e=>setForm({...form,minQuantity:e.target.value})} placeholder="1500"/></label>
     <label>مبلغ البونص (جنيه)<input dir="ltr" inputMode="decimal" value={form.bonusAmount} onChange={e=>setForm({...form,bonusAmount:e.target.value})} placeholder="50"/></label>
     <label style={{gridColumn:"1/-1"}}>البيان (يظهر في تسويات العامل)<input value={form.description} onChange={e=>setForm({...form,description:e.target.value})} placeholder="مثال: بونص إنتاج ١٥٠٠ قطعة"/></label>
    </div>
    <button className="primary-button" onClick={create} disabled={!valid||saving}>{saving?"جارٍ الحفظ...":"حفظ القاعدة"}</button>
   </section>}
   <section className="card"><div className="table-wrap"><table><thead><tr><th>القاعدة</th><th>المرحلة</th><th>الكمية</th><th>البونص</th><th>البيان</th><th>الحالة</th>{canManage&&<th></th>}</tr></thead><tbody>
    {rules.map(r=><tr key={r.id}><td>{r.name}</td><td>{r.stage_name}</td><td className="mono" dir="ltr">≥ {Number(r.min_quantity)}</td><td className="mono" dir="ltr">{Number(r.bonus_amount)}</td><td>{r.description}</td><td>{r.is_active?"مفعّلة":"موقوفة"}</td>
     {canManage&&<td><button className="secondary-button" onClick={()=>toggle(r)}>{r.is_active?"إيقاف":"تفعيل"}</button> <button className="secondary-button" onClick={()=>remove(r)}>حذف</button></td>}</tr>)}
    {!rules.length&&<tr><td colSpan={7}>لا توجد قواعد بعد</td></tr>}
   </tbody></table></div></section>
  </section></main></div>;
}
