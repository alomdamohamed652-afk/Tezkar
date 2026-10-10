"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Summary={production:{entries:number;quantity:string;earnings:string};stock:{lines:number;quantity:string};earnings:{earned:string;debited:string;balance:string};pendingPayments:number;pendingAdvances:number};
type Audit={id:number;occurred_at:string;action:string;module:string;entity_type:string;username:string|null;employee_name:string|null};
type Production={work_date:string;production_code:string;employee_name:string;product_name:string;stage_name:string;shift_name:string;quantity:number;unit_name:string;earning_amount:number;status:string;created_by_username?:string|null};

export default function ReportsPage(){
  const {has}=usePermissions();
  const canAudit=has("audit.view");
  const [summary,setSummary]=useState<Summary|null>(null);
  const [audit,setAudit]=useState<Audit[]>([]);
  const [production,setProduction]=useState<Production[]>([]);
  const [error,setError]=useState("");
  const [productionFilters,setProductionFilters]=useState({employee:"",product:"",stage:"",status:"",from:"",to:"",q:""});

  useEffect(()=>{(async()=>{
    try{
      const [s,p]=await Promise.all([api<{data:Summary}>("/api/reports/summary"),api<{data:Production[]}>("/api/reports/production")]);
      setSummary(s.data);setProduction(p.data);
      if(canAudit){const a=await api<{data:Audit[]}>("/api/audit-log?limit=100");setAudit(a.data);}
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل التقارير");}
  })()},[canAudit]);

  const n=(x:string|number)=>Number(x||0).toLocaleString("ar-EG",{maximumFractionDigits:2});
  const visibleProduction=useMemo(()=>production.filter(x=>
    (!productionFilters.employee||x.employee_name===productionFilters.employee)&&
    (!productionFilters.product||x.product_name===productionFilters.product)&&
    (!productionFilters.stage||x.stage_name===productionFilters.stage)&&
    (!productionFilters.status||x.status===productionFilters.status)&&
    (!productionFilters.from||x.work_date>=productionFilters.from)&&
    (!productionFilters.to||x.work_date<=productionFilters.to)&&
    (!productionFilters.q||[x.production_code,x.employee_name,x.product_name,x.stage_name,x.shift_name].join(" ").toLowerCase().includes(productionFilters.q.toLowerCase()))
  ),[production,productionFilters]);
  const unique=(key:"employee_name"|"product_name"|"stage_name")=>Array.from(new Set(production.map(x=>x[key]).filter(Boolean))).sort((a,b)=>a.localeCompare(b,"ar"));

  return (
    <div className="app-shell">
      <Sidebar active="/reports"/>
      <main className="main">
        <header className="topbar"><div><h1 className="page-title">التقارير</h1><p className="page-subtitle">التشغيل، المخزون، المستحقات، وسجل العمليات في مكان واحد.</p></div></header>
        <section className="content">
          {error&&<div className="alert error">{error}</div>}
          <div className="stats">
            <article className="card stat"><div className="stat-label">إنتاج اليوم</div><div className="stat-value">{summary?n(summary.production.quantity):"—"}</div><div className="stat-note">{summary?summary.production.entries+" سجل":"جاري التحميل"}</div></article>
            <article className="card stat accent"><div className="stat-label">قيمة المستحقات</div><div className="stat-value">{summary?n(summary.earnings.balance):"—"}</div><div className="stat-note">الصافي الحالي</div></article>
            <article className="card stat warning"><div className="stat-label">رصيد المخزون</div><div className="stat-value">{summary?n(summary.stock.quantity):"—"}</div><div className="stat-note">{summary?summary.stock.lines+" سطر مخزني":"—"}</div></article>
            <article className="card stat neutral"><div className="stat-label">طلبات معلقة</div><div className="stat-value">{summary?summary.pendingPayments+summary.pendingAdvances:"—"}</div><div className="stat-note">قبض + سلف</div></article>
          </div>
          <section className="card"><div className="card-header"><h2 className="card-title">ملخص المستحقات</h2><div className="form-hint">الدفتر يعتمد على اعتماد الإنتاج وتسجيل المدفوعات.</div></div><div className="card-body report-summary-grid"><div><span>إجمالي المكتسب</span><strong>{summary?n(summary.earnings.earned):"—"}</strong></div><div><span>إجمالي المصروف</span><strong>{summary?n(summary.earnings.debited):"—"}</strong></div><div><span>المتبقي</span><strong>{summary?n(summary.earnings.balance):"—"}</strong></div></div></section>
          <section className="card"><div className="card-header"><div><h2 className="card-title">تقرير الإنتاج</h2><div className="form-hint">آخر ١٠٠٠ سجل من الإنتاج المعتمد والمعلق — النتائج المعروضة {visibleProduction.length.toLocaleString("ar-EG")}.</div></div></div>
           <div className="form-grid finance-four-grid" style={{padding:16}}>
            <label>الموظف<select value={productionFilters.employee} onChange={e=>setProductionFilters(v=>({...v,employee:e.target.value}))}><option value="">كل الموظفين</option>{unique("employee_name").map(x=><option key={x} value={x}>{x}</option>)}</select></label>
            <label>المنتج<select value={productionFilters.product} onChange={e=>setProductionFilters(v=>({...v,product:e.target.value}))}><option value="">كل المنتجات</option>{unique("product_name").map(x=><option key={x} value={x}>{x}</option>)}</select></label>
            <label>المرحلة<select value={productionFilters.stage} onChange={e=>setProductionFilters(v=>({...v,stage:e.target.value}))}><option value="">كل المراحل</option>{unique("stage_name").map(x=><option key={x} value={x}>{x}</option>)}</select></label>
            <label>الحالة<select value={productionFilters.status} onChange={e=>setProductionFilters(v=>({...v,status:e.target.value}))}><option value="">كل الحالات</option><option value="PENDING">معلق</option><option value="APPROVED">معتمد</option><option value="REJECTED">مرفوض</option><option value="CANCELLED">ملغي</option></select></label>
            <label>من تاريخ<input type="date" value={productionFilters.from} onChange={e=>setProductionFilters(v=>({...v,from:e.target.value}))}/></label>
            <label>إلى تاريخ<input type="date" value={productionFilters.to} onChange={e=>setProductionFilters(v=>({...v,to:e.target.value}))}/></label>
            <label>بحث بالكود أو الاسم<input value={productionFilters.q} onChange={e=>setProductionFilters(v=>({...v,q:e.target.value}))} placeholder="اسم الموظف أو المنتج أو المرحلة"/></label>
            <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setProductionFilters({employee:"",product:"",stage:"",status:"",from:"",to:"",q:""})}>مسح الفلاتر</button></div>
           </div><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>المنتج</th><th>المرحلة</th><th>الوردية</th><th>الكمية</th><th>المستحق</th><th>الحالة</th><th>الحساب المسجّل</th></tr></thead><tbody>{visibleProduction.map(x=><tr key={x.production_code}><td>{x.work_date}</td><td>{x.employee_name}</td><td>{x.product_name}</td><td>{x.stage_name}</td><td>{x.shift_name}</td><td>{n(x.quantity)} {x.unit_name}</td><td className="money">{n(x.earning_amount)}</td><td>{x.status}</td><td>{x.created_by_username||"—"}</td></tr>)}{!production.length&&<tr><td colSpan={9}>لا يوجد إنتاج مطابق.</td></tr>}</tbody></table></div></section>
          {canAudit&&<section className="card"><div className="card-header"><h2 className="card-title">آخر العمليات</h2></div><div className="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الموظف</th><th>الوحدة</th><th>العملية</th><th>الكيان</th></tr></thead><tbody>{audit.map(x=><tr key={x.id}><td>{new Date(x.occurred_at).toLocaleString("ar-EG")}</td><td>{x.username||"—"}</td><td>{x.employee_name||"—"}</td><td>{x.module}</td><td>{x.action}</td><td>{x.entity_type}</td></tr>)}{!audit.length&&<tr><td colSpan={6}>لا توجد عمليات مسجلة.</td></tr>}</tbody></table></div></section>}
        </section>
      </main>
    </div>
  );
}
