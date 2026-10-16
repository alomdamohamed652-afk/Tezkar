"use client";

import {FormEvent,useEffect,useMemo,useState} from "react";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {formatMoney} from "../../lib/format";
import {SearchableSelect} from "../../components/searchable-select";
import {api} from "../../lib/api";

type Summary={total_earned:string;total_paid:string;remaining:string};
type Entry={id:string;code:string;employee_name?:string;employee_code?:string;entry_type:"PRODUCTION_APPROVAL"|"WORKER_PAYMENT"|"ADJUSTMENT";credit_amount:string;debit_amount:string;production_code?:string|null;payment_code?:string|null;created_at:string;notes?:string|null};
type Employee={id:string;code:string;name:string};
type Shift={id:string;code:string;name:string};
type Adjustment={id:string;code:string;adjustment_date:string;adjustment_type:"BONUS"|"DEDUCTION";amount:number;reason:string;employee_name:string;employee_code:string;shift_name:string|null};

export default function EarningsPage(){
 const {has}=usePermissions();
 const [summary,setSummary]=useState<Summary|null>(null),[entries,setEntries]=useState<Entry[]>([]),[adjustments,setAdjustments]=useState<Adjustment[]>([]);
 const [employees,setEmployees]=useState<Employee[]>([]),[shifts,setShifts]=useState<Shift[]>([]);
 const [employeeId,setEmployeeId]=useState(""),[shiftId,setShiftId]=useState(""),[type,setType]=useState<"BONUS"|"DEDUCTION">("BONUS"),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10));
 const [isWorker,setIsWorker]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");

 async function load(){
  setError("");
  try{
   const me=await api<{data:{roleCodes:string[]}}>("/api/auth/me");
   const worker=me.data.roleCodes.includes("worker");setIsWorker(worker);
   if(worker){
    const [s,l]=await Promise.all([api<{data:Summary}>("/api/earnings/my-summary"),api<{data:Entry[]}>("/api/earnings/my-ledger")]);
    setSummary(s.data);setEntries(l.data);
   }else{
    const [l,a,e,s]=await Promise.all([
      api<{data:Entry[]}>("/api/earnings"),
      api<{data:Adjustment[]}>("/api/production/adjustments"),
      api<{data:Employee[]}>("/api/employees"),
      api<{data:Shift[]}>("/api/shifts")
    ]);
    setEntries(l.data);setAdjustments(a.data);setEmployees(e.data);setShifts(s.data);
   }
  }catch(e){setError(e instanceof Error?e.message:"حدث خطأ أثناء تحميل سجل المستحقات");}
 }
 useEffect(()=>{void load()},[]);

 async function addAdjustment(e:FormEvent){
  e.preventDefault();setError("");setMessage("");
  try{
   await api("/api/production/adjustments",{method:"POST",body:JSON.stringify({employeeId,shiftId:shiftId||null,adjustmentType:type,amount:Number(amount),reason,adjustmentDate:date})});
   setAmount("");setReason("");setMessage(type==="BONUS"?"تم تسجيل البونص وربطه بدفتر المستحقات":"تم تسجيل الخصم وربطه بدفتر المستحقات");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل البونص أو الخصم")}
 }

 const money=(value:string|number)=>formatMoney(value);
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
    <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>الوردية</th><th>النوع</th><th>المبلغ</th><th>البيان</th><th>التاريخ</th></tr></thead><tbody>
     {adjustments.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td>{x.employee_code} — {x.employee_name}</td><td>{x.shift_name||"عام"}</td><td>{x.adjustment_type==="BONUS"?"بونص":"خصم"}</td><td className="money">{money(x.amount)}</td><td>{x.reason}</td><td>{x.adjustment_date}</td></tr>)}{!adjustments.length&&<tr><td colSpan={7}>لا توجد بونصات أو خصومات مسجلة.</td></tr>}
    </tbody></table></div>
   </section>}

   {summary&&<section className="stats finance-stats"><article className="card stat"><div className="stat-label">إجمالي المستحق</div><div className="stat-value">{money(summary.total_earned)}</div></article><article className="card stat"><div className="stat-label">إجمالي المدفوع</div><div className="stat-value">{money(summary.total_paid)}</div></article><article className="card stat accent"><div className="stat-label">المتبقي</div><div className="stat-value">{money(summary.remaining)}</div></article></section>}

   <section className="card"><div className="card-header"><h2 className="card-title">دفتر المستحقات</h2></div>
    <div className="table-wrap"><table><thead><tr>{!isWorker&&<th>الموظف</th>}<th>الرقم</th><th>النوع</th><th>إضافة</th><th>خصم</th><th>البيان</th><th>المرجع</th><th>التاريخ</th></tr></thead>
    <tbody>{entries.map(entry=><tr key={entry.id}>{!isWorker&&<td>{entry.employee_code} — {entry.employee_name}</td>}<td>{entry.code}</td><td>{entry.entry_type==="PRODUCTION_APPROVAL"?"اعتماد إنتاج":entry.entry_type==="WORKER_PAYMENT"?"قبض عامل":Number(entry.credit_amount)>0?"إضافة مستحق":"خصم"}</td><td>{entry.credit_amount!=="0.0000"?money(entry.credit_amount):"—"}</td><td>{entry.debit_amount!=="0.0000"?money(entry.debit_amount):"—"}</td><td>{entry.notes||"—"}</td><td>{entry.production_code??entry.payment_code??"—"}</td><td>{new Date(entry.created_at).toLocaleString("ar-EG")}</td></tr>)}{!entries.length&&<tr><td colSpan={isWorker?7:8}>لا توجد حركات حتى الآن.</td></tr>}</tbody></table></div>
   </section>
  </section>
 </main></div>;
}
