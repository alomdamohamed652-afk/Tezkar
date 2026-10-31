"use client";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { SearchableSelect } from "../../components/searchable-select";
import {formatMoney} from "../../lib/format";

type Employee={id:string;code:string;full_name:string;department_name:string|null;is_active:boolean;salary_profile_id:string|null;monthly_salary:string|number|null;effective_from:string|null};
type PayrollItem={id:string;employee_id:string;employee_code:string;employee_name:string;department_name:string|null;base_salary:string|number;bonus_amount:string|number;deduction_amount:string|number;advance_repayment_amount?:string|number;deduction_mode?:"FIXED"|"PERCENTAGE";deduction_percentage?:string|number|null;deduction_basis?:"BASE_SALARY"|"BASE_PLUS_BONUS";net_amount:string|number;paid_amount:string|number;remaining_amount:string|number;status:string;notes:string|null};
type PayrollData={period:{id:string;period_month:string;status:string;overtime_multiplier?:string|number}|null;items:PayrollItem[];totals:{employees:number;net:number;paid:number;remaining:number;recordedExpense?:number;expenseDifference?:number;missingExpenseCount?:number;missingExpenseAmount?:number;expenseMismatchCount?:number}};
type PayrollPayment={id:string;amount:string|number;payment_date:string;payment_method:string|null;reference:string|null;notes:string|null;paid_by_username:string|null;created_at:string};
type AdjustmentLine={id:string;payroll_item_id:string;line_type:"BONUS"|"DEDUCTION";description:string;amount:string|number;notes:string|null;status:"ACTIVE"|"VOIDED";void_reason?:string|null;voided_by_username?:string|null;source_type?:string;created_by_username?:string|null};
type SalaryHistoryItem={id:string;monthly_salary:string|number;effective_from:string;effective_to:string|null;notes:string|null;created_at:string;created_by_username:string|null};
type OwnPayrollPayment={id:string;amount:string|number;payment_date:string;payment_method:string|null;reference:string|null;notes:string|null};
type OwnPayrollItem={id:string;employee_id:string;period_month:string;period_status:string;base_salary:string|number;bonus_amount:string|number;deduction_amount:string|number;advance_repayment_amount:string|number;net_amount:string|number;status:string;notes:string|null;paid_amount:string|number;remaining_amount:string|number;payments:OwnPayrollPayment[]};
type OwnPayrollData={employee:{id:string;code:string;full_name:string};salaryHistory:Array<{id:string;monthly_salary:string|number;effective_from:string;effective_to:string|null;notes:string|null}>;payrollItems:OwnPayrollItem[]};
type AttendanceDay={date:string;employeeId:string;employeeCode:string;employeeName:string;firstIn:string|null;lastOut:string|null;scheduledStart?:string|null;scheduledEnd?:string|null;isDayOff?:boolean;workedMinutes:number;workedHours:number;lateMinutes:number;earlyMinutes:number;overtimeMinutes?:number;status:string;needsReview:boolean;suspiciousCount:number;duplicatePunchCount:number;punchCount:number};
type CustodyHolder={id:string;code:string;full_name:string;balance:string|number};
const attendanceStatus:Record<string,string>={PRESENT:"حاضر",ABSENT:"غائب",MISSING_PUNCH:"بصمة ناقصة",DAY_OFF:"إجازة",DAY_OFF_WITH_PUNCH:"إجازة مع بصمة",NO_SCHEDULE:"بدون جدول",NO_SCHEDULE_WITH_PUNCH:"بصمة بدون جدول",NOT_STARTED:"لم يبدأ اليوم"};
const paymentMethodLabel:Record<string,string>={CASH:"نقدي",BANK_TRANSFER:"تحويل بنكي",WALLET:"محفظة إلكترونية",OTHER:"أخرى"};
const money=(v:string|number)=>formatMoney(v);
const monthNow=()=>new Date().toISOString().slice(0,7);
const today=()=>new Date().toISOString().slice(0,10);
const periodStatus:Record<string,string>={DRAFT:"مسودة",APPROVED:"معتمد",CLOSED:"مغلق"};
const itemStatus:Record<string,string>={UNPAID:"لم يُصرف",PARTIAL:"صرف جزئي",PAID:"مدفوع بالكامل"};
export default function PayrollPage(){
 const {has,permissions}=usePermissions();
 const [employees,setEmployees]=useState<Employee[]>([]),[payroll,setPayroll]=useState<PayrollData>({period:null,items:[],totals:{employees:0,net:0,paid:0,remaining:0}});
 const [month,setMonth]=useState(monthNow()),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState(""),[overtimeMultiplier,setOvertimeMultiplier]=useState("1.5");
 const [employeeId,setEmployeeId]=useState(""),[monthlySalary,setMonthlySalary]=useState(""),[effectiveFrom,setEffectiveFrom]=useState(today()),[salaryNotes,setSalaryNotes]=useState("");
 const [payTarget,setPayTarget]=useState<PayrollItem|null>(null),[payAmount,setPayAmount]=useState(""),[payDate,setPayDate]=useState(today()),[payMethod,setPayMethod]=useState("CASH"),[payReference,setPayReference]=useState(""),[payNotes,setPayNotes]=useState(""),[paymentIdempotencyKey,setPaymentIdempotencyKey]=useState(""),[fromCustody,setFromCustody]=useState(true),[custodyEmployeeId,setCustodyEmployeeId]=useState("");
 const [attendanceTarget,setAttendanceTarget]=useState<PayrollItem|null>(null),[attendanceDays,setAttendanceDays]=useState<AttendanceDay[]>([]),[attendanceLoading,setAttendanceLoading]=useState(false);
 const [custodyHolders,setCustodyHolders]=useState<CustodyHolder[]>([]),[custodyLoading,setCustodyLoading]=useState(false);
 const [historyTarget,setHistoryTarget]=useState<PayrollItem|null>(null),[paymentHistory,setPaymentHistory]=useState<PayrollPayment[]>([]),[historyLoading,setHistoryLoading]=useState(false);
 const [salaryHistory,setSalaryHistory]=useState<SalaryHistoryItem[]>([]),[salaryHistoryEmployeeId,setSalaryHistoryEmployeeId]=useState(""),[salaryHistoryLoading,setSalaryHistoryLoading]=useState(false);
 const [ownPayroll,setOwnPayroll]=useState<OwnPayrollData|null>(null);
 const [adjustmentTarget,setAdjustmentTarget]=useState<PayrollItem|null>(null),[adjustmentLines,setAdjustmentLines]=useState<AdjustmentLine[]>([]),[adjustmentLoading,setAdjustmentLoading]=useState(false);
 const [lineType,setLineType]=useState<"BONUS"|"DEDUCTION">("BONUS"),[lineDescription,setLineDescription]=useState(""),[lineAmount,setLineAmount]=useState(""),[lineNotes,setLineNotes]=useState(""),[editingLineId,setEditingLineId]=useState<string|null>(null);
 async function load(){setLoading(true);setError("");try{
  if(!has("payroll.view")){
   if(!has("payroll.view_own")){setError("ليس لديك صلاحية عرض الرواتب.");return}
   const r=await api<{data:OwnPayrollData}>("/api/payroll/my-account");setOwnPayroll(r.data);return;
  }
  const [e,p]=await Promise.all([api<{data:Employee[]}>("/api/payroll/employees"),api<{data:PayrollData}>("/api/payroll?month="+encodeURIComponent(month))]);setEmployees(e.data);setPayroll(p.data);if(p.data.period?.overtime_multiplier!==undefined)setOvertimeMultiplier(String(p.data.period.overtime_multiplier));if(!employeeId&&e.data.find(x=>x.is_active))setEmployeeId(e.data.find(x=>x.is_active)!.id)
 }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الرواتب")}finally{setLoading(false)}}
 useEffect(()=>{if(permissions!==null)void load()},[month,permissions]);
 async function setSalary(e:FormEvent){e.preventDefault();setBusy(true);setError("");setNotice("");try{await api("/api/payroll/salary-profiles",{method:"POST",body:JSON.stringify({employeeId,monthlySalary:Number(monthlySalary),effectiveFrom,notes:salaryNotes||null})});setMonthlySalary("");setSalaryNotes("");setNotice("تم حفظ الراتب الأساسي مع الاحتفاظ بسجل الرواتب السابق.");await load();await showSalaryHistory()}catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الراتب الأساسي")}finally{setBusy(false)}}
 async function showSalaryHistory(){
  if(!employeeId)return;
  setSalaryHistoryLoading(true);setError("");
  try{
   const r=await api<{data:{employee:{id:string;full_name:string;code:string};history:SalaryHistoryItem[]}}>("/api/payroll/employees/"+employeeId+"/salary-history");
   setSalaryHistory(r.data.history);setSalaryHistoryEmployeeId(employeeId);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل تغييرات الراتب")}
  finally{setSalaryHistoryLoading(false)}
 }
 async function generate(){setBusy(true);setError("");setNotice("");try{const r=await api<{data:{generatedItems:number}}>("/api/payroll/generate",{method:"POST",body:JSON.stringify({month})});setNotice("تم تجهيز مسير الشهر. عدد بنود الرواتب: "+r.data.generatedItems);await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء مسير الرواتب")}finally{setBusy(false)}}
 async function showPaymentHistory(item:PayrollItem){setHistoryTarget(item);setPaymentHistory([]);setHistoryLoading(true);setError("");try{const result=await api<{data:PayrollPayment[]}>("/api/payroll/items/"+item.id+"/payments");setPaymentHistory(result.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل صرف الراتب")}finally{setHistoryLoading(false)}}
 async function refreshCustodyHolders(date:string){
  setCustodyLoading(true);
  try{const r=await api<{data:CustodyHolder[]}>("/api/payroll/custody-holders?date="+encodeURIComponent(date));setCustodyHolders(r.data)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تحميل أرصدة العهد. تأكد من صلاحية صرف الرواتب.")}
  finally{setCustodyLoading(false)}
 }
 async function openAttendance(item:PayrollItem){
  setAttendanceTarget(item);setAttendanceDays([]);setAttendanceLoading(true);setError("");
  try{
   const frozen=await api<{data:Array<{date:string;snapshotData:AttendanceDay}>;frozen:boolean;periodStatus:string}>("/api/payroll/items/"+item.id+"/attendance-snapshot");
   if(frozen.frozen){
    setAttendanceDays(frozen.data.map(row=>row.snapshotData).sort((a,b)=>a.date.localeCompare(b.date)));
   }else{
    const [year,monthNumber]=month.split("-").map(Number);const lastDay=new Date(year,monthNumber,0).getDate();
    const from=month+"-01",to=month+"-"+String(lastDay).padStart(2,"0");
    const r=await api<{data:AttendanceDay[];summary:Record<string,number>}>("/api/attendance/report?from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to));
    setAttendanceDays(r.data.filter(row=>row.employeeId===item.employee_id).sort((a,b)=>a.date.localeCompare(b.date)));
   }
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل الحضور والانصراف. تأكد من صلاحية عرض الحضور.")}
  finally{setAttendanceLoading(false)}
 }
 async function openAdjustments(item:PayrollItem){
  setAdjustmentTarget(item);setAdjustmentLines([]);setAdjustmentLoading(true);setError("");setLineType("BONUS");setLineDescription("");setLineAmount("");setLineNotes("");setEditingLineId(null);
  try{const r=await api<{data:AdjustmentLine[]}>("/api/payroll/items/"+item.id+"/adjustments");setAdjustmentLines(r.data)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تحميل بنود المرتب")}
  finally{setAdjustmentLoading(false)}
 }
 async function addAdjustment(e:FormEvent){
  e.preventDefault();if(!adjustmentTarget)return;
  setBusy(true);setError("");setNotice("");
  try{
   const body=JSON.stringify({lineType,description:lineDescription,amount:Number(lineAmount),notes:lineNotes||null});
   const r=await api<{data:AdjustmentLine}>("/api/payroll/items/"+adjustmentTarget.id+"/adjustments"+(editingLineId?"/"+editingLineId:""),{method:editingLineId?"PATCH":"POST",body});
   setAdjustmentLines(lines=>editingLineId?lines.map(line=>line.id===editingLineId?r.data:line):[...lines,r.data]);
   setNotice(editingLineId?"تم تعديل البند وإعادة حساب المرتب.":lineType==="BONUS"?"تمت إضافة بند المكافأة.":"تمت إضافة بند الخصم.");
   setEditingLineId(null);setLineType("BONUS");setLineDescription("");setLineAmount("");setLineNotes("");
   await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ بند المكافأة أو الخصم")}
  finally{setBusy(false)}
 }
 async function deleteAdjustment(line:AdjustmentLine){
  if(!adjustmentTarget||line.status==="VOIDED")return;
  const reason=window.prompt("اكتب سبب إلغاء البند: "+line.description);
  if(!reason||!reason.trim())return;
  setBusy(true);setError("");
  try{const r=await api<{data:AdjustmentLine}>("/api/payroll/items/"+adjustmentTarget.id+"/adjustments/"+line.id,{method:"DELETE",body:JSON.stringify({reason:reason.trim()})});setAdjustmentLines(lines=>lines.map(x=>x.id===line.id?r.data:x));setNotice("تم إلغاء البند وحفظ سبب الإلغاء في السجل.");await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء البند")}
  finally{setBusy(false)}
 }
 async function approve(){if(!payroll.period)return;setBusy(true);setError("");setNotice("");try{
   const [year,monthNumber]=month.split("-").map(Number);const lastDay=new Date(year,monthNumber,0).getDate();
   const from=month+"-01",to=month+"-"+String(lastDay).padStart(2,"0");
   const attendance=await api<{data:AttendanceDay[]}>("/api/attendance/report?from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to));
   const payrollEmployeeIds=new Set(payroll.items.map(item=>item.employee_id));
   const attendanceSnapshot=attendance.data.filter(row=>payrollEmployeeIds.has(row.employeeId));
   const expectedCount=payroll.items.length*lastDay;
   if(attendanceSnapshot.length!==expectedCount)throw new Error("سجل الحضور غير مكتمل لكل موظفي المسير وأيام الشهر؛ راجع بيانات الحضور قبل الاعتماد.");
   await api("/api/payroll/periods/"+payroll.period.id+"/approve",{method:"POST",body:JSON.stringify({attendanceSnapshot,overtimeMultiplier:Number(overtimeMultiplier)})});
   setNotice("تم اعتماد مسير الرواتب وحفظ نسخة ثابتة من سجل الحضور لكل موظف ولكل يوم في الشهر.");await load()
  }catch(e){setError(e instanceof Error?e.message:"تعذر اعتماد مسير الرواتب.")}finally{setBusy(false)}}
 async function submitPayment(e:FormEvent){e.preventDefault();if(!payTarget||!paymentIdempotencyKey||(fromCustody&&!custodyEmployeeId))return;setBusy(true);setError("");try{await api("/api/payroll/items/"+payTarget.id+"/payments",{method:"POST",body:JSON.stringify({idempotencyKey:paymentIdempotencyKey,amount:Number(payAmount),paymentDate:payDate,paymentMethod:payMethod,reference:payReference||null,notes:payNotes||null,fromCustody,custodyEmployeeId:fromCustody?custodyEmployeeId:null})});setPayTarget(null);setPayAmount("");setPayReference("");setPayNotes("");setPaymentIdempotencyKey("");setNotice("تم تسجيل صرف الراتب.");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل الصرف")}finally{setBusy(false)}}
 if(!has("payroll.view"))return <div className="app-shell"><Sidebar active="/payroll"/><main className="main"><header className="topbar"><div><h1 className="page-title">مرتباتي</h1><p className="page-subtitle">الراتب الأساسي، المسيرات المعتمدة، الخصومات، أقساط السلف، والمدفوعات الفعلية.</p></div></header><section className="content">
   {error&&<div className="alert error">{error}</div>}
   {loading?<div className="empty">جارٍ تحميل بيانات الراتب...</div>:ownPayroll&&<>
    <section className="card"><div className="card-header"><div><h2 className="card-title">{ownPayroll.employee.full_name}</h2><div className="form-hint">كود الموظف: {ownPayroll.employee.code}</div></div></div>
     <div className="stats"><article className="card stat"><div className="stat-label">الراتب الأساسي الحالي</div><div className="stat-value">{money(ownPayroll.salaryHistory.find(x=>!x.effective_to)?.monthly_salary??ownPayroll.salaryHistory[0]?.monthly_salary??0)} ج.م</div></article><article className="card stat"><div className="stat-label">عدد مسيرات الرواتب</div><div className="stat-value">{ownPayroll.payrollItems.length}</div></article><article className="card stat"><div className="stat-label">إجمالي المتبقي للصرف</div><div className="stat-value">{money(ownPayroll.payrollItems.reduce((sum,x)=>sum+Number(x.remaining_amount),0))} ج.م</div></article></div>
    </section>
    <section className="card"><div className="card-header"><h2 className="card-title">كشف الرواتب والمدفوعات</h2></div>
     {!ownPayroll.payrollItems.length?<div className="empty">لا توجد مسيرات رواتب معتمدة حتى الآن.</div>:<div className="table-wrap"><table><thead><tr><th>الشهر</th><th>الأساسي</th><th>المكافآت</th><th>الخصومات</th><th>سداد السلف</th><th>صافي الراتب</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th>سجل الصرف</th></tr></thead><tbody>{ownPayroll.payrollItems.map(item=><tr key={item.id}><td>{String(item.period_month).slice(0,7)}</td><td>{money(item.base_salary)}</td><td>{money(item.bonus_amount)}</td><td>{money(item.deduction_amount)}</td><td>{money(item.advance_repayment_amount)}</td><td className="strong">{money(item.net_amount)} ج.م</td><td>{money(item.paid_amount)} ج.م</td><td>{money(item.remaining_amount)} ج.م</td><td><span className={"status "+(item.status==="PAID"?"success":item.status==="PARTIAL"?"warning":"muted")}>{itemStatus[item.status]||item.status}</span></td><td>{item.payments.length?item.payments.map(p=><div key={p.id} className="form-hint">{String(p.payment_date).slice(0,10)} · {money(p.amount)} ج.م{p.reference?" · "+p.reference:""}</div>):"—"}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="card"><div className="card-header"><h2 className="card-title">سجل تغييرات الراتب الأساسي</h2></div>{!ownPayroll.salaryHistory.length?<div className="empty">لم يتم تعريف راتب أساسي بعد.</div>:<div className="table-wrap"><table><thead><tr><th>الراتب</th><th>ساري من</th><th>ساري حتى</th><th>ملاحظات</th></tr></thead><tbody>{ownPayroll.salaryHistory.map(profile=><tr key={profile.id}><td className="strong">{money(profile.monthly_salary)} ج.م</td><td>{String(profile.effective_from).slice(0,10)}</td><td>{profile.effective_to?String(profile.effective_to).slice(0,10):"حالي"}</td><td>{profile.notes||"—"}</td></tr>)}</tbody></table></div>}</section>
   </>}
  </section></main></div>;
return <div className="app-shell"><Sidebar active="/payroll"/><main className="main"><header className="topbar"><div><h1 className="page-title">مسيرات الرواتب والحضور</h1><p className="page-subtitle">جهّز مسير الشهر كمسودة، راجع سجل كل موظف من يوم ١ لآخر يوم، أضف المكافآت والخصومات ببيان مستقل، ثم اعتمد المسير وسجّل الصرف من العهدة أو بوسيلة غير نقدية.</p></div></header><section className="content">
  {error&&<div className="alert error">{error}</div>}{notice&&<div className="alert success">{notice}</div>}
  {has("payroll.manage")&&<form className="card form-card" onSubmit={setSalary}><div className="card-header"><h2 className="card-title">تعريف راتب أساسي</h2><span className="form-hint">تغيير الراتب ينشئ سجلًا جديدًا ولا يمس الرواتب السابقة</span></div><div className="form-grid">
   <label>الموظف<SearchableSelect value={employeeId} onChange={v=>{setEmployeeId(v);setSalaryHistory([]);setSalaryHistoryEmployeeId("")}} placeholder="اختر الموظف" options={[{value:"",label:"اختر الموظف"},...employees.filter(x=>x.is_active).map(e=>({value:e.id,label:e.full_name,meta:e.code+(e.monthly_salary!==null?" · الحالي "+money(e.monthly_salary)+" ج.م":"")}))]}/></label>
   <label>الراتب الشهري (ج.م)<input type="number" min="0" step="0.01" value={monthlySalary} onChange={e=>setMonthlySalary(e.target.value)} required/></label>
   <label>ساري من تاريخ<input type="date" value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)} required/></label>
   <label>ملاحظات<input value={salaryNotes} onChange={e=>setSalaryNotes(e.target.value)} maxLength={1000}/></label>
  </div><div className="form-actions"><button className="primary-button" disabled={busy||!employeeId||monthlySalary===""}>حفظ الراتب الأساسي</button><button type="button" className="secondary-btn" disabled={!employeeId||salaryHistoryLoading} onClick={()=>void showSalaryHistory()}>{salaryHistoryLoading?"جارٍ تحميل السجل...":"عرض سجل تغييرات الراتب"}</button></div></form>}
  {salaryHistoryEmployeeId&&salaryHistoryEmployeeId===employeeId&&<section className="card"><div className="card-header"><div><h2 className="card-title">سجل تغييرات الراتب الأساسي</h2><div className="form-hint">{employees.find(e=>e.id===salaryHistoryEmployeeId)?.full_name||""} · كل تعديل محفوظ بتاريخ سريانه</div></div><button className="secondary-btn" onClick={()=>{setSalaryHistoryEmployeeId("");setSalaryHistory([])}}>إخفاء السجل</button></div><div className="table-wrap"><table><thead><tr><th>الراتب الشهري</th><th>ساري من</th><th>ساري حتى</th><th>ملاحظات</th><th>سُجل بواسطة</th><th>تاريخ التسجيل</th></tr></thead><tbody>{salaryHistory.map(x=><tr key={x.id}><td className="strong">{money(x.monthly_salary)} ج.م</td><td>{String(x.effective_from).slice(0,10)}</td><td>{x.effective_to?String(x.effective_to).slice(0,10):"الحالي"}</td><td>{x.notes||"—"}</td><td>{x.created_by_username||"—"}</td><td>{new Date(x.created_at).toLocaleDateString("ar-EG")}</td></tr>)}{!salaryHistory.length&&<tr><td colSpan={6}>لا توجد تغييرات مسجلة لهذا الموظف.</td></tr>}</tbody></table></div></section>}
  <section className="card"><div className="card-header"><div><h2 className="card-title">مسير الرواتب الشهري</h2><div className="form-hint">يتم تثبيت الراتب في المسير عند إنشائه، وأي تغيير لاحق لا يغير المسيرات السابقة. الخصم هنا يدوي ولا ينشئ مصروفًا تلقائيًا؛ سجّل التلفيات أو الإهلاك يدويًا في المالية بشكل منفصل، ولا تخصم القيمة من العهدة النقدية إلا لو دُفعت منها فعلًا.</div></div></div>
   <div className="toolbar"><label>الشهر<input type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label>{payroll.period?.status==="DRAFT"&&has("payroll.approve")&&<label>مضاعف أجر الإضافي<input type="number" min="1" max="5" step="0.1" value={overtimeMultiplier} onChange={e=>setOvertimeMultiplier(e.target.value)}/><span className="form-hint">من 1 إلى 5 · الافتراضي 1.5</span></label>}<div className="form-actions">{has("payroll.generate")&&<button className="secondary-btn" onClick={generate} disabled={busy}>تجهيز المسير من الرواتب السارية</button>}{payroll.period&&payroll.period.status==="DRAFT"&&has("payroll.approve")&&<button className="primary-button" onClick={approve} disabled={busy}>اعتماد المسير</button>}</div></div>
   {payroll.period&&<div className="form-hint" style={{margin:"10px 0"}}>حالة الفترة: <strong>{periodStatus[payroll.period.status]||payroll.period.status}</strong></div>}
   <div className="stats"><article className="card stat"><div className="stat-label">عدد الموظفين</div><div className="stat-value">{payroll.totals.employees}</div></article><article className="card stat"><div className="stat-label">صافي الرواتب</div><div className="stat-value">{money(payroll.totals.net)} ج.م</div></article><article className="card stat accent"><div className="stat-label">تم صرفه</div><div className="stat-value">{money(payroll.totals.paid)} ج.م</div></article><article className="card stat warning"><div className="stat-label">المتبقي للصرف</div><div className="stat-value">{money(payroll.totals.remaining)} ج.م</div></article></div>
    <div className="stats">
      <article className="card stat"><div className="stat-label">المصروف المسجل محاسبيًا</div><div className="stat-value">{payroll.period?.status === "DRAFT" ? "بعد الاعتماد" : money(payroll.totals.recordedExpense ?? 0) + " ج.م"}</div></article>
      <article className={"card stat " + (((payroll.totals.missingExpenseCount ?? 0) + (payroll.totals.expenseMismatchCount ?? 0)) > 0 && payroll.period?.status !== "DRAFT" ? "warning" : "")}><div className="stat-label">بنود تحتاج مراجعة محاسبية</div><div className="stat-value">{payroll.period?.status === "DRAFT" ? "بعد الاعتماد" : ((payroll.totals.missingExpenseCount ?? 0) + (payroll.totals.expenseMismatchCount ?? 0))}</div><div className="form-hint">فرق المبالغ في المصروفات المرتبطة: {payroll.period?.status === "DRAFT" ? "—" : money(payroll.totals.expenseDifference ?? 0) + " ج.م"}</div><div className="form-hint">قيمة الرواتب التي ينقصها ربط مصروف: {payroll.period?.status === "DRAFT" ? "—" : money(payroll.totals.missingExpenseAmount ?? 0) + " ج.م"}</div></article>
    </div>
   {loading?<div className="empty">جارٍ تحميل مسير الرواتب...</div>:!payroll.period?<div className="empty">لا يوجد مسير لهذا الشهر. اضغط «تجهيز المسير من الرواتب السارية» بعد تعريف الرواتب الأساسية.</div>:!payroll.items.length?<div className="empty">لا توجد بنود رواتب في هذه الفترة.</div>:<div className="table-wrap"><table><thead><tr><th>الموظف</th><th>الأساسي</th><th>مكافأة</th><th>خصم</th><th>سداد السلفة</th><th>الصافي</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>{payroll.items.map((i) => {
        return (
      <tr key={i.id}>
        <td><div className="strong">{i.employee_name}</div><div className="form-hint">{i.employee_code} · {i.department_name || "بدون قسم"}</div></td>
        <td>{money(i.base_salary)}</td>
        <td>{money(i.bonus_amount)}</td>
        <td>{money(i.deduction_amount)}</td>
        <td className="money">{money(i.advance_repayment_amount??0)}</td>
        <td className="strong">{money(i.net_amount)}</td>
        <td>{money(i.paid_amount)}</td>
        <td>{money(i.remaining_amount)}</td>
        <td><span className={"status " + (i.status === "PAID" ? "success" : i.status === "PARTIAL" ? "warning" : "muted")}>{itemStatus[i.status] || i.status}</span></td>
        <td><div className="row-actions">
          {payroll.period?.status === "DRAFT" && has("payroll.manage") && <button className="secondary-btn" disabled={busy} onClick={() => void openAdjustments(i)}>بنود المكافآت والخصومات</button>}
          {has("attendance.view") && <button className="secondary-btn" onClick={() => void openAttendance(i)}>سجل الحضور والانصراف</button>}
          {(payroll.period?.status === "APPROVED" || payroll.period?.status === "CLOSED") && has("payroll.pay") && Number(i.remaining_amount) > 0 && <button className="primary-button" onClick={() => {setPayTarget(i);setPayAmount(String(i.remaining_amount));setPayDate(today());setPayMethod("CASH");setFromCustody(true);setCustodyEmployeeId("");setPayReference("");setPayNotes("");setPaymentIdempotencyKey(crypto.randomUUID());void refreshCustodyHolders(today());}}>صرف</button>}
          {has("payroll.view") && <button className="secondary-btn" onClick={() => window.open("/payroll/slip?month="+encodeURIComponent(month)+"&item="+encodeURIComponent(i.id), "_blank", "noopener,noreferrer")}>مفردات المرتب</button>}
          {has("payroll.view") && Number(i.paid_amount) > 0 && <button className="secondary-btn" onClick={() => void showPaymentHistory(i)}>سجل الصرف</button>}
        </div></td>
      </tr>
    );
  })}</tbody></table></div>}
  </section>
  <section className="card"><div className="card-header"><h2 className="card-title">الرواتب الأساسية الحالية</h2></div><div className="table-wrap"><table><thead><tr><th>الموظف</th><th>القسم</th><th>الراتب الشهري</th><th>ساري من</th><th>الحالة</th></tr></thead><tbody>{employees.filter(e=>e.salary_profile_id).map(e=><tr key={e.id}><td>{e.full_name}<div className="form-hint">{e.code}</div></td><td>{e.department_name||"—"}</td><td>{money(e.monthly_salary||0)} ج.م</td><td>{e.effective_from?new Date(e.effective_from+"T00:00:00").toLocaleDateString("ar-EG"):"—"}</td><td><span className={"status "+(e.is_active?"success":"muted")}>{e.is_active?"نشط":"غير نشط"}</span></td></tr>)}{!employees.some(e=>e.salary_profile_id)&&<tr><td colSpan={5} className="empty">لم يتم تعريف رواتب أساسية بعد.</td></tr>}</tbody></table></div></section>
 </section>
 {adjustmentTarget&&<div className="modal-backdrop" onClick={()=>setAdjustmentTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">بنود المكافآت والخصومات</h2><div className="form-hint">{adjustmentTarget.employee_name} · كل مكافأة أو خصم يُسجل ببيان مستقل</div></div><button className="secondary-btn" onClick={()=>setAdjustmentTarget(null)}>إغلاق</button></div>
  {payroll.period?.status==="DRAFT"&&has("payroll.manage")&&<form onSubmit={addAdjustment}><div className="form-grid">
   <label>نوع البند<SearchableSelect value={lineType} onChange={v=>setLineType(v as "BONUS"|"DEDUCTION")} options={[{value:"BONUS",label:"مكافأة / بونص"},{value:"DEDUCTION",label:"خصم"}]}/></label>
   <label>البيان<input value={lineDescription} onChange={e=>setLineDescription(e.target.value)} placeholder={lineType==="BONUS"?"مثال: بونص إنتاج":"مثال: خصم تأخير"} minLength={2} maxLength={240} required/></label>
   <label>المبلغ بالجنيه<input type="number" min="0.01" step="0.01" value={lineAmount} onChange={e=>setLineAmount(e.target.value)} required/></label>
   <label>ملاحظات (اختياري)<input value={lineNotes} onChange={e=>setLineNotes(e.target.value)} maxLength={1000}/></label>
  </div><div className="form-actions"><button className="primary-button" disabled={busy||!lineDescription.trim()||Number(lineAmount)<=0}>{editingLineId?"حفظ التعديل":"إضافة البند"}</button>{editingLineId&&<button type="button" className="secondary-btn" onClick={()=>{setEditingLineId(null);setLineType("BONUS");setLineDescription("");setLineAmount("");setLineNotes("")}}>إلغاء التعديل</button>}</div></form>}
  {adjustmentLoading?<div className="empty">جارٍ تحميل البنود...</div>:<div className="table-wrap"><table><thead><tr><th>النوع</th><th>البيان</th><th>المبلغ</th><th>ملاحظات</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{adjustmentLines.map(line=><tr key={line.id}><td>{line.line_type==="BONUS"?"مكافأة / بونص":"خصم"}</td><td>{line.description}{line.status==="VOIDED"&&line.void_reason?<div className="form-hint">سبب الإلغاء: {line.void_reason}</div>:null}</td><td className="strong">{money(line.amount)} ج.م</td><td>{line.notes||"—"}</td><td>{line.status==="VOIDED"?"ملغي":"نشط"}</td><td>{payroll.period?.status==="DRAFT"&&has("payroll.manage")&&line.status==="ACTIVE"&&<div className="row-actions"><button className="secondary-btn" disabled={busy} onClick={()=>{setEditingLineId(line.id);setLineType(line.line_type);setLineDescription(line.description);setLineAmount(String(line.amount));setLineNotes(line.notes||"")}}>تعديل</button><button className="secondary-btn" disabled={busy} onClick={()=>void deleteAdjustment(line)}>إلغاء</button></div>}</td></tr>)}{!adjustmentLines.length&&<tr><td colSpan={6} className="empty">لا توجد بنود مسجلة لهذا الموظف.</td></tr>}</tbody></table></div>}
  <div className="stats"><article className="card stat"><div className="stat-label">إجمالي المكافآت</div><div className="stat-value">{money(adjustmentLines.filter(x=>x.line_type==="BONUS").reduce((s,x)=>s+Number(x.amount),0))} ج.م</div></article><article className="card stat"><div className="stat-label">إجمالي الخصومات</div><div className="stat-value">{money(adjustmentLines.filter(x=>x.line_type==="DEDUCTION").reduce((s,x)=>s+Number(x.amount),0))} ج.م</div></article></div>
 </div></div>}
 {historyTarget&&<div className="modal-backdrop" onClick={()=>setHistoryTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">سجل صرف الراتب</h2><div className="form-hint">{historyTarget.employee_name} · إجمالي المدفوع {money(historyTarget.paid_amount)} ج.م</div></div><button className="secondary-btn" onClick={()=>setHistoryTarget(null)}>إغلاق</button></div>{historyLoading?<div className="empty">جارٍ تحميل سجل الصرف...</div>:!paymentHistory.length?<div className="empty">لا توجد عمليات صرف مسجلة.</div>:<div className="table-wrap"><table><thead><tr><th>تاريخ الصرف</th><th>المبلغ</th><th>الطريقة</th><th>المرجع/الإيصال</th><th>المسجل بواسطة</th><th>ملاحظات</th></tr></thead><tbody>{paymentHistory.map(p=><tr key={p.id}><td>{String(p.payment_date).slice(0,10)}</td><td className="strong">{money(p.amount)} ج.م</td><td>{paymentMethodLabel[p.payment_method||""]||p.payment_method||"—"}</td><td>{p.reference||"—"}</td><td>{p.paid_by_username||"—"}</td><td>{p.notes||"—"}</td></tr>)}</tbody></table></div>}</div></div>}
 {attendanceTarget&&<div className="modal-backdrop" onClick={()=>setAttendanceTarget(null)}><div className="modal-card" style={{maxWidth:1100}} onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">سجل الحضور والانصراف الشهري</h2><div className="form-hint">{attendanceTarget.employee_name} · {month} · سجل يومي من ١ إلى آخر يوم في الشهر</div></div><button className="secondary-btn" onClick={()=>setAttendanceTarget(null)}>إغلاق</button></div><div className="form-hint" style={{marginBottom:12}}>السجل مأخوذ من تقرير الحضور والانصراف وجدول الورديات. بعد اعتماد المسير، يعرض النسخة المحفوظة وقت الاعتماد حتى لو تغير تقرير البصمات لاحقًا. غياب اليوم أو نقص البصمة لا يخصم من المرتب تلقائيًا؛ المدير يراجع السجل ثم يسجل أي خصم ببيان مستقل في المسودة.</div>{attendanceLoading?<div className="empty">جارٍ تحميل سجل الشهر...</div>:<div className="table-wrap"><table><thead><tr><th>اليوم</th><th>التاريخ</th><th>الوردية</th><th>الحالة</th><th>أول حضور</th><th>آخر انصراف</th><th>ساعات العمل</th><th>إضافي</th><th>تأخير (د)</th><th>انصراف مبكر (د)</th><th>مراجعة</th></tr></thead><tbody>{Array.from({length:new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate()},(_,idx)=>{const date=month+"-"+String(idx+1).padStart(2,"0");const day=attendanceDays.find(x=>x.date===date);return <tr key={date}><td>{idx+1}</td><td>{date}</td><td>{day?.scheduledStart&&day?.scheduledEnd?day.scheduledStart+" - "+day.scheduledEnd:day?.isDayOff?"راحة":"—"}</td><td>{day?attendanceStatus[day.status]||day.status:"لا توجد بيانات"}</td><td>{day?.firstIn?new Date(day.firstIn).toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"}):"—"}</td><td>{day?.lastOut?new Date(day.lastOut).toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"}):"—"}</td><td>{day?Number(day.workedHours).toFixed(2):"—"}</td><td>{day?(Number(day.overtimeMinutes??0)/60).toFixed(2):"—"}</td><td>{day?.lateMinutes??"—"}</td><td>{day?.earlyMinutes??"—"}</td><td>{day?.needsReview?"تحتاج مراجعة":day?"—":"—"}{day&&(day.suspiciousCount>0||day.duplicatePunchCount>0)?" · بصمات مشتبه بها/مكررة":""}</td></tr>})}</tbody></table></div>}</div></div>}
 {payTarget&&<div className="modal-backdrop" onClick={()=>setPayTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">صرف راتب</h2><div className="form-hint">{payTarget.employee_name} · المتبقي {money(payTarget.remaining_amount)} ج.م</div></div><button className="secondary-btn" onClick={()=>setPayTarget(null)}>إغلاق</button></div><form onSubmit={submitPayment}><div className="form-grid"><label>مبلغ الصرف (ج.م)<input type="number" min="0.01" max={Number(payTarget.remaining_amount)} step="0.01" value={payAmount} onChange={e=>{setPayAmount(e.target.value);setPaymentIdempotencyKey(crypto.randomUUID())}} required/></label><label>تاريخ الصرف<input type="date" value={payDate} onChange={e=>{setPayDate(e.target.value);setPaymentIdempotencyKey(crypto.randomUUID());if(payMethod==="CASH")void refreshCustodyHolders(e.target.value)}} required/></label><label>طريقة الصرف<select value={payMethod} onChange={e=>{const method=e.target.value;setPayMethod(method);setFromCustody(method==="CASH");setCustodyEmployeeId("");setPaymentIdempotencyKey(crypto.randomUUID())}}><option value="CASH">نقدي</option><option value="BANK_TRANSFER">تحويل بنكي</option><option value="WALLET">محفظة إلكترونية</option><option value="OTHER">أخرى</option></select></label>{payMethod==="CASH"&&<label>العهدة التي تم الصرف منها<select value={custodyEmployeeId} onChange={e=>{setCustodyEmployeeId(e.target.value);setPaymentIdempotencyKey(crypto.randomUUID())}} required><option value="">اختر صاحب العهدة</option>{custodyHolders.map(e=><option key={e.id} value={e.id}>{e.full_name} · {e.code} · الرصيد {money(e.balance)} ج.م</option>)}</select><span className="form-hint">{custodyLoading?"جارٍ تحديث أرصدة العهد...":"سيُخصم الصرف من رصيد عهدة الموظف المحدد، وليس بالضرورة عهدة المستخدم الذي يسجل العملية."}</span></label>}<label>رقم مرجعي/إيصال<input value={payReference} onChange={e=>{setPayReference(e.target.value);setPaymentIdempotencyKey(crypto.randomUUID())}}/></label><label style={{gridColumn:"1 / -1"}}>ملاحظات<textarea rows={2} value={payNotes} onChange={e=>{setPayNotes(e.target.value);setPaymentIdempotencyKey(crypto.randomUUID())}}/></label></div>{payMethod!=="CASH"&&<div className="form-hint">سيُسجل الدفع كتحويل/وسيلة غير نقدية، ولن تُسجل حركة خروج من عهدة نقدية.</div>}<div className="form-actions"><button className="secondary-btn" type="button" onClick={()=>setPayTarget(null)}>إلغاء</button><button className="primary-button" disabled={busy||Number(payAmount)<=0||Number(payAmount)>Number(payTarget.remaining_amount)||(payMethod==="CASH"&&!custodyEmployeeId)}>تأكيد الصرف</button></div></form></div></div>}
 </main></div>;
}
