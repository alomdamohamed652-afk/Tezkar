"use client";

import {useEffect,useState} from "react";
import {api} from "../../lib/api";
import {SearchableSelect} from "../../components/searchable-select";

type Employee={id:string;code:string;name?:string;full_name?:string};
type Plan={employee:{id:string;code:string;name:string;isActive:boolean};balance:string;isZero:boolean;direction:"CREDIT"|"DEBIT"|null;amount:string;balanceAfter:string;notice:string;requiresInactiveAcknowledgement:boolean;history:{code:string;direction:string;amount:string;balance_before:string;reason:string;created_at:string}[]};

// Exact 4-decimal text straight from the server; never converted to a JS number for display.
const fmt=(v:string)=>{const neg=v.startsWith("-");const [i,d=""]=(neg?v.slice(1):v).split(".");return (neg?"-":"")+i.replace(/\B(?=(\d{3})+(?!\d))/g,",")+"."+d.padEnd(4,"0")};

export function AdministrativeSettlement({employees,presetEmployeeId,onDone}:{employees:Employee[];presetEmployeeId?:string;onDone:()=>void}){
 const [employeeId,setEmployeeId]=useState(presetEmployeeId??"");
 const [plan,setPlan]=useState<Plan|null>(null);
 const [reason,setReason]=useState("");
 const [confirmCode,setConfirmCode]=useState("");
 const [ackNonCash,setAckNonCash]=useState(false);
 const [ackInactive,setAckInactive]=useState(false);
 const [key,setKey]=useState(()=>crypto.randomUUID());
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [done,setDone]=useState<{code:string;amount:string;balanceBefore:string}|null>(null);

 useEffect(()=>{
  setPlan(null);setError("");setDone(null);setReason("");setConfirmCode("");setAckNonCash(false);setAckInactive(false);setKey(crypto.randomUUID());
  if(!employeeId)return;
  let alive=true;
  api<{data:Plan}>(`/api/production/earnings/administrative-settlement/${employeeId}`).then(r=>{if(alive)setPlan(r.data)}).catch(e=>{if(alive)setError(e instanceof Error?e.message:"تعذر تحميل رصيد العامل")});
  return ()=>{alive=false};
 },[employeeId]);

 const ready=!!plan&&!plan.isZero&&reason.trim().length>=5&&confirmCode.trim()===plan.employee.code&&ackNonCash&&(!plan.requiresInactiveAcknowledgement||ackInactive)&&!busy;
 async function submit(){
  if(!plan||!ready)return;
  setBusy(true);setError("");
  try{
   const r=await api<{data:{code:string;amount:string;balanceBefore:string}}>("/api/production/earnings/administrative-settlement",{method:"POST",body:JSON.stringify({employeeId:plan.employee.id,expectedBalance:plan.balance,reason:reason.trim(),confirmEmployeeCode:confirmCode.trim(),acknowledgeNonCash:true,acknowledgeInactive:plan.requiresInactiveAcknowledgement?true:undefined,idempotencyKey:key})});
   setDone(r.data);setPlan(null);onDone();
  }catch(e){setError(e instanceof Error?e.message:"تعذرت التسوية الإدارية")}
  finally{setBusy(false)}
 }

 return <section className="card admin-settlement-card" style={{borderInlineStart:"4px solid #b45309"}}>
  <div className="card-header"><div><h2 className="card-title">تسوية إدارية غير نقدية</h2><div className="form-hint">لتصفير رصيد حساب عامل على دفتر المستحقات فقط. ليست بونصاً ولا خصماً مكتسباً، ولا تلمس الإنتاج ولا الدفعات ولا العهدة.</div></div></div>
  <div className="form-grid">
   <label>العامل<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name||x.name||x.code,meta:x.code}))} placeholder="اختر العامل" searchPlaceholder="ابحث بالاسم أو الكود"/></label>
  </div>
  {error&&<div className="alert error">{error}</div>}
  {done&&<div className="success-box">تمت التسوية {done.code}: صُفّر رصيد {fmt(done.balanceBefore)} بحركة قيمتها {fmt(done.amount)}. الرصيد الآن 0.0000.</div>}
  {plan&&plan.isZero&&<div className="form-hint">رصيد العامل صفر بالفعل، لا يوجد ما يُسوّى.</div>}
  {plan&&!plan.isZero&&<div className="form-grid">
   <div style={{gridColumn:"1/-1",display:"grid",gap:8}}>
    <div className="receipt-lines">
     <div>الرصيد الحالي بالضبط: <strong dir="ltr" className="mono">{fmt(plan.balance)}</strong> ج.م {plan.employee.isActive?"":"· (عامل غير نشط)"}</div>
     <div>التسوية المقترحة: <strong>{plan.direction==="CREDIT"?"إضافة للرصيد (دائن)":"خصم من الرصيد (مدين)"}</strong> بمبلغ <strong dir="ltr" className="mono">{fmt(plan.amount)}</strong> ج.م</div>
     <div>الرصيد بعد الحفظ: <strong dir="ltr" className="mono">{fmt(plan.balanceAfter)}</strong> ج.م</div>
    </div>
    <div className="alert">{plan.notice}</div>
   </div>
   <label style={{gridColumn:"1/-1"}}>السبب (إلزامي، ٥ أحرف على الأقل)<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="مثال: رصيد سالب تاريخي من عكس جزئي لدفعة قديمة"/></label>
   <label>اكتب كود العامل للتأكيد ({plan.employee.code})<input dir="ltr" value={confirmCode} onChange={e=>setConfirmCode(e.target.value)} placeholder={plan.employee.code}/></label>
   <label style={{gridColumn:"1/-1",display:"flex",gap:8,alignItems:"center"}}><input type="checkbox" checked={ackNonCash} onChange={e=>setAckNonCash(e.target.checked)}/> أقرّ أنها تسوية دفترية فقط وليست صرف نقدي.</label>
   {plan.requiresInactiveAcknowledgement&&<label style={{gridColumn:"1/-1",display:"flex",gap:8,alignItems:"center"}}><input type="checkbox" checked={ackInactive} onChange={e=>setAckInactive(e.target.checked)}/> العامل غير نشط. أوافق على تسوية حسابه وهو غير نشط (لن يُعاد تفعيله).</label>}
   <div className="form-actions"><button type="button" className="primary-button" disabled={!ready} onClick={submit}>{busy?"جارٍ الحفظ...":"تنفيذ التسوية الإدارية"}</button></div>
  </div>}
  {plan&&plan.history.length>0&&<div className="table-wrap"><table><thead><tr><th>الكود</th><th>الاتجاه</th><th>المبلغ</th><th>الرصيد قبل</th><th>السبب</th><th>التاريخ</th></tr></thead><tbody>
   {plan.history.map(h=><tr key={h.code}><td className="mono">{h.code}</td><td>{h.direction==="CREDIT"?"دائن":"مدين"}</td><td className="mono" dir="ltr">{fmt(h.amount)}</td><td className="mono" dir="ltr">{fmt(h.balance_before)}</td><td>{h.reason}</td><td>{new Date(h.created_at).toLocaleString("ar-EG")}</td></tr>)}
  </tbody></table></div>}
 </section>;
}
