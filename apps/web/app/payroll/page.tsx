"use client";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Employee={id:string;code:string;full_name:string;department_name:string|null;is_active:boolean;salary_profile_id:string|null;monthly_salary:string|number|null;effective_from:string|null};
type PayrollItem={id:string;employee_id:string;employee_code:string;employee_name:string;department_name:string|null;base_salary:string|number;bonus_amount:string|number;deduction_amount:string|number;deduction_mode?:"FIXED"|"PERCENTAGE";deduction_percentage?:string|number|null;deduction_basis?:"BASE_SALARY"|"BASE_PLUS_BONUS";net_amount:string|number;paid_amount:string|number;remaining_amount:string|number;status:string;notes:string|null};
type PayrollData={period:{id:string;period_month:string;status:string}|null;items:PayrollItem[];totals:{employees:number;net:number;paid:number;remaining:number}};
type PayrollPayment={id:string;amount:string|number;payment_date:string;payment_method:string|null;reference:string|null;notes:string|null;paid_by_username:string|null;created_at:string};
const paymentMethodLabel:Record<string,string>={CASH:"نقدي",BANK_TRANSFER:"تحويل بنكي",WALLET:"محفظة إلكترونية",OTHER:"أخرى"};
const money=(v:string|number)=>Number(v||0).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2});
const monthNow=()=>new Date().toISOString().slice(0,7);
const today=()=>new Date().toISOString().slice(0,10);
const periodStatus:Record<string,string>={DRAFT:"مسودة",APPROVED:"معتمد",CLOSED:"مغلق"};
const itemStatus:Record<string,string>={UNPAID:"لم يُصرف",PARTIAL:"صرف جزئي",PAID:"مدفوع بالكامل"};
export default function PayrollPage(){
 const {has}=usePermissions();
 const [employees,setEmployees]=useState<Employee[]>([]),[payroll,setPayroll]=useState<PayrollData>({period:null,items:[],totals:{employees:0,net:0,paid:0,remaining:0}});
 const [month,setMonth]=useState(monthNow()),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [employeeId,setEmployeeId]=useState(""),[monthlySalary,setMonthlySalary]=useState(""),[effectiveFrom,setEffectiveFrom]=useState(today()),[salaryNotes,setSalaryNotes]=useState("");
 const [adjustments,setAdjustments]=useState<Record<string,{bonus:string;deduction:string;deductionMode:"FIXED"|"PERCENTAGE";deductionPercentage:string;deductionBasis:"BASE_SALARY"|"BASE_PLUS_BONUS";notes:string}>>({});
 const [payTarget,setPayTarget]=useState<PayrollItem|null>(null),[payAmount,setPayAmount]=useState(""),[payDate,setPayDate]=useState(today()),[payMethod,setPayMethod]=useState("CASH"),[payReference,setPayReference]=useState(""),[payNotes,setPayNotes]=useState("");
 const [historyTarget,setHistoryTarget]=useState<PayrollItem|null>(null),[paymentHistory,setPaymentHistory]=useState<PayrollPayment[]>([]),[historyLoading,setHistoryLoading]=useState(false);
 async function load(){setLoading(true);setError("");try{const [e,p]=await Promise.all([api<{data:Employee[]}>("/api/payroll/employees"),api<{data:PayrollData}>("/api/payroll?month="+encodeURIComponent(month))]);setEmployees(e.data);setPayroll(p.data);setAdjustments(Object.fromEntries(p.data.items.map(i=>[i.id,{bonus:String(i.bonus_amount??0),deduction:String(i.deduction_amount??0),deductionMode:i.deduction_mode==="PERCENTAGE"?"PERCENTAGE":"FIXED",deductionPercentage:String(i.deduction_percentage??""),deductionBasis:i.deduction_basis==="BASE_PLUS_BONUS"?"BASE_PLUS_BONUS":"BASE_SALARY",notes:i.notes??""}])));if(!employeeId&&e.data.find(x=>x.is_active))setEmployeeId(e.data.find(x=>x.is_active)!.id)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الرواتب")}finally{setLoading(false)}}
 useEffect(()=>{void load()},[month]);
 async function setSalary(e:FormEvent){e.preventDefault();setBusy(true);setError("");setNotice("");try{await api("/api/payroll/salary-profiles",{method:"POST",body:JSON.stringify({employeeId,monthlySalary:Number(monthlySalary),effectiveFrom,notes:salaryNotes||null})});setMonthlySalary("");setSalaryNotes("");setNotice("تم حفظ الراتب الأساسي مع الاحتفاظ بسجل الرواتب السابق.");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الراتب الأساسي")}finally{setBusy(false)}}
 async function generate(){setBusy(true);setError("");setNotice("");try{const r=await api<{data:{generatedItems:number}}>("/api/payroll/generate",{method:"POST",body:JSON.stringify({month})});setNotice("تم تجهيز مسير الشهر. عدد بنود الرواتب: "+r.data.generatedItems);await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء مسير الرواتب")}finally{setBusy(false)}}
 async function saveAdjustments(item:PayrollItem){const a=adjustments[item.id];if(a?.deductionMode==="PERCENTAGE"&&(!a.deductionPercentage.trim()||!Number.isFinite(Number(a.deductionPercentage))||Number(a.deductionPercentage)<=0||Number(a.deductionPercentage)>100)){setError("أدخل نسبة خصم أكبر من صفر وحتى ١٠٠٪.");return}setBusy(true);setError("");try{await api("/api/payroll/items/"+item.id,{method:"PATCH",body:JSON.stringify({bonusAmount:Number(a?.bonus||0),deductionMode:a?.deductionMode??"FIXED",...(a?.deductionMode==="PERCENTAGE"?{deductionPercentage:Number(a.deductionPercentage)}:{deductionAmount:Number(a?.deduction||0)}),deductionBasis:a?.deductionBasis??"BASE_SALARY",notes:a?.notes||null})});setNotice("تم حفظ تعديلات "+item.employee_name);await load()}catch(e){setError(e instanceof Error?e.message:"تعذر حفظ التعديلات")}finally{setBusy(false)}}
 async function showPaymentHistory(item:PayrollItem){setHistoryTarget(item);setPaymentHistory([]);setHistoryLoading(true);setError("");try{const result=await api<{data:PayrollPayment[]}>("/api/payroll/items/"+item.id+"/payments");setPaymentHistory(result.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل صرف الراتب")}finally{setHistoryLoading(false)}}
 async function approve(){if(!payroll.period)return;setBusy(true);setError("");try{await api("/api/payroll/periods/"+payroll.period.id+"/approve",{method:"POST"});setNotice("تم اعتماد مسير الرواتب.");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر اعتماد المسير")}finally{setBusy(false)}}
 async function submitPayment(e:FormEvent){e.preventDefault();if(!payTarget)return;setBusy(true);setError("");try{await api("/api/payroll/items/"+payTarget.id+"/payments",{method:"POST",body:JSON.stringify({amount:Number(payAmount),paymentDate:payDate,paymentMethod:payMethod,reference:payReference||null,notes:payNotes||null})});setPayTarget(null);setPayAmount("");setPayReference("");setPayNotes("");setNotice("تم تسجيل صرف الراتب.");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الصرف")}finally{setBusy(false)}}
 return <div className="app-shell"><Sidebar active="/payroll"/><main className="main"><header className="topbar"><div><h1 className="page-title">مرتبات الموظفين الأساسيين</h1><p className="page-subtitle">إدارة الراتب الشهري، المكافآت والخصومات، اعتماد مسير الرواتب، وتسجيل الصرف الجزئي أو الكامل.</p></div></header><section className="content">
  {error&&<div className="alert error">{error}</div>}{notice&&<div className="alert success">{notice}</div>}
  {has("payroll.manage")&&<form className="card form-card" onSubmit={setSalary}><div className="card-header"><h2 className="card-title">تعريف راتب أساسي</h2><span className="form-hint">تغيير الراتب ينشئ سجلًا جديدًا ولا يمس الرواتب السابقة</span></div><div className="form-grid">
   <label>الموظف<select value={employeeId} onChange={e=>setEmployeeId(e.target.value)} required><option value="">اختر الموظف</option>{employees.filter(x=>x.is_active).map(e=><option key={e.id} value={e.id}>{e.full_name} · {e.code}{e.monthly_salary!==null?" · الحالي "+money(e.monthly_salary)+" ج.م":""}</option>)}</select></label>
   <label>الراتب الشهري (ج.م)<input type="number" min="0" step="0.01" value={monthlySalary} onChange={e=>setMonthlySalary(e.target.value)} required/></label>
   <label>ساري من تاريخ<input type="date" value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)} required/></label>
   <label>ملاحظات<input value={salaryNotes} onChange={e=>setSalaryNotes(e.target.value)} maxLength={1000}/></label>
  </div><div className="form-actions"><button className="primary-button" disabled={busy||!employeeId||monthlySalary===""}>حفظ الراتب الأساسي</button></div></form>}
  <section className="card"><div className="card-header"><div><h2 className="card-title">مسير الرواتب الشهري</h2><div className="form-hint">يتم تثبيت الراتب في المسير عند إنشائه، وأي تغيير لاحق لا يغير المسيرات السابقة.</div></div></div>
   <div className="toolbar"><label>الشهر<input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label><div className="form-actions">{has("payroll.generate")&&<button className="secondary-btn" onClick={generate} disabled={busy}>تجهيز المسير من الرواتب السارية</button>}{payroll.period&&payroll.period.status==="DRAFT"&&has("payroll.approve")&&<button className="primary-button" onClick={approve} disabled={busy}>اعتماد المسير</button>}</div></div>
   {payroll.period&&<div className="form-hint" style={{margin:"10px 0"}}>حالة الفترة: <strong>{periodStatus[payroll.period.status]||payroll.period.status}</strong></div>}
   <div className="stats"><article className="card stat"><div className="stat-label">عدد الموظفين</div><div className="stat-value">{payroll.totals.employees}</div></article><article className="card stat"><div className="stat-label">صافي الرواتب</div><div className="stat-value">{money(payroll.totals.net)} ج.م</div></article><article className="card stat accent"><div className="stat-label">تم صرفه</div><div className="stat-value">{money(payroll.totals.paid)} ج.م</div></article><article className="card stat warning"><div className="stat-label">المتبقي للصرف</div><div className="stat-value">{money(payroll.totals.remaining)} ج.م</div></article></div>
   {loading?<div className="empty">جارٍ تحميل مسير الرواتب...</div>:!payroll.period?<div className="empty">لا يوجد مسير لهذا الشهر. اضغط «تجهيز المسير من الرواتب السارية» بعد تعريف الرواتب الأساسية.</div>:!payroll.items.length?<div className="empty">لا توجد بنود رواتب في هذه الفترة.</div>:<div className="table-wrap"><table><thead><tr><th>الموظف</th><th>الأساسي</th><th>مكافأة</th><th>خصم</th><th>الصافي</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>{payroll.items.map((i) => {
    const a = adjustments[i.id] ?? {
      bonus: String(i.bonus_amount ?? 0),
      deduction: String(i.deduction_amount ?? 0),
      deductionMode: i.deduction_mode === "PERCENTAGE" ? "PERCENTAGE" as const : "FIXED" as const,
      deductionPercentage: String(i.deduction_percentage ?? ""),
      deductionBasis: i.deduction_basis === "BASE_PLUS_BONUS" ? "BASE_PLUS_BONUS" as const : "BASE_SALARY" as const,
      notes: i.notes ?? ""
    };
    const basisAmount = a.deductionBasis === "BASE_PLUS_BONUS"
      ? Number(i.base_salary) + Number(a.bonus || 0)
      : Number(i.base_salary);
    const previewDeduction = Math.round((basisAmount * Math.min(100, Math.max(0, Number(a.deductionPercentage || 0))) / 100 + Number.EPSILON) * 100) / 100;
    return (
      <tr key={i.id}>
        <td><div className="strong">{i.employee_name}</div><div className="form-hint">{i.employee_code} · {i.department_name || "بدون قسم"}</div></td>
        <td>{money(i.base_salary)}</td>
        <td>{payroll.period?.status === "DRAFT" && has("payroll.manage")
          ? <input aria-label="مكافأة" type="number" min="0" step="0.01" style={{width:105}} value={a.bonus} onChange={e => setAdjustments(s => ({...s,[i.id]:{...a,bonus:e.target.value}}))}/>
          : money(i.bonus_amount)}</td>
        <td>
          {payroll.period?.status === "DRAFT" && has("payroll.manage") ? (
            <div style={{display:"grid",gap:6,minWidth:175}}>
              <select aria-label="طريقة حساب الخصم" value={a.deductionMode} onChange={e => setAdjustments(s => ({...s,[i.id]:{...a,deductionMode:e.target.value as "FIXED" | "PERCENTAGE"}}))}>
                <option value="FIXED">مبلغ ثابت</option>
                <option value="PERCENTAGE">نسبة مئوية</option>
              </select>
              {a.deductionMode === "FIXED" ? (
                <input aria-label="قيمة الخصم بالجنيه" type="number" min="0" step="0.01" value={a.deduction} onChange={e => setAdjustments(s => ({...s,[i.id]:{...a,deduction:e.target.value}}))}/>
              ) : (
                <div style={{display:"grid",gap:5}}>
                  <input aria-label="نسبة الخصم بالمئة" type="number" min="0.01" max="100" step="0.01" placeholder="النسبة %" value={a.deductionPercentage} onChange={e => setAdjustments(s => ({...s,[i.id]:{...a,deductionPercentage:e.target.value}}))}/>
                  <select aria-label="أساس حساب الخصم" value={a.deductionBasis} onChange={e => setAdjustments(s => ({...s,[i.id]:{...a,deductionBasis:e.target.value as "BASE_SALARY" | "BASE_PLUS_BONUS"}}))}>
                    <option value="BASE_SALARY">الراتب الأساسي فقط</option>
                    <option value="BASE_PLUS_BONUS">الأساسي + المكافأة</option>
                  </select>
                  <small className="form-hint">أساس الحساب: {money(basisAmount)} ج.م</small>
                  <small className="strong">الخصم المتوقع: {money(previewDeduction)} ج.م</small>
                </div>
              )}
            </div>
          ) : money(i.deduction_amount)}
        </td>
        <td className="strong">{money(i.net_amount)}</td>
        <td>{money(i.paid_amount)}</td>
        <td>{money(i.remaining_amount)}</td>
        <td><span className={"status " + (i.status === "PAID" ? "success" : i.status === "PARTIAL" ? "warning" : "muted")}>{itemStatus[i.status] || i.status}</span></td>
        <td><div className="row-actions">
          {payroll.period?.status === "DRAFT" && has("payroll.manage") && <button className="secondary-btn" disabled={busy} onClick={() => saveAdjustments(i)}>حفظ التعديلات</button>}
          {(payroll.period?.status === "APPROVED" || payroll.period?.status === "CLOSED") && has("payroll.pay") && Number(i.remaining_amount) > 0 && <button className="primary-button" onClick={() => {setPayTarget(i);setPayAmount(String(i.remaining_amount));setPayDate(today());setPayMethod("CASH");setPayReference("");setPayNotes("");}}>صرف</button>}
          {has("payroll.view") && Number(i.paid_amount) > 0 && <button className="secondary-btn" onClick={() => void showPaymentHistory(i)}>سجل الصرف</button>}
        </div></td>
      </tr>
    );
  })}</tbody></table></div>}
  </section>
  <section className="card"><div className="card-header"><h2 className="card-title">الرواتب الأساسية الحالية</h2></div><div className="table-wrap"><table><thead><tr><th>الموظف</th><th>القسم</th><th>الراتب الشهري</th><th>ساري من</th><th>الحالة</th></tr></thead><tbody>{employees.filter(e=>e.salary_profile_id).map(e=><tr key={e.id}><td>{e.full_name}<div className="form-hint">{e.code}</div></td><td>{e.department_name||"—"}</td><td>{money(e.monthly_salary||0)} ج.م</td><td>{e.effective_from?new Date(e.effective_from+"T00:00:00").toLocaleDateString("ar-EG"):"—"}</td><td><span className={"status "+(e.is_active?"success":"muted")}>{e.is_active?"نشط":"غير نشط"}</span></td></tr>)}{!employees.some(e=>e.salary_profile_id)&&<tr><td colSpan={5} className="empty">لم يتم تعريف رواتب أساسية بعد.</td></tr>}</tbody></table></div></section>
 </section>
 {historyTarget&&<div className="modal-backdrop" onClick={()=>setHistoryTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">سجل صرف الراتب</h2><div className="form-hint">{historyTarget.employee_name} · إجمالي المدفوع {money(historyTarget.paid_amount)} ج.م</div></div><button className="secondary-btn" onClick={()=>setHistoryTarget(null)}>إغلاق</button></div>{historyLoading?<div className="empty">جارٍ تحميل سجل الصرف...</div>:!paymentHistory.length?<div className="empty">لا توجد عمليات صرف مسجلة.</div>:<div className="table-wrap"><table><thead><tr><th>تاريخ الصرف</th><th>المبلغ</th><th>الطريقة</th><th>المرجع/الإيصال</th><th>المسجل بواسطة</th><th>ملاحظات</th></tr></thead><tbody>{paymentHistory.map(p=><tr key={p.id}><td>{String(p.payment_date).slice(0,10)}</td><td className="strong">{money(p.amount)} ج.م</td><td>{paymentMethodLabel[p.payment_method||""]||p.payment_method||"—"}</td><td>{p.reference||"—"}</td><td>{p.paid_by_username||"—"}</td><td>{p.notes||"—"}</td></tr>)}</tbody></table></div>}</div></div>}
 {payTarget&&<div className="modal-backdrop" onClick={()=>setPayTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">صرف راتب</h2><div className="form-hint">{payTarget.employee_name} · المتبقي {money(payTarget.remaining_amount)} ج.م</div></div><button className="secondary-btn" onClick={()=>setPayTarget(null)}>إغلاق</button></div><form onSubmit={submitPayment}><div className="form-grid"><label>مبلغ الصرف (ج.م)<input type="number" min="0.01" max={Number(payTarget.remaining_amount)} step="0.01" value={payAmount} onChange={e=>setPayAmount(e.target.value)} required/></label><label>تاريخ الصرف<input type="date" value={payDate} onChange={e=>setPayDate(e.target.value)} required/></label><label>طريقة الصرف<select value={payMethod} onChange={e=>setPayMethod(e.target.value)}><option value="CASH">نقدي</option><option value="BANK_TRANSFER">تحويل بنكي</option><option value="WALLET">محفظة إلكترونية</option><option value="OTHER">أخرى</option></select></label><label>رقم مرجعي/إيصال<input value={payReference} onChange={e=>setPayReference(e.target.value)}/></label><label style={{gridColumn:"1 / -1"}}>ملاحظات<textarea rows={2} value={payNotes} onChange={e=>setPayNotes(e.target.value)}/></label></div><div className="form-actions"><button className="secondary-btn" type="button" onClick={()=>setPayTarget(null)}>إلغاء</button><button className="primary-button" disabled={busy||Number(payAmount)<=0||Number(payAmount)>Number(payTarget.remaining_amount)}>تأكيد الصرف</button></div></form></div></div>}
 </main></div>;
}
