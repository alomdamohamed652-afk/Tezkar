"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { formatMoney, formatInteger } from "../../lib/format";

type Summary = { production:{entries:number;quantity:string;earnings:string};stock:{lines:number;quantity:string};earnings:{earned:string;debited:string;balance:string};pendingPayments:number;pendingAdvances:number };
type Audit = { id:number;occurred_at:string;action:string;module:string;entity_type:string;username:string|null;employee_name:string|null };
type Production = {
 id:string;work_date:string;production_code:string;employee_id:string;employee_code:string;employee_name:string;
 product_code:string;product_name:string;stage_id:string;stage_name:string;shift_id:string;shift_name:string;
 shift_leader_name:string|null;order_id:string|null;order_code:string|null;order_name:string|null;
 quantity:number|string;unit_name:string;hours_worked:number|string|null;wage_type_code:string|null;wage_type_method:string|null;
 rate_snapshot:number|string;base_earning_amount:number|string;earning_amount:number|string;bonus_amount:number|string;deduction_amount:number|string;
 total_earning_amount:number|string;status:string
};
type EmployeeEarning = { employee_id:string;employee_code:string;employee_name:string;earned:number|string;debited:number|string;balance:number|string;ledger_entries:number;production_entries:number };

const statusLabel:Record<string,string>={PENDING:"معلق",APPROVED:"معتمد",REJECTED:"مرفوض",CANCELLED:"ملغي"};
const methodLabel:Record<string,string>={PER_PIECE:"بالقطعة",PER_1000:"بالألف",PER_DAY:"باليومية / الوردية",PER_HOUR:"بالساعة",PERCENTAGE:"بالنسبة"};

function csvCell(value:unknown){const text=String(value??"");return '"' + text.replace(/"/g,'""') + '"';}
function downloadCsv(filename:string,headers:string[],rows:unknown[][]){
 const content="\uFEFF"+[headers,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n");
 const blob=new Blob([content],{type:"text/csv;charset=utf-8;"});
 const url=URL.createObjectURL(blob);const link=document.createElement("a");
 link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
}

export default function ReportsPage(){
 const {has}=usePermissions();
 const canAudit=has("audit.view");
 const [summary,setSummary]=useState<Summary|null>(null);
 const [audit,setAudit]=useState<Audit[]>([]);
 const [production,setProduction]=useState<Production[]>([]);
 const [allProduction,setAllProduction]=useState<Production[]>([]);
 const [earnings,setEarnings]=useState<EmployeeEarning[]>([]);
 const [allEarnings,setAllEarnings]=useState<EmployeeEarning[]>([]);
 const [tab,setTab]=useState<"production"|"earnings">("production");
 const [from,setFrom]=useState("");
 const [to,setTo]=useState("");
 const [employeeId,setEmployeeId]=useState("");
 const [orderId,setOrderId]=useState("");
 const [stageId,setStageId]=useState("");
 const [shiftId,setShiftId]=useState("");
 const [status,setStatus]=useState("");
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");

 const employees=useMemo(()=>allEarnings.map(x=>({id:x.employee_id,label:x.employee_name,code:x.employee_code})),[allEarnings]);
 const orders=useMemo(()=>{const m=new Map<string,string>();for(const x of allProduction)if(x.order_id)m.set(x.order_id,[x.order_code,x.order_name].filter(Boolean).join(" — ")||"طلبية");return [...m].map(([id,label])=>({id,label})).sort((a,b)=>a.label.localeCompare(b.label,"ar"));},[allProduction]);
 const stages=useMemo(()=>{const m=new Map<string,string>();for(const x of allProduction)m.set(x.stage_id,x.stage_name);return [...m].map(([id,label])=>({id,label})).sort((a,b)=>a.label.localeCompare(b.label,"ar"));},[allProduction]);
 const shifts=useMemo(()=>{const m=new Map<string,string>();for(const x of allProduction)m.set(x.shift_id,x.shift_name);return [...m].map(([id,label])=>({id,label})).sort((a,b)=>a.label.localeCompare(b.label,"ar"));},[allProduction]);

 async function load(initial=false){
  setLoading(true);setError("");
  try{
   const params=new URLSearchParams({limit:"5000"});
   if(from)params.set("from",from);if(to)params.set("to",to);
   if(employeeId)params.set("employeeId",employeeId);
   if(orderId)params.set("orderId",orderId);if(stageId)params.set("stageId",stageId);if(shiftId)params.set("shiftId",shiftId);
   if(status)params.set("status",status);
   const earningParams=new URLSearchParams();if(from)earningParams.set("from",from);if(to)earningParams.set("to",to);if(employeeId)earningParams.set("employeeId",employeeId);
   const [p,e]=await Promise.all([
    api<{data:Production[]}>(`/api/reports/production?${params.toString()}`),
    api<{data:EmployeeEarning[]}>(`/api/reports/employee-earnings${earningParams.toString()?"?"+earningParams.toString():""}`)
   ]);
   setProduction(p.data);setEarnings(e.data);
   if(initial)setAllProduction(p.data);
   if(initial){
    const s=await api<{data:Summary}>("/api/reports/summary");setSummary(s.data);
    if(canAudit){const a=await api<{data:Audit[]}>("/api/audit-log?limit=100");setAudit(a.data);}
   }
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل التقارير");}
  finally{setLoading(false);}
 }

 useEffect(()=>{void load(true);},[]);
 const money=(x:string|number|null|undefined)=>formatMoney(x??0);
 const productionTotal=production.reduce((sum,x)=>sum+Number(x.total_earning_amount??x.earning_amount??0),0);
 const productionQuantity=production.reduce((sum,x)=>sum+Number(x.quantity??0),0);
 const duesTotals=earnings.reduce((sum,x)=>({earned:sum.earned+Number(x.earned),debited:sum.debited+Number(x.debited),balance:sum.balance+Number(x.balance)}),{earned:0,debited:0,balance:0});

 function exportProduction(){
  downloadCsv("tezkar-production-report.csv",
   ["التاريخ","كود الإنتاج","كود العامل","اسم العامل","الطلبية","المنتج","المرحلة","الوردية","مسؤول الوردية","نوع الأجر","الكمية","الوحدة","الساعات","السعر","مستحق الإنتاج","البونص","الخصم","الإجمالي","الحالة"],
   production.map(x=>[x.work_date,x.production_code,x.employee_code,x.employee_name,x.order_code||x.order_name,x.product_name,x.stage_name,x.shift_name,x.shift_leader_name,methodLabel[x.wage_type_method||""]||x.wage_type_code,x.quantity,x.unit_name,x.hours_worked,x.rate_snapshot,x.base_earning_amount,x.bonus_amount,x.deduction_amount,x.total_earning_amount,statusLabel[x.status]||x.status]));
 }
 function exportEarnings(){
  downloadCsv("tezkar-worker-dues-report.csv",["كود العامل","اسم العامل","إجمالي المكتسب","إجمالي الخصومات/المصروف","الرصيد","حركات الدفتر","حركات اعتماد الإنتاج"],
   earnings.map(x=>[x.employee_code,x.employee_name,x.earned,x.debited,x.balance,x.ledger_entries,x.production_entries]));
 }

 return <div className="app-shell">
  <Sidebar active="/reports"/>
  <main className="main">
   <header className="topbar"><div><h1 className="page-title">التقارير</h1><p className="page-subtitle">تقارير تشغيل ومستحقات العمال مع فلاتر وتصدير Excel-compatible CSV.</p></div></header>
   <section className="content">
    {error&&<div className="alert error">{error}</div>}
    <div className="stats">
     <article className="card stat"><div className="stat-label">إنتاج اليوم</div><div className="stat-value">{summary?money(summary.production.quantity):"—"}</div><div className="stat-note">{summary?summary.production.entries+" سجل":"جاري التحميل"}</div></article>
     <article className="card stat accent"><div className="stat-label">صافي دفتر المستحقات</div><div className="stat-value">{summary?money(summary.earnings.balance):"—"}</div><div className="stat-note">يشمل كل الموظفين المسجل لهم دفتر</div></article>
     <article className="card stat warning"><div className="stat-label">رصيد المخزون</div><div className="stat-value">{summary?money(summary.stock.quantity):"—"}</div><div className="stat-note">{summary?summary.stock.lines+" سطر مخزني":"—"}</div></article>
     <article className="card stat neutral"><div className="stat-label">طلبات معلقة</div><div className="stat-value">{summary?summary.pendingPayments+summary.pendingAdvances:"—"}</div><div className="stat-note">طلبات صرف + سلف</div></article>
    </div>
    <section className="card">
     <div className="card-header"><h2 className="card-title">إعداد التقرير</h2><span className="form-hint">اختار فترة أو عامل أو طلبية أو مرحلة أو وردية.</span></div>
     <div className="card-body">
      <div className="form-grid">
       <label className="field"><span>من تاريخ</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
       <label className="field"><span>إلى تاريخ</span><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
       <label className="field"><span>العامل</span><select value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">كل العمال</option>{employees.map(x=><option key={x.id} value={x.id}>{x.label} — {x.code}</option>)}</select></label>
       <label className="field"><span>الطلبية</span><select value={orderId} onChange={e=>setOrderId(e.target.value)}><option value="">كل الطلبيات</option>{orders.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
       <label className="field"><span>المرحلة</span><select value={stageId} onChange={e=>setStageId(e.target.value)}><option value="">كل المراحل</option>{stages.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
       <label className="field"><span>الوردية</span><select value={shiftId} onChange={e=>setShiftId(e.target.value)}><option value="">كل الورديات</option>{shifts.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
       <label className="field"><span>حالة سجل الإنتاج</span><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">كل الحالات عدا الملغي</option><option value="APPROVED">معتمد</option><option value="PENDING">معلق</option><option value="REJECTED">مرفوض</option><option value="CANCELLED">ملغي</option></select></label>
      </div>
      <div className="form-actions"><button className="primary-button" type="button" onClick={()=>void load()} disabled={loading}>{loading?"جاري التحميل…":"عرض التقرير"}</button><button className="secondary-btn" type="button" onClick={()=>{setFrom("");setTo("");setEmployeeId("");setOrderId("");setStageId("");setShiftId("");setStatus("");setTimeout(()=>void load(),0);}}>مسح الفلاتر</button></div>
     </div>
    </section>
    <section className="card">
     <div className="card-header"><div><h2 className="card-title">التقارير التفصيلية</h2><div className="form-hint">الوردية واليومية تظهر تحت نوع الأجر «باليومية / الوردية» عند تسجيل واعتماد الإنتاج.</div></div><div className="form-actions"><button className={tab==="production"?"primary-button":"secondary-btn"} onClick={()=>setTab("production")}>تقرير الإنتاج</button><button className={tab==="earnings"?"primary-button":"secondary-btn"} onClick={()=>setTab("earnings")}>مستحقات كل العمال</button></div></div>
     {tab==="production"?<>
      <div className="card-body report-summary-grid"><div><span>عدد السجلات</span><strong>{formatInteger(production.length)}</strong></div><div><span>إجمالي الكمية</span><strong>{formatInteger(productionQuantity)}</strong></div><div><span>إجمالي قيمة الإنتاج</span><strong>{money(productionTotal)}</strong></div></div>
      <div className="card-header"><span className="form-hint">{loading?"جاري تحديث البيانات":`تم العثور على ${production.length} سجل`}</span><button className="secondary-btn" type="button" onClick={exportProduction} disabled={!production.length}>تصدير تقرير الإنتاج CSV</button></div>
      <div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>العامل</th><th>الطلبية</th><th>المنتج / المرحلة</th><th>الوردية</th><th>نوع الأجر</th><th>الكمية</th><th>الساعات</th><th>الإنتاج</th><th>بونص</th><th>خصم</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>{production.map(x=><tr key={x.id}><td>{String(x.work_date).slice(0,10)}</td><td>{x.employee_name}<div className="form-hint">{x.employee_code}</div></td><td>{x.order_code||x.order_name||"—"}</td><td>{x.product_name}<div className="form-hint">{x.stage_name}</div></td><td>{x.shift_name}</td><td>{methodLabel[x.wage_type_method||""]||x.wage_type_code||"—"}</td><td>{money(x.quantity)} {x.unit_name}</td><td>{x.hours_worked??"—"}</td><td className="money">{money(x.base_earning_amount)}</td><td>{money(x.bonus_amount)}</td><td>{money(x.deduction_amount)}</td><td className="money">{money(x.total_earning_amount)}</td><td>{statusLabel[x.status]||x.status}</td></tr>)}{!production.length&&<tr><td colSpan={13}>{loading?"جاري التحميل…":"لا يوجد إنتاج مطابق للفلاتر."}</td></tr>}</tbody></table></div>
     </>:<>
      <div className="card-body report-summary-grid"><div><span>إجمالي المكتسب</span><strong>{money(duesTotals.earned)}</strong></div><div><span>إجمالي المصروف / الخصومات</span><strong>{money(duesTotals.debited)}</strong></div><div><span>صافي الرصيد</span><strong>{money(duesTotals.balance)}</strong></div></div>
      <div className="card-header"><span className="form-hint">القائمة تشمل الموظفين حتى لو رصيدهم صفر أو لم تسجل لهم حركة مستحقات بعد.</span><button className="secondary-btn" type="button" onClick={exportEarnings} disabled={!earnings.length}>تصدير مستحقات العمال CSV</button></div>
      <div className="table-wrap"><table><thead><tr><th>كود العامل</th><th>اسم العامل</th><th>إجمالي المكتسب</th><th>إجمالي المصروف / الخصومات</th><th>الرصيد الحالي</th><th>حركات الدفتر</th><th>اعتمادات الإنتاج</th></tr></thead><tbody>{earnings.map(x=><tr key={x.employee_id}><td>{x.employee_code}</td><td>{x.employee_name}</td><td className="money">{money(x.earned)}</td><td>{money(x.debited)}</td><td className="money">{money(x.balance)}</td><td>{x.ledger_entries}</td><td>{x.production_entries}</td></tr>)}{!earnings.length&&<tr><td colSpan={7}>{loading?"جاري التحميل…":"لا توجد بيانات."}</td></tr>}</tbody></table></div>
     </>}
    </section>
    {canAudit&&<section className="card"><div className="card-header"><h2 className="card-title">آخر العمليات</h2></div><div className="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الموظف</th><th>الوحدة</th><th>العملية</th><th>الكيان</th></tr></thead><tbody>{audit.map(x=><tr key={x.id}><td>{new Date(x.occurred_at).toLocaleString("ar-EG")}</td><td>{x.username||"—"}</td><td>{x.employee_name||"—"}</td><td>{x.module}</td><td>{x.action}</td><td>{x.entity_type}</td></tr>)}{!audit.length&&<tr><td colSpan={6}>لا توجد عمليات مسجلة.</td></tr>}</tbody></table></div></section>}
   </section>
  </main>
 </div>;
}
