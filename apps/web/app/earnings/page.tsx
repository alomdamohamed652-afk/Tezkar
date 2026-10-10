"use client";

import {FormEvent,useEffect,useMemo,useState} from "react";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";
import {api} from "../../lib/api";

type Summary={total_earned:string;total_paid:string;remaining:string};
type Entry={id:string;code:string;employee_name?:string;employee_code?:string;entry_type:"PRODUCTION_APPROVAL"|"WORKER_PAYMENT"|"ADJUSTMENT";credit_amount:string;debit_amount:string;production_code?:string|null;payment_code?:string|null;created_at:string;notes?:string|null;created_by_username?:string|null};
type Employee={id:string;code:string;name:string};
type Shift={id:string;code:string;name:string};
type Adjustment={id:string;code:string;adjustment_date:string;adjustment_type:"BONUS"|"DEDUCTION";amount:number;reason:string;employee_name:string;employee_code:string;shift_name:string|null;created_by_username?:string|null};

export default function EarningsPage(){
 const {has}=usePermissions();
 const [summary,setSummary]=useState<Summary|null>(null),[entries,setEntries]=useState<Entry[]>([]),[adjustments,setAdjustments]=useState<Adjustment[]>([]);
 const [employees,setEmployees]=useState<Employee[]>([]),[shifts,setShifts]=useState<Shift[]>([]);
 const [employeeId,setEmployeeId]=useState(""),[shiftId,setShiftId]=useState(""),[type,setType]=useState<"BONUS"|"DEDUCTION">("BONUS"),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10));
 const [isWorker,setIsWorker]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
 const [ledgerFilters,setLedgerFilters]=useState({employeeId:"",entryType:"",from:"",to:"",q:""});
 const [adjustmentFilters,setAdjustmentFilters]=useState({employeeId:"",shiftId:"",type:"",from:"",to:"",q:""});

 async function load(){
  setError("");
  try{
   const me=await api<{data:{roleCodes:string[]}}>("/api/auth/me");
   const worker=me.data.roleCodes.includes("worker");setIsWorker(worker);
   const q=new URLSearchParams();if(!worker&&ledgerFilters.employeeId)q.set("employeeId",ledgerFilters.employeeId);if(ledgerFilters.entryType)q.set("entryType",ledgerFilters.entryType);if(ledgerFilters.from)q.set("from",ledgerFilters.from);if(ledgerFilters.to)q.set("to",ledgerFilters.to);if(ledgerFilters.q.trim())q.set("q",ledgerFilters.q.trim());
   const suffix=q.toString()?"?"+q.toString():"";
   if(worker){
    const [s,l]=await Promise.all([api<{data:Summary}>("/api/earnings/my-summary"),api<{data:Entry[]}>("/api/earnings/my-ledger"+suffix)]);
    setSummary(s.data);setEntries(l.data);
   }else{
    const [l,a,e,s]=await Promise.all([
      api<{data:Entry[]}>("/api/earnings"+suffix),
      api<{data:Adjustment[]}>("/api/production/adjustments"+(new URLSearchParams({... (adjustmentFilters.employeeId?{employeeId:adjustmentFilters.employeeId}:{}),...(adjustmentFilters.shiftId?{shiftId:adjustmentFilters.shiftId}:{}),...(adjustmentFilters.type?{adjustmentType:adjustmentFilters.type}:{}),...(adjustmentFilters.from?{from:adjustmentFilters.from}:{}),...(adjustmentFilters.to?{to:adjustmentFilters.to}:{}),...(adjustmentFilters.q.trim()?{q:adjustmentFilters.q.trim()}: {})}).toString()?"?"+new URLSearchParams({... (adjustmentFilters.employeeId?{employeeId:adjustmentFilters.employeeId}:{}),...(adjustmentFilters.shiftId?{shiftId:adjustmentFilters.shiftId}:{}),...(adjustmentFilters.type?{adjustmentType:adjustmentFilters.type}:{}),...(adjustmentFilters.from?{from:adjustmentFilters.from}:{}),...(adjustmentFilters.to?{to:adjustmentFilters.to}:{}),...(adjustmentFilters.q.trim()?{q:adjustmentFilters.q.trim()}: {})}).toString():"")),
      api<{data:Employee[]}>("/api/employees"),
      api<{data:Shift[]}>("/api/shifts")
    ]);
    setEntries(l.data);setAdjustments(a.data);setEmployees(e.data);setShifts(s.data);
   }
  }catch(e){setError(e instanceof Error?e.message:"حدث خطأ أثناء تحميل سجل المستحقات");}
 }
 useEffect(()=>{void load()},[ledgerFilters,adjustmentFilters]);

 async function addAdjustment(e:FormEvent){
  e.preventDefault();setError("");setMessage("");
  try{
   await api("/api/production/adjustments",{method:"POST",body:JSON.stringify({employeeId,shiftId:shiftId||null,adjustmentType:type,amount:Number(amount),reason,adjustmentDate:date})});
   setAmount("");setReason("");setMessage(type==="BONUS"?"تم تسجيل البونص وربطه بدفتر المستحقات":"تم تسجيل الخصم وربطه بدفتر المستحقات");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل البونص أو الخصم")}
 }

 const money=(value:string|number)=>Number(value).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2});
 const totals=useMemo(()=>adjustments.reduce((a,x)=>({bonus:a.bonus+(x.adjustment_type==="BONUS"?Number(x.amount):0),deduction:a.deduction+(x.adjustment_type==="DEDUCTION"?Number(x.amount):0)}),{bonus:0,deduction:0}),[adjustments]);

 return <div className="app-shell"><Sidebar active="/earnings"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">مستحقات العاملين</h1><p className="page-subtitle">{isWorker?"عرض مستحقاتك وحركات القبض الخاصة بك":"الإنتاج، البونص، الخصومات والقبض في دفتر واحد."}</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}{message&&<div className="success-box">{message}</div>}
   {!isWorker&&<section className="card">
    <div className="card-header"><div><h2 className="card-title">بونص / خصم إنتاج</h2><div className="form-hint">كل حركة لازم يكون لها موظف، وردية اختيارية، مبلغ وبيان واضح، وتدخل مباشرة في دفتر مستحقات الموظف.</div></div></div>
    {has("production.adjustments.create")&&<form className="form-grid" onSubmit={addAdjustment}>
      <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.map(x=>({value:x.id,label:x.name,meta:x.code}))} placeholder="اختر الموظف" searchPlaceholder="ابحث باسم الموظف"/></label>
      <label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shifts.map(x=>({value:x.id,label:x.name,meta:x.code}))} placeholder="اختياري" searchPlaceholder="ابحث عن الوردية"/></label>
      <label>نوع الحركة<select value={type} onChange={e=>setType(e.target.value as "BONUS"|"DEDUCTION")}><option value="BONUS">بونص</option><option value="DEDUCTION">خصم</option></select></label>
      <label>المبلغ<input type="number" min="0.01" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required/></label>
      <label>التاريخ<input type="date" value={date} onChange={e=>setDate(e.target.value)} required/></label>
      <label style={{gridColumn:"1/-1"}}>البيان / السبب<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="مثال: بونص جودة — خصم تأخير — مكافأة إنتاج" required/></label>
      <div className="form-actions"><button className="primary-button" disabled={!employeeId||!amount||!reason}>تسجيل الحركة</button></div>
    </form>}
    <div className="stats finance-stats">
      <article className="card stat accent"><div className="stat-label">إجمالي البونص</div><div className="stat-value">{money(totals.bonus)}</div></article>
      <article className="card stat warning"><div className="stat-label">إجمالي الخصومات</div><div className="stat-value">{money(totals.deduction)}</div></article>
    </div>
    <div className="form-grid finance-four-grid" style={{padding:16}}>
     <label>الموظف<select value={adjustmentFilters.employeeId} onChange={e=>setAdjustmentFilters(v=>({...v,employeeId:e.target.value}))}><option value="">كل الموظفين</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
     <label>الوردية<select value={adjustmentFilters.shiftId} onChange={e=>setAdjustmentFilters(v=>({...v,shiftId:e.target.value}))}><option value="">كل الورديات</option>{shifts.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
     <label>نوع الحركة<select value={adjustmentFilters.type} onChange={e=>setAdjustmentFilters(v=>({...v,type:e.target.value}))}><option value="">بونص وخصم</option><option value="BONUS">بونص</option><option value="DEDUCTION">خصم</option></select></label>
     <label>بحث بالكود أو السبب أو الحساب<input value={adjustmentFilters.q} onChange={e=>setAdjustmentFilters(v=>({...v,q:e.target.value}))} placeholder="اسم الموظف أو السبب"/></label>
     <label>من تاريخ<input type="date" value={adjustmentFilters.from} onChange={e=>setAdjustmentFilters(v=>({...v,from:e.target.value}))}/></label><label>إلى تاريخ<input type="date" value={adjustmentFilters.to} onChange={e=>setAdjustmentFilters(v=>({...v,to:e.target.value}))}/></label>
     <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setAdjustmentFilters({employeeId:"",shiftId:"",type:"",from:"",to:"",q:""})}>مسح الفلاتر</button></div>
    </div>
    <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>الوردية</th><th>النوع</th><th>المبلغ</th><th>البيان</th><th>التاريخ</th><th>الحساب المسجّل</th></tr></thead><tbody>
     {adjustments.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.employee_code} — {x.employee_name}</td><td>{x.shift_name||"عام"}</td><td>{x.adjustment_type==="BONUS"?"بونص":"خصم"}</td><td className="money">{money(x.amount)}</td><td>{x.reason}</td><td>{x.adjustment_date}</td><td>{x.created_by_username||"—"}</td></tr>)}{!adjustments.length&&<tr><td colSpan={8}>لا توجد بونصات أو خصومات مطابقة للفلاتر.</td></tr>}
    </tbody></table></div>
   </section>}

   {summary&&<section className="stats finance-stats"><article className="card stat"><div className="stat-label">إجمالي المستحق</div><div className="stat-value">{money(summary.total_earned)}</div></article><article className="card stat"><div className="stat-label">إجمالي المدفوع</div><div className="stat-value">{money(summary.total_paid)}</div></article><article className="card stat accent"><div className="stat-label">المتبقي</div><div className="stat-value">{money(summary.remaining)}</div></article></section>}

   <section className="card"><div className="card-header"><h2 className="card-title">دفتر المستحقات</h2></div>
    <div className="form-grid finance-four-grid" style={{padding:16}}>
     {!isWorker&&<label>الموظف<select value={ledgerFilters.employeeId} onChange={e=>setLedgerFilters(v=>({...v,employeeId:e.target.value}))}><option value="">كل الموظفين</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name} — {x.code}</option>)}</select></label>}
     <label>نوع الحركة<select value={ledgerFilters.entryType} onChange={e=>setLedgerFilters(v=>({...v,entryType:e.target.value}))}><option value="">كل أنواع الحركات</option><option value="PRODUCTION_APPROVAL">اعتماد إنتاج</option><option value="WORKER_PAYMENT">قبض عامل</option><option value="ADJUSTMENT">تسوية / بونص / خصم</option></select></label>
     <label>من تاريخ<input type="date" value={ledgerFilters.from} onChange={e=>setLedgerFilters(v=>({...v,from:e.target.value}))}/></label><label>إلى تاريخ<input type="date" value={ledgerFilters.to} onChange={e=>setLedgerFilters(v=>({...v,to:e.target.value}))}/></label>
     <label>بحث بالكود أو البيان أو الحساب<input value={ledgerFilters.q} onChange={e=>setLedgerFilters(v=>({...v,q:e.target.value}))} placeholder="اسم الموظف أو البيان أو المرجع"/></label>
     <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setLedgerFilters({employeeId:"",entryType:"",from:"",to:"",q:""})}>مسح الفلاتر</button></div>
    </div>
    <div className="table-wrap"><table><thead><tr>{!isWorker&&<th>الموظف</th>}<th>الرقم</th><th>النوع</th><th>إضافة</th><th>خصم</th><th>البيان</th><th>المرجع</th><th>التاريخ</th><th>الحساب المسجّل</th></tr></thead>
    <tbody>{entries.map(entry=><tr key={entry.id}>{!isWorker&&<td>{entry.employee_code} — {entry.employee_name}</td>}<td>{entry.code}</td><td>{entry.entry_type==="PRODUCTION_APPROVAL"?"اعتماد إنتاج":entry.entry_type==="WORKER_PAYMENT"?"قبض عامل":Number(entry.credit_amount)>0?"إضافة مستحق":"خصم"}</td><td>{entry.credit_amount!=="0.0000"?money(entry.credit_amount):"—"}</td><td>{entry.debit_amount!=="0.0000"?money(entry.debit_amount):"—"}</td><td>{entry.notes||"—"}</td><td>{entry.production_code??entry.payment_code??"—"}</td><td>{new Date(entry.created_at).toLocaleString("ar-EG")}</td><td>{entry.created_by_username||"—"}</td></tr>)}{!entries.length&&<tr><td colSpan={isWorker?8:9}>لا توجد حركات مطابقة للفلاتر.</td></tr>}</tbody></table></div>
   </section>
  </section>
 </main></div>;
}
