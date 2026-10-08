"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "../../components/sidebar";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
type Summary={total_earned:string;total_paid:string;remaining:string};
type Entry={id:string;code:string;employee_name?:string;employee_code?:string;entry_type:"PRODUCTION_APPROVAL"|"WORKER_PAYMENT"|"ADJUSTMENT";credit_amount:string;debit_amount:string;production_code?:string|null;payment_code?:string|null;created_at:string;notes?:string|null};

async function get<T>(path:string):Promise<T>{
  const response=await fetch(API+path,{credentials:"include",cache:"no-store"});
  const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(body?.error?.message??"تعذر تحميل البيانات");
  return body.data as T;
}

export default function EarningsPage(){
  const [summary,setSummary]=useState<Summary|null>(null);
  const [entries,setEntries]=useState<Entry[]>([]);
  const [isWorker,setIsWorker]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{(async()=>{
    try{
      const me=await get<{roleCodes:string[]}>("/api/auth/me");
      const worker=me.roleCodes.includes("worker");
      setIsWorker(worker);
      if(worker){
        const [s,l]=await Promise.all([get<Summary>("/api/earnings/my-summary"),get<Entry[]>("/api/earnings/my-ledger")]);
        setSummary(s);setEntries(l);
      }else{
        setEntries(await get<Entry[]>("/api/earnings"));
      }
    }catch(e){setError(e instanceof Error?e.message:"حدث خطأ أثناء تحميل سجل المستحقات");}
  })()},[]);

  const money=(value:string)=>Number(value).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2});

  return (
    <div className="app-shell">
      <Sidebar active="/earnings"/>
      <main className="main">
        <header className="settings-header"><div><h1>سجل مستحقات العاملين</h1><p>{isWorker?"عرض مستحقاتك وحركات القبض الخاصة بك":"دفتر الحركات الفعلي للمستحقات"}</p></div><button className="secondary-btn" onClick={()=>window.location.replace("/")}>العودة للوحة التحكم</button></header>
        {error&&<div className="auth-error">{error}</div>}
        {summary&&<section className="settings-grid"><div className="card"><h3>إجمالي المستحق</h3><strong>{money(summary.total_earned)}</strong></div><div className="card"><h3>إجمالي المدفوع</h3><strong>{money(summary.total_paid)}</strong></div><div className="card"><h3>المتبقي</h3><strong>{money(summary.remaining)}</strong></div></section>}
        <section className="card settings-wide">
          <div className="section-title"><h3>الحركات</h3></div>
          <div className="table-wrap"><table className="table"><thead><tr>{!isWorker&&<th>الموظف</th>}<th>الرقم</th><th>النوع</th><th>إضافة</th><th>خصم</th><th>المرجع</th><th>التاريخ</th></tr></thead>
          <tbody>{entries.map(entry=><tr key={entry.id}>{!isWorker&&<td>{entry.employee_code} — {entry.employee_name}</td>}<td>{entry.code}</td><td>{entry.entry_type==="PRODUCTION_APPROVAL"?"اعتماد إنتاج":entry.entry_type==="WORKER_PAYMENT"?"قبض عامل":"تعديل"}</td><td>{entry.credit_amount!=="0.0000"?money(entry.credit_amount):"—"}</td><td>{entry.debit_amount!=="0.0000"?money(entry.debit_amount):"—"}</td><td>{entry.production_code??entry.payment_code??"—"}</td><td>{new Date(entry.created_at).toLocaleString("ar-EG")}</td></tr>)}{!entries.length&&<tr><td colSpan={isWorker?6:7}>لا توجد حركات حتى الآن.</td></tr>}</tbody></table></div>
        </section>
      </main>
    </div>
  );
}
