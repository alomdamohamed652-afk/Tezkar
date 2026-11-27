"use client";

import {useEffect,useState} from "react";
import {api} from "../../lib/api";

type Plan={employee:{id:string;code:string;name:string;isActive:boolean};balance:string;isZero:boolean;direction:"CREDIT"|"DEBIT"|null;amount:string;balanceAfter:string;notice:string;requiresInactiveAcknowledgement:boolean;history:{code:string;direction:string;amount:string;balance_before:string;reason:string;created_at:string}[]};

// Exact 4-decimal text straight from the server; never converted to a JS number for display.
const fmt=(v:string)=>{const neg=v.startsWith("-");const [i,d=""]=(neg?v.slice(1):v).split(".");return (neg?"-":"")+i.replace(/\B(?=(\d{3})+(?!\d))/g,",")+"."+d.padEnd(4,"0")};

export function AdministrativeSettlement({employeeId,onDone,onClose}:{employeeId:string;onDone:()=>void;onClose:()=>void}){
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

 const dirLabel=plan?.direction==="CREDIT"?"إضافة للرصيد (دائن)":"خصم من الرصيد (مدين)";
 return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="تسوية إدارية غير نقدية" onClick={onClose}>
  <div className="modal-card admin-settlement-card" onClick={e=>e.stopPropagation()} style={{padding:0,maxWidth:640,width:"100%",maxHeight:"90vh",overflow:"auto"}}>
   <div style={{padding:"18px 20px 12px",borderBottom:"1px solid var(--border)"}}>
    <h2 style={{margin:0,fontSize:18}}>تسوية إدارية غير نقدية</h2>
    <div className="form-hint" style={{marginTop:6}}>تصفّر رصيد العامل على دفتر المستحقات بقيد واحد. ليست بونصاً ولا خصماً، ولا تلمس الإنتاج ولا الدفعات ولا العهدة النقدية.</div>
   </div>
   <div style={{padding:"16px 20px",display:"grid",gap:14}}>
    {error&&<div className="alert error">{error}</div>}
    {done&&<div className="success-box">تمت التسوية {done.code}: صُفّر رصيد {fmt(done.balanceBefore)} بحركة قيمتها {fmt(done.amount)}. الرصيد الآن 0.0000.</div>}
    {!plan&&!done&&!error&&<div className="empty">جارٍ تحميل رصيد العامل...</div>}
    {plan&&plan.isZero&&<div className="form-hint">رصيد العامل صفر بالفعل، لا يوجد ما يُسوّى.</div>}
    {plan&&!plan.isZero&&<>
     <div className="form-hint" style={{margin:0}}>العامل: <strong>{plan.employee.name} — {plan.employee.code}</strong>{plan.employee.isActive?"":" · غير نشط"}</div>
     <div className="detail-grid" style={{margin:0}}>
      <div><b>الرصيد الحالي</b><span dir="ltr" className="mono" style={{fontWeight:700}}>{fmt(plan.balance)}</span></div>
      <div><b>{dirLabel}</b><span dir="ltr" className="mono" style={{fontWeight:700}}>{fmt(plan.amount)}</span></div>
      <div><b>الرصيد بعد الحفظ</b><span dir="ltr" className="mono" style={{fontWeight:700}}>{fmt(plan.balanceAfter)}</span></div>
     </div>
     <div className="form-hint" style={{margin:0}}>{plan.notice}</div>
     <div className="form-grid" style={{padding:0}}>
      <label style={{gridColumn:"1/-1"}}>السبب (إلزامي، ٥ أحرف على الأقل)<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="مثال: تصحيح زيادة صرف بعد تعديل سجل إنتاج"/></label>
      <label style={{gridColumn:"1/-1"}}>اكتب كود العامل للتأكيد ({plan.employee.code})<input dir="ltr" value={confirmCode} onChange={e=>setConfirmCode(e.target.value)} placeholder={plan.employee.code}/></label>
     </div>
     <label style={{display:"flex",gap:8,alignItems:"center",fontSize:13}}><input type="checkbox" checked={ackNonCash} onChange={e=>setAckNonCash(e.target.checked)}/> أقرّ أنها تسوية دفترية فقط وليست صرفاً نقدياً.</label>
     {plan.requiresInactiveAcknowledgement&&<label style={{display:"flex",gap:8,alignItems:"center",fontSize:13}}><input type="checkbox" checked={ackInactive} onChange={e=>setAckInactive(e.target.checked)}/> العامل غير نشط. أوافق على تسوية حسابه وهو غير نشط (لن يُعاد تفعيله).</label>}
    </>}
    {plan&&plan.history.length>0&&<details><summary className="form-hint" style={{cursor:"pointer"}}>آخر التسويات الإدارية ({plan.history.length})</summary><div className="table-wrap"><table><thead><tr><th>الكود</th><th>الاتجاه</th><th>المبلغ</th><th>الرصيد قبل</th><th>السبب</th><th>التاريخ</th></tr></thead><tbody>
     {plan.history.map(h=><tr key={h.code}><td className="mono">{h.code}</td><td>{h.direction==="CREDIT"?"دائن":"مدين"}</td><td className="mono" dir="ltr">{fmt(h.amount)}</td><td className="mono" dir="ltr">{fmt(h.balance_before)}</td><td>{h.reason}</td><td>{new Date(h.created_at).toLocaleString("ar-EG")}</td></tr>)}
    </tbody></table></div></details>}
   </div>
   <div className="form-actions" style={{padding:"12px 20px",borderTop:"1px solid var(--border)",display:"flex",gap:10,justifyContent:"flex-start"}}>
    {plan&&!plan.isZero&&<button type="button" className="primary-button" disabled={!ready} onClick={submit}>{busy?"جارٍ الحفظ...":"تنفيذ التسوية الإدارية"}</button>}
    <button type="button" className="secondary-btn" onClick={onClose}>{done?"إغلاق":"إلغاء"}</button>
   </div>
  </div>
 </div>;
}
