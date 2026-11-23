"use client";

import Link from "next/link";
import {useCallback,useEffect,useState} from "react";
import {Sidebar,usePermissions} from "../../../components/sidebar";
import {api} from "../../../lib/api";

type Finding={employeeId?:string|null;employeeCode?:string|null;employeeName?:string|null;reference?:string|null;amount:string;detail:string};
type Check={code:string;title:string;severity:"high"|"medium"|"low";explanation:string;proposal:string;findings:Finding[]};
type Report={generatedAt:string;readOnly:boolean;totals:{checks:number;issues:number;highSeverityIssues:number};checks:Check[]};

const severityLabel={high:"عالية",medium:"متوسطة",low:"منخفضة"} as const;
const severityColor={high:"#b91c1c",medium:"#b45309",low:"#475569"} as const;
// Checks whose finding can be closed with the administrative non-cash settlement on the worker account.
const settleable=new Set(["NEGATIVE_BALANCE","ROUNDING_DRIFT"]);

export default function AccountHealthPage(){
 const {has}=usePermissions();
 const [report,setReport]=useState<Report|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(false);
 const run=useCallback(async()=>{
  setLoading(true);setError("");
  try{setReport((await api<{data:Report}>("/api/admin/account-health")).data)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تشغيل الفحص")}
  finally{setLoading(false)}
 },[]);
 useEffect(()=>{void run()},[run]);
 const canSettle=has("earnings.administrative_settlement.create");
 return <div className="app-shell"><Sidebar active="/admin/account-health"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">فحص صحة الحسابات</h1><p className="page-subtitle">فحص للقراءة فقط: يكتشف المشاكل ويقترح الحل، ولا يصلح أي شيء تلقائياً.</p></div>
   <button className="primary-button" onClick={run} disabled={loading}>{loading?"جارٍ الفحص...":"إعادة الفحص"}</button></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   {report&&<>
    <section className="stats finance-stats">
     <article className="card stat"><div className="stat-label">عدد الفحوصات</div><div className="stat-value">{report.totals.checks}</div></article>
     <article className="card stat warning"><div className="stat-label">إجمالي المشاكل</div><div className="stat-value">{report.totals.issues}</div></article>
     <article className="card stat accent"><div className="stat-label">مشاكل عالية الخطورة</div><div className="stat-value">{report.totals.highSeverityIssues}</div></article>
    </section>
    <div className="form-hint">آخر فحص: {new Date(report.generatedAt).toLocaleString("ar-EG")}</div>
    {report.checks.map(c=><section className="card" key={c.code} style={{borderInlineStart:`4px solid ${c.findings.length?severityColor[c.severity]:"#15803d"}`}}>
     <div className="card-header"><div><h2 className="card-title">{c.title} <span style={{fontSize:13,color:c.findings.length?severityColor[c.severity]:"#15803d"}}>{c.findings.length?`${c.findings.length} حالة · خطورة ${severityLabel[c.severity]}`:"سليم ✓"}</span></h2>
      <div className="form-hint">{c.explanation}</div></div></div>
     {c.findings.length>0&&<>
      <div className="alert">الحل المقترح: {c.proposal}</div>
      <div className="table-wrap"><table><thead><tr><th>العامل</th><th>المرجع</th><th>المبلغ</th><th>التفاصيل</th>{canSettle&&settleable.has(c.code)&&<th></th>}</tr></thead><tbody>
       {c.findings.map((f,i)=><tr key={i}><td>{f.employeeCode?`${f.employeeCode} — ${f.employeeName??""}`:"—"}</td><td className="mono">{f.reference??"—"}</td><td className="mono" dir="ltr">{f.amount}</td><td>{f.detail}</td>
        {canSettle&&settleable.has(c.code)&&<td>{f.employeeId&&<Link className="secondary-button" href={`/earnings?settle=${f.employeeId}`}>تسوية إدارية</Link>}</td>}</tr>)}
      </tbody></table></div></>}
    </section>)}
    <section className="card"><div className="form-hint">فحص دوري تلقائي (اختياري لاحقاً): الفحص كله استعلامات قراءة فقط ويمكن جدولته يومياً ليلاً وإرسال ملخص عند وجود مشاكل عالية الخطورة.</div></section>
   </>}
  </section></main></div>;
}
