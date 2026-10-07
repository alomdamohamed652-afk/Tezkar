"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";

type Request={id:string;code:string;employee_name:string;amount:number;method:string;status:string;requested_at:string;rejection_reason:string|null};
const fallbackMethods:Record<string,string>={CASH:"نقدي",VODAFONE_CASH:"فودافون كاش",INSTAPAY:"إنستا باي",BANK:"تحويل بنكي"};
const statuses:Record<string,string>={PENDING:"قيد المراجعة",APPROVED:"معتمد",REJECTED:"مرفوض",PAID:"تم الدفع",CANCELLED:"ملغي"};

export default function PaymentsPage(){
 const [balance,setBalance]=useState(0),[amount,setAmount]=useState(""),[method,setMethod]=useState("CASH"),[methods,setMethods]=useState<Record<string,string>>(fallbackMethods),[requests,setRequests]=useState<Request[]>([]),[error,setError]=useState(""),[saving,setSaving]=useState(false),[isWorker,setIsWorker]=useState(false);
 async function load(){
  try{
   const me=await api<{data:{roleCodes:string[]}}>("/api/auth/me"); const worker=me.data.roleCodes.includes("worker"); setIsWorker(worker);
   const [r,m]=await Promise.all([api<{data:Request[]}>("/api/payment-requests"),api<{data:{code:string;name:string}[]}>("/api/payment-methods")]);
   setRequests(r.data); const map:Record<string,string>={};m.data.forEach(x=>map[x.code]=x.name);setMethods(map);
   if(worker){const b=await api<{data:{balance:number}}>("/api/payments/my-balance");setBalance(b.data.balance);}
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل المدفوعات")}
 }
 useEffect(()=>{void load()},[]);
 async function submit(e:React.FormEvent){e.preventDefault();setSaving(true);setError("");try{await api("/api/payment-requests",{method:"POST",body:JSON.stringify({amount:Number(amount),method})});setAmount("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء طلب القبض")}finally{setSaving(false)}}
 async function action(id:string,a:"approve"|"reject"|"pay"){try{if(a==="reject"){const reason=window.prompt("سبب الرفض؟");if(!reason)return;await api("/api/payment-requests/"+id+"/reject",{method:"POST",body:JSON.stringify({reason})})}else await api("/api/payment-requests/"+id+"/"+a,{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ العملية")}}
 return <div className="app-shell">
  <aside className="sidebar"><div className="brand"><div className="brand-mark"/><div className="brand-copy"><div className="brand-name">تيزكار</div><div className="brand-sub">إدارة المصنع</div></div></div><div className="nav-title">النظام</div><nav className="nav">
   <a className="nav-item" href="/"><span className="nav-icon">⌂</span><span>الرئيسية</span></a><a className="nav-item" href="/employees"><span className="nav-icon">▣</span><span>الموظفون</span></a><a className="nav-item" href="/production"><span className="nav-icon">▤</span><span>الإنتاج</span></a><a className="nav-item active" href="/payments"><span className="nav-icon">₤</span><span>القبض والمدفوعات</span></a><a className="nav-item" href="/master-data"><span className="nav-icon">⚙</span><span>البيانات الأساسية</span></a>
  </nav></aside>
  <main className="main"><header className="topbar"><div><h1 className="page-title">القبض والمدفوعات</h1><p className="page-subtitle">رصيد العامل وطلبات القبض ودورة اعتماد الدفع</p></div></header><section className="content">
   {error&&<div className="alert error">{error}</div>}
   <div className="stats"><article className="card stat accent"><div className="stat-label">المستحق المتاح</div><div className="stat-value">{balance.toFixed(2)}</div><div className="stat-note">الإنتاج المعتمد − ما تم دفعه</div></article><article className="card stat"><div className="stat-label">طلبات القبض</div><div className="stat-value">{requests.length}</div><div className="stat-note">حسب صلاحية الحساب الحالي</div></article></div>
   <form className="card payment-form" onSubmit={submit}><div className="card-header"><h2 className="card-title">طلب قبض</h2><span className="form-hint">لا يمكن طلب مبلغ أكبر من المستحق المتاح</span></div><div className="payment-grid"><label>المبلغ<input type="number" min="0.01" max={balance} step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></label><label>طريقة القبض<select value={method} onChange={e=>setMethod(e.target.value)}>{Object.entries(methods).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label></div><div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ الإرسال...":"إرسال طلب القبض"}</button></div></form>
   <section className="card"><div className="card-header"><h2 className="card-title">طلبات القبض</h2></div>{!requests.length?<div className="empty">لا توجد طلبات.</div>:<div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>المبلغ</th><th>الطريقة</th><th>التاريخ</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{requests.map(r=><tr key={r.id}><td className="mono">{r.code}</td><td className="strong">{r.employee_name}</td><td className="money">{r.amount}</td><td>{methods[r.method]||fallbackMethods[r.method]||r.method}</td><td>{new Date(r.requested_at).toLocaleString("ar-EG")}</td><td><span className={"status "+r.status.toLowerCase()}>{statuses[r.status]||r.status}</span></td><td>{!isWorker&&r.status==="PENDING"&&<div className="row-actions"><button className="approve-button" onClick={()=>action(r.id,"approve")}>اعتماد</button><button className="reject-button" onClick={()=>action(r.id,"reject")}>رفض</button></div>}{!isWorker&&r.status==="APPROVED"&&<button className="approve-button" onClick={()=>action(r.id,"pay")}>تسجيل الدفع</button>}</td></tr>)}</tbody></table></div>}</section>
  </section></main></div>
}
