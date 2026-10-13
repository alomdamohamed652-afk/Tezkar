"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import {formatMoney} from "../../lib/format";

type Request={id:string;code:string;employee_name:string;amount:number;method:string;transfer_reference:string|null;status:string;requested_at:string;rejection_reason:string|null;outstanding_advance_amount?:number;net_paid_amount?:number|null;gross_paid_amount?:number|null;advance_repayment_amount?:number|null};
type CashCustodian={id:string;code:string;full_name:string};
const fallbackMethods:Record<string,string>={CASH:"نقدي",VODAFONE_CASH:"فودافون كاش",INSTAPAY:"إنستا باي",BANK:"تحويل بنكي"};
const statuses:Record<string,string>={PENDING:"قيد المراجعة",APPROVED:"بانتظار الصرف",REJECTED:"مرفوض",PAID:"تم الصرف",CANCELLED:"ملغي"};

export default function PaymentsPage(){
 const { has } = usePermissions();
 const [balance,setBalance]=useState(0),[accountBalance,setAccountBalance]=useState(0),[outstandingAdvanceAmount,setOutstandingAdvanceAmount]=useState(0),[amount,setAmount]=useState(""),[method,setMethod]=useState("CASH"),[transferReference,setTransferReference]=useState(""),[methods,setMethods]=useState<Record<string,string>>(fallbackMethods),[requests,setRequests]=useState<Request[]>([]),[error,setError]=useState(""),[saving,setSaving]=useState(false),[isWorker,setIsWorker]=useState(false);
 const [cashCustodians,setCashCustodians]=useState<CashCustodian[]>([]),[cashCustodyEmployeeId,setCashCustodyEmployeeId]=useState("");
 async function load(){
  try{
   const me=await api<{data:{roleCodes:string[]}}>("/api/auth/me"); const worker=me.data.roleCodes.includes("worker"); setIsWorker(worker);
   const [r,m]=await Promise.all([api<{data:Request[]}>("/api/payment-requests"),api<{data:{code:string;name:string}[]}>("/api/payment-methods")]);
   setRequests(r.data); const map:Record<string,string>={};m.data.forEach(x=>map[x.code]=x.name);setMethods(map);
   try{const cash=await api<{data:CashCustodian[]}>("/api/custodies/eligible-employees");setCashCustodians(cash.data);setCashCustodyEmployeeId(current=>current&&cash.data.some(x=>x.id===current)?current:(cash.data[0]?.id||""))}catch{setCashCustodians([]);setCashCustodyEmployeeId("");}
   if(worker){const b=await api<{data:{balance:number;availableEarnings:number;outstandingAdvanceAmount:number}}>("/api/payments/my-balance");setBalance(b.data.availableEarnings);setAccountBalance(b.data.balance);setOutstandingAdvanceAmount(b.data.outstandingAdvanceAmount);}
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل المدفوعات")}
 }
 useEffect(()=>{void load()},[]);
 async function submit(e:React.FormEvent){e.preventDefault();setSaving(true);setError("");try{await api("/api/payment-requests",{method:"POST",body:JSON.stringify({amount:Number(amount),method,transferReference:transferReference.trim()||null})});setAmount("");setTransferReference("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء طلب القبض")}finally{setSaving(false)}}
 async function action(id:string,a:"approve"|"reject"|"pay"){
  try{
   if(a==="reject"){const reason=window.prompt("سبب الرفض؟");if(!reason)return;await api("/api/payment-requests/"+id+"/reject",{method:"POST",body:JSON.stringify({reason})})}
   else{
    if(!cashCustodyEmployeeId){setError("لازم تختار العهدة النقدية التي سيتم الخصم منها قبل الصرف");return}
    const req=requests.find(x=>x.id===id);
    let advanceRepaymentAmount=0;
    if(Number(req?.outstanding_advance_amount??0)>0){
     const raw=window.prompt("إجمالي السلف المفتوحة: "+formatMoney(Number(req?.outstanding_advance_amount))+" ج.م. الاستقطاع الدوري المستحق يُحسب تلقائيًا. اكتب مبلغ خصم إضافي من السلف (أو 0):","0");
     if(raw===null)return;
     advanceRepaymentAmount=Number(raw.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/,/g,""));
     if(!Number.isFinite(advanceRepaymentAmount)||advanceRepaymentAmount<0){setError("مبلغ خصم السلفة غير صحيح");return}
    }
    await api("/api/payment-requests/"+id+"/"+a,{method:"POST",body:JSON.stringify({cashCustodyEmployeeId,advanceRepaymentAmount})});
   }
   await load()
  }catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ العملية")}
 }
 return <div className="app-shell">
  <Sidebar active="/payments" />
  <main className="main"><header className="topbar"><div><h1 className="page-title">القبض والمدفوعات</h1><p className="page-subtitle">رصيد العامل وطلبات القبض ودورة اعتماد الدفع</p></div></header><section className="content">
   {error&&<div className="alert error">{error}</div>}
   <div className="stats">
    <article className="card stat accent"><div className="stat-label">مستحقات الإنتاج غير المصروفة</div><div className="stat-value">{formatMoney(balance)}</div><div className="stat-note">الإجمالي المتاح قبل خصم السلف</div></article>
    {isWorker&&<article className="card stat"><div className="stat-label">صافي رصيد حسابك</div><div className="stat-value" style={{color:accountBalance<0?"#dc2626":"#15803d"}}>{formatMoney(accountBalance)}</div><div className="stat-note">{accountBalance<0?"الرصيد بالسالب بسبب سلف/تسويات قائمة":"يشمل المستحقات والحركات المسجلة"}</div></article>}
    {isWorker&&<article className="card stat"><div className="stat-label">السلف المفتوحة</div><div className="stat-value">{formatMoney(outstandingAdvanceAmount)}</div><div className="stat-note">الرصيد المتبقي قبل أي خصم جديد</div></article>}
    <article className="card stat"><div className="stat-label">طلبات القبض</div><div className="stat-value">{requests.length}</div><div className="stat-note">حسب صلاحية الحساب الحالي</div></article>
   </div>
   {has("payment_requests.create") && <form className="card payment-form" onSubmit={submit}><div className="card-header"><h2 className="card-title">طلب قبض</h2><span className="form-hint">اكتب إجمالي مستحقات الإنتاج قبل خصم السلف؛ الخصم وصافي الصرف يتحددان عند الصرف الفعلي.</span></div><div className="payment-grid"><label>المبلغ<input type="number" min="0.01" max={balance} step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>طريقة القبض<select value={method} onChange={e=>{setMethod(e.target.value);if(!["VODAFONE_CASH","INSTAPAY","BANK"].includes(e.target.value))setTransferReference("")}}>{Object.entries(methods).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>{["VODAFONE_CASH","INSTAPAY","BANK"].includes(method)&&<label>رقم التحويل / الحساب<input value={transferReference} onChange={e=>setTransferReference(e.target.value)} placeholder="اكتب رقم التحويل أو الحساب" required minLength={3} maxLength={120}/></label>}</div><div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الإرسال...":"إرسال طلب القبض"}</button></div></form>}
   {(has("payment_requests.approve")||has("worker_payments.pay"))&&<section className="card cash-custody-payment-source" style={{marginBottom:16}}><div className="card-header"><div><h2 className="card-title">العهدة التي سيتم الصرف منها</h2><div className="form-hint">عند اعتماد/تسجيل الدفع، سيُنشأ خصم مرتبط بكود طلب القبض داخل دفتر العهدة النقدية، في نفس المعاملة المالية.</div></div></div>{cashCustodians.length?<label>صاحب العهدة النقدية<select value={cashCustodyEmployeeId} onChange={e=>setCashCustodyEmployeeId(e.target.value)}>{cashCustodians.map(x=><option key={x.id} value={x.id}>{x.full_name} — {x.code}</option>)}</select></label>:<div className="alert error">لا توجد عهدة متاحة للصرف. يلزم منح صلاحية تسجيل العهدة النقدية المناسبة لهذا الحساب أو ربط الحساب بموظف يملك عهدة.</div>}</section>}
   <section className="card"><div className="card-header"><h2 className="card-title">طلبات القبض</h2></div>{!requests.length?<div className="empty">لا توجد طلبات.</div>:<div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>إجمالي المستحق</th><th>السلف المفتوحة</th><th>خصم السلف</th><th>صافي المدفوع</th><th>الطريقة</th><th>التاريخ</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{requests.map(r=><tr key={r.id}><td className="mono">{r.code}</td><td className="strong">{r.employee_name}</td><td className="money">{formatMoney(r.amount)}</td><td className="money">{formatMoney(r.outstanding_advance_amount??0)}</td><td className="money">{r.advance_repayment_amount!=null?formatMoney(r.advance_repayment_amount):"يُحسب عند الصرف"}</td><td className="money">{r.net_paid_amount!=null?formatMoney(r.net_paid_amount):"—"}</td><td>{methods[r.method]||fallbackMethods[r.method]||r.method}</td><td>{new Date(r.requested_at).toLocaleString("ar-EG")}</td><td><span className={"status "+r.status.toLowerCase()}>{statuses[r.status]||r.status}</span></td><td>{r.status==="PENDING"&&<div className="row-actions">{has("payment_requests.approve")&&<button className="approve-button" disabled={!cashCustodyEmployeeId} onClick={()=>action(r.id,"approve")}>اعتماد وصرف وخصم العهدة</button>}{has("payment_requests.reject")&&<button className="reject-button" onClick={()=>action(r.id,"reject")}>رفض</button>}</div>}{r.status==="APPROVED"&&has("worker_payments.pay")&&<button className="approve-button" disabled={!cashCustodyEmployeeId} onClick={()=>action(r.id,"pay")}>تسجيل الدفع وخصم العهدة</button>}{r.transfer_reference&&<div className="form-hint">مرجع التحويل: {r.transfer_reference}</div>}</td></tr>)}</tbody></table></div>}</section>
  </section></main></div>
}
