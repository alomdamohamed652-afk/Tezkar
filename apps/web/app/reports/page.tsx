"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { formatMoney, formatInteger } from "../../lib/format";
import * as XLSX from "xlsx";

type Summary = { production:{entries:number;quantity:string;earnings:string};stock:{lines:number;quantity:string};earnings:{earned:string;debited:string;balance:string};pendingPayments:number;pendingAdvances:number };
type Audit = { id:number;occurred_at:string;action:string;module:string;entity_type:string;username:string|null;employee_name:string|null };
type Production = {
 id:string;work_date:string;production_code:string;employee_id:string;employee_code:string;employee_name:string;
 product_code:string;product_name:string;stage_id:string;stage_name:string;shift_id:string;shift_name:string;
 shift_leader_name:string|null;order_id:string|null;order_code:string|null;order_name:string|null;
 quantity:number|string;unit_name:string;hours_worked:number|string|null;wage_type_code:string|null;wage_type_method:string|null;
 rate_snapshot:number|string;base_earning_amount:number|string;earning_amount:number|string;bonus_amount:number|string;deduction_amount:number|string;
 total_earning_amount:number|string;status:string;machine_name?:string|null;scrap_quantity?:number|string;scrap_types?:string;paid_amount?:number|string;remaining_amount?:number|string;payment_status?:string;bonus_total?:number|string;deduction_total?:number|string
};
type EmployeeEarning = { employee_id:string;employee_code:string;employee_name:string;earned:number|string;debited:number|string;balance:number|string;ledger_entries:number;production_entries:number };

const statusLabel:Record<string,string>={PENDING:"معلق",APPROVED:"معتمد",REJECTED:"مرفوض",CANCELLED:"ملغي"};
const methodLabel:Record<string,string>={PER_PIECE:"بالقطعة",PER_1000:"بالألف",PER_DAY:"باليومية / الوردية",PER_HOUR:"بالساعة",PERCENTAGE:"بالنسبة"};

function csvCell(value:unknown){const text=String(value??"");return '"' + text.replace(/"/g,'""') + '"';}

// CSV export metadata is kept in the same UTF-8 file ahead of the detail rows.
function downloadCsv(filename:string,headers:string[],rows:unknown[][],metadata:unknown[][]=[]){
 const content="\uFEFF"+[...metadata,...(metadata.length?[[]]:[]),headers,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n");
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
 const [paymentStatus,setPaymentStatus]=useState("");
 const [groupBy,setGroupBy]=useState("none");
 const [weeklyMode,setWeeklyMode]=useState(false);
 const [groups,setGroups]=useState<Array<{group_name:string;entries:number;quantity:number|string;earnings:number|string;hours:number|string}>>([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState("");
 const filtersInitialized=useRef(false);

 const employees=useMemo(()=>allEarnings.map(x=>({id:x.employee_id,label:x.employee_name,code:x.employee_code})),[allEarnings]);
 const orders=useMemo(()=>{const m=new Map<string,string>();for(const x of allProduction)if(x.order_id)m.set(x.order_id,[x.order_code,x.order_name].filter(Boolean).join(" — ")||"طلبية");return [...m].map(([id,label])=>({id,label})).sort((a,b)=>a.label.localeCompare(b.label,"ar"));},[allProduction]);
 const stages=useMemo(()=>{const m=new Map<string,string>();for(const x of allProduction)m.set(x.stage_id,x.stage_name);return [...m].map(([id,label])=>({id,label})).sort((a,b)=>a.label.localeCompare(b.label,"ar"));},[allProduction]);
 const shifts=useMemo(()=>{const m=new Map<string,string>();for(const x of allProduction)m.set(x.shift_id,x.shift_name);return [...m].map(([id,label])=>({id,label})).sort((a,b)=>a.label.localeCompare(b.label,"ar"));},[allProduction]);

 async function load(initial=false){
  setLoading(true);setError("");
  try{
   const params=new URLSearchParams({limit:"5000",offset:"0",groupBy});
   if(from)params.set("from",from);if(to)params.set("to",to);
   if(employeeId)params.set("employeeId",employeeId);
   if(orderId)params.set("orderId",orderId);if(stageId)params.set("stageId",stageId);if(shiftId)params.set("shiftId",shiftId);
   if(status)params.set("status",status);if(paymentStatus)params.set("paymentStatus",paymentStatus);
   const earningParams=new URLSearchParams();if(from)earningParams.set("from",from);if(to)earningParams.set("to",to);if(employeeId)earningParams.set("employeeId",employeeId);
   const [p,e]=await Promise.all([
    api<{data:Production[];pagination?:{total:number;hasMore:boolean};groups?:Array<{group_name:string;entries:number;quantity:number|string;earnings:number|string;hours:number|string}>}>(`/api/reports/production?${params.toString()}`),
    api<{data:EmployeeEarning[]}>(`/api/reports/employee-earnings${earningParams.toString()?"?"+earningParams.toString():""}`)
   ]);
   let completeRows=p.data;
   let offset=completeRows.length;
   const total=p.pagination?.total??completeRows.length;
   while(offset<total){const nextParams=new URLSearchParams(params);nextParams.set("offset",String(offset));const next=await api<{data:Production[]}>(`/api/reports/production?${nextParams.toString()}`);if(!next.data.length)break;completeRows=completeRows.concat(next.data);offset=completeRows.length;}
   setProduction(completeRows);setEarnings(e.data);setGroups(p.groups??[]);
   if(initial){setAllProduction(completeRows);setAllEarnings(e.data);}
   if(initial){
    const s=await api<{data:Summary}>("/api/reports/summary");setSummary(s.data);
    if(canAudit){const a=await api<{data:Audit[]}>("/api/audit-log?limit=100");setAudit(a.data);}
   }
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل التقارير");}
  finally{setLoading(false);}
 }

 useEffect(()=>{void load(true).finally(()=>{filtersInitialized.current=true;});},[]);
 useEffect(()=>{if(filtersInitialized.current)void load(false);},[from,to,employeeId,orderId,stageId,shiftId,status,paymentStatus,groupBy]);
 const money=(x:string|number|null|undefined)=>formatMoney(x??0);
 const productionTotal=production.reduce((sum,x)=>sum+Number(x.total_earning_amount??x.earning_amount??0),0);
 const scrapTotal=production.reduce((sum,x)=>sum+Number(x.scrap_quantity??0),0);
 const paidTotal=production.reduce((sum,x)=>sum+Number(x.paid_amount??0),0);
 const remainingTotal=production.reduce((sum,x)=>sum+Number(x.remaining_amount??0),0);
 const productionQuantity=production.reduce((sum,x)=>sum+Number(x.quantity??0),0);
 const productionHours=production.reduce((sum,x)=>sum+Number(x.hours_worked??0),0);
 const selectedEmployeeDues=employeeId?earnings.find(x=>x.employee_id===employeeId):undefined;
 const duesTotals=earnings.reduce((sum,x)=>({earned:sum.earned+Number(x.earned),debited:sum.debited+Number(x.debited),balance:sum.balance+Number(x.balance)}),{earned:0,debited:0,balance:0});

 function exportProduction(){
  downloadCsv("tezkar-production-report.csv",
   ["تاريخ العمل","كود الإنتاج","كود العامل","اسم العامل","الطلبية","المنتج","المرحلة","الماكينة / نوع الإنتاج","الوردية","مسؤول الوردية","نوع الأجر","الكمية","الوحدة","الساعات","السعر","مستحق الإنتاج","الهالك","نوع الهالك","المكافآت","الخصومات","إجمالي المستحق","المدفوع المخصص","المتبقي","حالة الدفع","حالة الاعتماد"],
   production.map(x=>[x.work_date,x.production_code,x.employee_code,x.employee_name,x.order_code||x.order_name,x.product_name,x.stage_name,x.machine_name,x.shift_name,x.shift_leader_name,methodLabel[x.wage_type_method||""]||x.wage_type_code,x.quantity,x.unit_name,x.hours_worked,x.rate_snapshot,x.base_earning_amount,x.scrap_quantity,x.scrap_types,x.bonus_total??x.bonus_amount,x.deduction_total??x.deduction_amount,x.total_earning_amount,x.paid_amount,x.remaining_amount,x.payment_status,statusLabel[x.status]||x.status]),
   [["الفترة",from||"غير محدد",to||"غير محدد"],["العامل",employeeId||"الكل"],["الطلبية",orderId||"الكل"],["المرحلة",stageId||"الكل"],["الوردية",shiftId||"الكل"],["الحالة",status||"الكل"],["حالة الدفع",paymentStatus||"الكل"],["تاريخ الإنشاء",new Date().toLocaleString("ar-EG")]]);
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
       <label className="field"><span>نوع التقرير</span><select value={weeklyMode?"weekly":"daily"} onChange={e=>{const weekly=e.target.value==="weekly";setWeeklyMode(weekly);if(weekly){const d=from?new Date(from+"T00:00:00"):new Date();const day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);const start=d.toISOString().slice(0,10);const end=new Date(d);end.setDate(end.getDate()+6);setFrom(start);setTo(end.toISOString().slice(0,10));}else{const today=new Date().toISOString().slice(0,10);setFrom(today);setTo(today);}}}><option value="daily">تقرير شغل اليوم</option><option value="weekly">التقرير الأسبوعي</option></select></label>
       <label className="field"><span>تجميع التقرير</span><select value={groupBy} onChange={e=>setGroupBy(e.target.value)}><option value="none">تفصيلي</option><option value="day">حسب اليوم</option><option value="employee">حسب العامل</option><option value="machine">حسب الماكينة / نوع الإنتاج</option><option value="order">حسب الطلبية</option><option value="shift">حسب الوردية</option></select></label>
       <label className="field"><span>حالة الدفع</span><select value={paymentStatus} onChange={e=>setPaymentStatus(e.target.value)}><option value="">كل الحالات</option><option value="PAID">مدفوع</option><option value="PARTIAL">مدفوع جزئيًا</option><option value="UNPAID">غير مدفوع</option><option value="UNALLOCATED">دفعة تاريخية غير موزعة</option></select></label>
       <label className="field"><span>من تاريخ</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
       <label className="field"><span>إلى تاريخ</span><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
       <label className="field"><span>العامل</span><select value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">كل العمال</option>{employees.map(x=><option key={x.id} value={x.id}>{x.label} — {x.code}</option>)}</select></label>
       <label className="field"><span>الطلبية</span><select value={orderId} onChange={e=>setOrderId(e.target.value)}><option value="">كل الطلبيات</option>{orders.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
       <label className="field"><span>المرحلة</span><select value={stageId} onChange={e=>setStageId(e.target.value)}><option value="">كل المراحل</option>{stages.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
       <label className="field"><span>الوردية</span><select value={shiftId} onChange={e=>setShiftId(e.target.value)}><option value="">كل الورديات</option>{shifts.map(x=><option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
       <label className="field"><span>حالة سجل الإنتاج</span><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">كل الحالات عدا الملغي</option><option value="APPROVED">معتمد</option><option value="PENDING">معلق</option><option value="REJECTED">مرفوض</option><option value="CANCELLED">ملغي</option></select></label>
      </div>
      <div className="form-actions"><button className="secondary-btn" type="button" onClick={()=>{const today=new Date().toLocaleDateString("en-CA");setWeeklyMode(false);setFrom(today);setTo(today);}}>اليوم الحالي</button><button className="primary-button" type="button" onClick={()=>void load()} disabled={loading}>{loading?"جاري تحديث التقرير…":"تحديث التقرير الآن"}</button><button className="secondary-btn" type="button" onClick={()=>{setFrom("");setTo("");setEmployeeId("");setOrderId("");setStageId("");setShiftId("");setStatus("");setPaymentStatus("");setGroupBy("none");}}>مسح الفلاتر</button></div>
      <div className="report-summary-grid filter-live-summary"><div><span>إجمالي قيمة الإنتاج المطابق للفلاتر</span><strong>{money(productionTotal)}</strong></div><div><span>إجمالي الكمية</span><strong>{formatInteger(productionQuantity)}</strong></div><div><span>عدد السجلات</span><strong>{formatInteger(production.length)}</strong></div><div><span>إجمالي ساعات العمل</span><strong>{formatInteger(productionHours)}</strong></div><div><span>إجمالي الهالك</span><strong>{formatInteger(scrapTotal)}</strong></div><div><span>المدفوع المخصص</span><strong>{money(paidTotal)}</strong></div><div><span>المتبقي</span><strong>{money(remainingTotal)}</strong></div>{selectedEmployeeDues&&<div><span>رصيد مستحقات العامل المختار</span><strong>{money(selectedEmployeeDues.balance)}</strong></div>}<div className="filter-summary-note">{loading?"جاري حساب الإجمالي للفلاتر المختارة…":"الإجمالي بيتحدّث تلقائيًا مع تغيير أي فلتر."}</div></div>
     </div>
    </section>
    <section className="card">
     <div className="card-header"><div><h2 className="card-title">التقارير التفصيلية</h2><div className="form-hint">الوردية واليومية تظهر تحت نوع الأجر «باليومية / الوردية» عند تسجيل واعتماد الإنتاج.</div></div><div className="form-actions"><button className={tab==="production"?"primary-button":"secondary-btn"} onClick={()=>setTab("production")}>تقرير الإنتاج</button><button className={tab==="earnings"?"primary-button":"secondary-btn"} onClick={()=>setTab("earnings")}>مستحقات كل العمال</button></div></div>
     {tab==="production"?<>
      <div className="card-body report-summary-grid"><div><span>عدد السجلات</span><strong>{formatInteger(production.length)}</strong></div><div><span>إجمالي الكمية</span><strong>{formatInteger(productionQuantity)}</strong></div><div><span>إجمالي قيمة الإنتاج</span><strong>{money(productionTotal)}</strong></div></div>
      <div className="card-header"><span className="form-hint">{loading?"جاري تحديث البيانات":`تم العثور على ${production.length} سجل`}</span><button className="secondary-btn" type="button" onClick={exportProduction} disabled={!production.length}>تصدير تقرير الإنتاج CSV</button><button className="secondary-btn" type="button" onClick={()=>window.print()}>طباعة / حفظ PDF</button><button className="secondary-btn" type="button" onClick={()=>{const wb=XLSX.utils.book_new();const ws=XLSX.utils.json_to_sheet(production.map(x=>({"التاريخ":x.work_date,"كود الإنتاج":x.production_code,"العامل":x.employee_name,"الطلبية":x.order_code||x.order_name,"المرحلة":x.stage_name,"الماكينة":x.machine_name,"الوردية":x.shift_name,"مسؤول الوردية":x.shift_leader_name,"الكمية":x.quantity,"الوحدة":x.unit_name,"الساعات":x.hours_worked,"الأجر":x.base_earning_amount,"الهالك":x.scrap_quantity,"نوع الهالك":x.scrap_types,"المكافآت":x.bonus_total??x.bonus_amount,"الخصومات":x.deduction_total??x.deduction_amount,"الإجمالي":x.total_earning_amount,"المدفوع":x.paid_amount,"المتبقي":x.remaining_amount,"حالة الدفع":x.payment_status,"الحالة":statusLabel[x.status]||x.status})));ws["!rtl"]=true;XLSX.utils.book_append_sheet(wb,ws,"تقرير الإنتاج");XLSX.writeFile(wb,"tezkar-production-report.xlsx");}} disabled={!production.length}>تصدير Excel</button></div>
      {groups.length>0&&<div className="card-body"><h3 className="card-title">ملخص التجميع</h3><div className="table-wrap"><table><thead><tr><th>التجميع</th><th>عدد السجلات</th><th>إجمالي الكمية</th><th>الساعات</th><th>قيمة المستحق</th></tr></thead><tbody>{groups.map(g=><tr key={g.group_name}><td>{g.group_name}</td><td>{formatInteger(g.entries)}</td><td>{formatInteger(g.quantity)}</td><td>{formatInteger(g.hours)}</td><td>{money(g.earnings)}</td></tr>)}</tbody></table></div></div>}
      <div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>العامل</th><th>الطلبية</th><th>المنتج / المرحلة</th><th>الوردية</th><th>نوع الأجر</th><th>الكمية</th><th>الساعات</th><th>الإنتاج</th><th>الهالك</th><th>بونص</th><th>خصم</th><th>الإجمالي</th><th>مدفوع</th><th>متبقي</th><th>حالة الدفع</th><th>الحالة</th></tr></thead><tbody>{production.map(x=><tr key={x.id}><td>{String(x.work_date).slice(0,10)}</td><td>{x.employee_name}<div className="form-hint">{x.employee_code}</div></td><td>{x.order_code||x.order_name||"—"}</td><td>{x.product_name}<div className="form-hint">{x.stage_name}</div></td><td>{x.shift_name}</td><td>{methodLabel[x.wage_type_method||""]||x.wage_type_code||"—"}</td><td>{money(x.quantity)} {x.unit_name}</td><td>{x.hours_worked??"—"}</td><td className="money">{money(x.base_earning_amount)}</td><td>{formatInteger(x.scrap_quantity??0)} <span className="form-hint">{x.scrap_types||""}</span></td><td>{money(x.bonus_total??x.bonus_amount)}</td><td>{money(x.deduction_total??x.deduction_amount)}</td><td className="money">{money(x.total_earning_amount)}</td><td>{money(x.paid_amount)}</td><td>{money(x.remaining_amount)}</td><td>{x.payment_status==="PAID"?"مدفوع":x.payment_status==="PARTIAL"?"مدفوع جزئيًا":x.payment_status==="UNALLOCATED"?"دفعة تاريخية غير موزعة":"غير مدفوع"}</td><td>{statusLabel[x.status]||x.status}</td></tr>)}{!production.length&&<tr><td colSpan={17}>{loading?"جاري التحميل…":"لا يوجد إنتاج مطابق للفلاتر."}</td></tr>}</tbody></table></div>
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


