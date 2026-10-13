"use client";
import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {formatMoney,formatQuantity} from "../../lib/format";
import {SearchableSelect} from "../../components/searchable-select";

type Advance={id:string;code:string;employee_id:string;employee_name:string;amount:number;reason:string;status:string;created_at:string;rejection_reason:string|null;repayment_method:string;installment_amount:number|null;salary_percentage:number|null;production_percentage:number|null;production_period_days?:number;production_minimum_earning?:number|null;production_installment_amount?:number|null;repaid_amount:number;remaining_amount:number;account_balance?:number;repayment_status:string};
type SettlementResult={employee:{full_name:string};grossAmount:number;cashPaid:number;advanceRepaymentAmount:number;availableBefore:number;repayments:Array<{advanceCode:string;amount:number;remaining:number}>};
type MyAccount={employee:{full_name:string;code:string};accountBalance:number;advances:Advance[];scheduledDeductions:Array<{period_month:string;amount:number;advance_code:string;repayment_type:string}>;ledger:Array<{id:string;code:string;entry_type:string;credit_amount:number;debit_amount:number;notes:string|null;created_at:string}>};
type Employee={id:string;full_name:string;code:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
const labels:Record<string,string>={PENDING:"قيد الاعتماد",APPROVED:"معتمدة",REJECTED:"مرفوضة",PAID:"مصروفة",CANCELLED:"ملغاة"};
const repaymentLabels:Record<string,string>={FIXED_INSTALLMENT:"قسط شهري ثابت",SALARY_PERCENTAGE:"نسبة من الراتب",PRODUCTION_PERCENTAGE:"استقطاع دوري من الإنتاج",CUSTOM:"سداد يدوي حسب الاتفاق"};

export default function AdvancesPage(){
 const {has,permissions}=usePermissions();
 const [items,setItems]=useState<Advance[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[employeeId,setEmployeeId]=useState(""),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[method,setMethod]=useState("CUSTOM"),[installment,setInstallment]=useState(""),[salaryPercentage,setSalaryPercentage]=useState(""),[percentage,setPercentage]=useState(""),[productionPeriodDays,setProductionPeriodDays]=useState("15"),[productionMinimumEarning,setProductionMinimumEarning]=useState(""),[productionInstallmentAmount,setProductionInstallmentAmount]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const [settleEmployeeId,setSettleEmployeeId]=useState(""),[settleGrossAmount,setSettleGrossAmount]=useState(""),[settleAdvanceId,setSettleAdvanceId]=useState(""),[settleRepaymentAmount,setSettleRepaymentAmount]=useState(""),[settleNotes,setSettleNotes]=useState(""),[settleAdvances,setSettleAdvances]=useState<Advance[]>([]),[settling,setSettling]=useState(false),[settlementResult,setSettlementResult]=useState<SettlementResult|null>(null),[myAccount,setMyAccount]=useState<MyAccount|null>(null);
 async function load(){
  try{
   const suffix=employeeId?"?employeeId="+encodeURIComponent(employeeId):"";
   const a=await api<{data:Advance[]}>("/api/advances"+suffix);setItems(a.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل السلف")}
 }
 useEffect(()=>{void load()},[employeeId]);
 useEffect(()=>{
  if(!settleEmployeeId){setSettleAdvances([]);setSettleAdvanceId("");return}
  let active=true;
  api<{data:Advance[]}>("/api/advances?employeeId="+encodeURIComponent(settleEmployeeId))
   .then(r=>{if(active){setSettleAdvances(r.data.filter(x=>x.status==="PAID"&&x.repayment_status==="OPEN"&&Number(x.remaining_amount)>0));setSettleAdvanceId("");}})
   .catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل سلف العامل")});
  return()=>{active=false};
 },[settleEmployeeId]);
 // Load the picker independently from the advances ledger. The session permissions arrive
 // asynchronously, and creating an advance must not depend on permission to view the ledger.
 useEffect(()=>{
  if(!permissions?.includes("advances.view_own")&&!permissions?.includes("advances.view"))return;
  let active=true;
  api<{data:MyAccount}>("/api/advances/my-account")
   .then(r=>{if(active)setMyAccount(r.data)})
   .catch(()=>{if(active)setMyAccount(null)});
  return()=>{active=false};
 },[permissions,items]);
 useEffect(()=>{
  if(!permissions?.includes("advances.create"))return;
  let active=true;
  api<{data:Employee[]}>("/api/advances/eligible-employees")
   .then(r=>{if(active)setEmployees(r.data)})
   .catch(e=>{if(active)setError(e instanceof Error?e.message:"تعذر تحميل قائمة الموظفين")});
  return()=>{active=false};
 },[permissions]);
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{
  await api("/api/advances",{method:"POST",body:JSON.stringify({
   employeeId,amount:Number(normalizeNumber(amount)),reason,repaymentMethod:method,
   installmentAmount:method==="FIXED_INSTALLMENT"?Number(normalizeNumber(installment)):undefined,
   salaryPercentage:method==="SALARY_PERCENTAGE"?Number(normalizeNumber(salaryPercentage)):undefined,
   productionPercentage:method==="PRODUCTION_PERCENTAGE"&&productionInstallmentAmount.trim()===""?Number(normalizeNumber(percentage)):undefined,
   productionPeriodDays:method==="PRODUCTION_PERCENTAGE"?Number(normalizeNumber(productionPeriodDays)):15,
   productionMinimumEarning:method==="PRODUCTION_PERCENTAGE"&&productionMinimumEarning.trim()!==""?Number(normalizeNumber(productionMinimumEarning)):undefined,
   productionInstallmentAmount:method==="PRODUCTION_PERCENTAGE"&&productionInstallmentAmount.trim()!==""?Number(normalizeNumber(productionInstallmentAmount)):undefined
  })});
  setAmount("");setReason("");setEmployeeId("");setMethod("CUSTOM");setInstallment("");setSalaryPercentage("");setPercentage("");setProductionPeriodDays("15");setProductionMinimumEarning("");setProductionInstallmentAmount("");await load();
 }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء السلفة")}finally{setSaving(false)}}
 async function action(id:string,a:"approve"|"reject"|"pay"){try{if(a==="reject"){const r=window.prompt("سبب الرفض؟");if(!r)return;await api("/api/advances/"+id+"/reject",{method:"POST",body:JSON.stringify({reason:r})})}else await api("/api/advances/"+id+"/"+a,{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ العملية")}}
 async function repay(id:string,remaining:number){
  const raw=window.prompt("مبلغ السداد — المتبقي "+remaining);if(raw===null)return;
  const amountValue=Number(normalizeNumber(raw));if(!Number.isFinite(amountValue)||amountValue<=0){setError("مبلغ السداد غير صحيح");return}
  try{await api("/api/advances/"+id+"/repayments",{method:"POST",body:JSON.stringify({amount:amountValue,repaymentType:"CUSTOM"})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل السداد")}
 }
 async function settleProduction(e:FormEvent){
  e.preventDefault();setSettling(true);setError("");setSettlementResult(null);
  try{
   const repaymentValue=settleRepaymentAmount.trim()===""?0:Number(normalizeNumber(settleRepaymentAmount));
   const repayments=settleAdvanceId&&repaymentValue>0?[{advanceId:settleAdvanceId,amount:repaymentValue}]:[];
   const r=await api<{data:SettlementResult}>("/api/production/earnings/settlements",{method:"POST",body:JSON.stringify({
    employeeId:settleEmployeeId,grossAmount:Number(normalizeNumber(settleGrossAmount)),notes:settleNotes.trim()||undefined,repayments
   })});
   setSettlementResult(r.data);setSettleGrossAmount("");setSettleRepaymentAmount("");setSettleAdvanceId("");setSettleNotes("");
   await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر صرف مستحقات العامل")}finally{setSettling(false)}
 }
 return <div className="app-shell"><Sidebar active="/advances"/><main className="main"><header className="topbar"><div><h1 className="page-title">السلف</h1><p className="page-subtitle">سلف الموظفين تُسجّل إداريًا فقط، مع صرف واعتماد وسجل سداد كامل.</p></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 {myAccount&&<section className="card">
  <div className="card-header"><div><h2 className="card-title">حسابي ومستحقاتي</h2><div className="form-hint">{myAccount.employee.full_name} — رصيد الحساب يشمل المستحقات المعتمدة والسلف والتسويات.</div></div></div>
  <div className="stats-grid">
   <div className="stat-card"><div className="stat-label">صافي رصيد الحساب</div><div className="stat-value" style={{color:Number(myAccount.accountBalance)<0?"#dc2626":"#15803d"}}>{formatMoney(myAccount.accountBalance)} ج.م</div><div className="form-hint">{Number(myAccount.accountBalance)<0?"الرصيد بالسالب يعني عليك مستحقات/سلف لم تتم تسويتها بعد.":"ده صافي رصيد حسابك الحالي."}</div></div>
   <div className="stat-card"><div className="stat-label">السلف المفتوحة</div><div className="stat-value">{myAccount.advances.length}</div><div className="form-hint">المتبقي الإجمالي: {formatMoney(myAccount.advances.reduce((sum,a)=>sum+Number(a.remaining_amount),0))} ج.م</div></div>
  </div>
  {myAccount.advances.length>0&&<div className="table-wrap"><table><thead><tr><th>السلفة</th><th>الأصل</th><th>المسدّد</th><th>الباقي</th><th>طريقة السداد</th></tr></thead><tbody>{myAccount.advances.map(a=><tr key={a.id}><td>{a.code}</td><td className="money">{formatMoney(a.amount)}</td><td className="money">{formatMoney(a.repaid_amount)}</td><td className="money">{formatMoney(a.remaining_amount)}</td><td>{repaymentLabels[a.repayment_method]||a.repayment_method}</td></tr>)}</tbody></table></div>}
  {myAccount.scheduledDeductions.length>0&&<div className="table-wrap"><h3 className="card-title" style={{margin:"12px 0"}}>استقطاعات سلف مستحقة من مرتبات لم تُصرف بعد</h3><table><thead><tr><th>الشهر</th><th>السلفة</th><th>القسط المستحق</th></tr></thead><tbody>{myAccount.scheduledDeductions.map((d,i)=><tr key={i}><td>{String(d.period_month).slice(0,7)}</td><td>{d.advance_code}</td><td className="money">{formatMoney(d.amount)} ج.م</td></tr>)}</tbody></table></div>}
  <div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>البيان</th><th>دائن</th><th>مدين</th></tr></thead><tbody>{myAccount.ledger.slice(0,8).map(x=><tr key={x.id}><td>{new Date(x.created_at).toLocaleDateString("ar-EG")}</td><td>{x.notes||x.entry_type}</td><td className="money">{formatMoney(x.credit_amount)}</td><td className="money">{formatMoney(x.debit_amount)}</td></tr>)}{!myAccount.ledger.length&&<tr><td colSpan={4}>لا توجد حركات مسجلة.</td></tr>}</tbody></table></div>
 </section>}
 {has("advances.create")&&<form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">إضافة سلفة لموظف</h2><div className="form-hint">العامل لا ينشئ السلفة؛ الإدارة/الحسابات تسجلها على حساب الموظف.</div></div></div>
  <div className="form-grid">
   <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.filter(x=>x.id).map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>
   <label>المبلغ<input type="text" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="مثال: ٥٠٠ أو 500.50" required/></label>
   <label>طريقة السداد<select value={method} onChange={e=>setMethod(e.target.value)}><option value="CUSTOM">دفعات مخصصة</option><option value="FIXED_INSTALLMENT">قيمة ثابتة كل شهر</option><option value="SALARY_PERCENTAGE">نسبة من الراتب الشهري</option><option value="PRODUCTION_PERCENTAGE">نسبة من الإنتاج</option></select></label>
   {method==="FIXED_INSTALLMENT"&&<label>قيمة القسط الشهري (ج.م)<input type="text" inputMode="decimal" value={installment} onChange={e=>setInstallment(e.target.value)} required/></label>}
   {method==="SALARY_PERCENTAGE"&&<label>نسبة الخصم من الراتب %<input type="text" inputMode="decimal" value={salaryPercentage} onChange={e=>setSalaryPercentage(e.target.value)} required/><span className="form-hint">تُحسب على الراتب الأساسي الشهري، ولا تتجاوز المتاح بعد الخصومات الأخرى.</span></label>}
   {method==="PRODUCTION_PERCENTAGE"&&<>
    <label>دورة الاستحقاق (أيام)<input type="text" inputMode="numeric" value={productionPeriodDays} onChange={e=>setProductionPeriodDays(e.target.value)} required/><span className="form-hint">مثال: ١٠ أو ١٥ يومًا. لا يُسجل السداد قبل حلول الدورة وصرف مستحقات العامل.</span></label>
    <label>حد أدنى لإنتاج الدورة (اختياري)<input type="text" inputMode="decimal" value={productionMinimumEarning} onChange={e=>setProductionMinimumEarning(e.target.value)} placeholder="مثال: ٢٠٠٠"/></label>
    <label>قسط ثابت للدورة (اختياري)<input type="text" inputMode="decimal" value={productionInstallmentAmount} onChange={e=>setProductionInstallmentAmount(e.target.value)} placeholder="مثال: ٥٠٠" required={percentage.trim()===""}/></label>
    <label>أو نسبة من إنتاج الدورة %<input type="text" inputMode="decimal" value={percentage} onChange={e=>setPercentage(e.target.value)} placeholder="مثال: ٢٥" required={productionInstallmentAmount.trim()===""}/><span className="form-hint">اختار قسطًا ثابتًا أو نسبة فقط. الاستقطاع يُحسب عند صرف المستحقات، وليس عند اعتماد الإنتاج.</span></label>
   </>}
   <label style={{gridColumn:"1/-1"}}>السبب<input value={reason} onChange={e=>setReason(e.target.value)} required/></label>
  </div>
  <div className="form-actions"><button className="primary-button" disabled={saving||!employeeId}>{saving?"جارٍ الحفظ...":"حفظ السلفة"}</button></div>
 </form>}
 {has("production.adjustments.create")&&<form className="card form-card" onSubmit={settleProduction}>
  <div className="card-header"><div><h2 className="card-title">صرف مستحقات الإنتاج وتسوية السلف</h2><div className="form-hint">تكلفة الإنتاج تظل بالقيمة الإجمالية. النظام يسجل إجمالي التسوية خارجًا، واسترداد السلفة داخلًا، وصافي النقد المدفوع للعامل.</div></div></div>
  <div className="form-grid">
   <label>العامل<SearchableSelect value={settleEmployeeId} onChange={setSettleEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر العامل"/></label>
   <label>إجمالي مستحقات الإنتاج المراد تسويتها (ج.م)<input type="text" inputMode="decimal" value={settleGrossAmount} onChange={e=>setSettleGrossAmount(e.target.value)} required placeholder="مثال: ٢٠٠٠"/></label>
   <label>سلفة للخصم اليدوي (اختياري)<select value={settleAdvanceId} onChange={e=>setSettleAdvanceId(e.target.value)}><option value="">الاستقطاع الدوري فقط / بدون سلفة يدوية</option>{settleAdvances.map(a=><option key={a.id} value={a.id}>{a.code} — متبقي {formatMoney(a.remaining_amount)} ج.م</option>)}</select></label>
   <label>مبلغ الخصم اليدوي (ج.م)<input type="text" inputMode="decimal" value={settleRepaymentAmount} onChange={e=>setSettleRepaymentAmount(e.target.value)} placeholder="مثال: ٥٠٠"/></label>
   <label style={{gridColumn:"1/-1"}}>ملاحظات (اختياري)<input value={settleNotes} onChange={e=>setSettleNotes(e.target.value)} placeholder="مثال: صرف إنتاج آخر ١٥ يومًا"/></label>
  </div>
  <div className="form-actions"><button className="primary-button" disabled={settling||!settleEmployeeId||!settleGrossAmount}>{settling?"جارٍ تسجيل التسوية...":"تأكيد الصرف والتسوية"}</button></div>
  {settlementResult&&<div className="alert success" style={{marginTop:12}}>
   <strong>تمت تسوية مستحقات {settlementResult.employee.full_name}</strong>
   <div>إجمالي المستحق: {formatMoney(settlementResult.grossAmount)} ج.م</div>
   <div>المخصوم للسلف: {formatMoney(settlementResult.advanceRepaymentAmount)} ج.م</div>
   <div>صافي المدفوع: {formatMoney(settlementResult.cashPaid)} ج.م</div>
   {settlementResult.repayments.map((x,i)=><div key={i}>{x.advanceCode}: سداد {formatMoney(x.amount)} ج.م — المتبقي {formatMoney(x.remaining)} ج.م</div>)}
  </div>}
 </form>}
 <section className="card"><div className="card-header"><div><h2 className="card-title">سجل السلف</h2><div className="form-hint">كل سلفة لها مبلغ أصلي، مدفوع، متبقي، وطريقة سداد.</div></div><span className="count-badge">{items.length}</span></div>
  <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>المبلغ</th><th>المدفوع</th><th>المتبقي</th><th>رصيد حساب العامل</th><th>طريقة السداد</th><th>التاريخ</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
  {items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.employee_name}</td><td className="money">{formatMoney(x.amount)}</td><td className="money">{formatMoney(x.repaid_amount||0)}</td><td className="money">{formatMoney(x.remaining_amount||0)}</td><td className="money" style={{color:Number(x.account_balance??0)<0?"#dc2626":undefined}}>{formatMoney(x.account_balance??0)}</td><td>{repaymentLabels[x.repayment_method]||x.repayment_method}{x.repayment_method==="FIXED_INSTALLMENT"&&x.installment_amount? <div className="form-hint">{formatMoney(x.installment_amount)} ج.م شهريًا</div>:null}{x.repayment_method==="SALARY_PERCENTAGE"&&x.salary_percentage? <div className="form-hint">{formatQuantity(x.salary_percentage,2)}% من الراتب الأساسي</div>:null}{x.repayment_method==="PRODUCTION_PERCENTAGE"? <div className="form-hint">{x.production_installment_amount?formatMoney(x.production_installment_amount)+" ج.م":formatQuantity(x.production_percentage??0,2)+"%"} كل {x.production_period_days??15} يومًا{x.production_minimum_earning? " عند بلوغ "+formatMoney(x.production_minimum_earning)+" ج.م إنتاج":""}</div>:null}{["FIXED_INSTALLMENT","SALARY_PERCENTAGE","PRODUCTION_PERCENTAGE"].includes(x.repayment_method)?<div className="form-hint">السداد يُسجل آليًا</div>:null}</td><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td><td><span className={"status "+x.status.toLowerCase()}>{labels[x.status]||x.status}{x.repayment_status==="SETTLED"?" · مسددة":""}</span></td><td>
   {x.status==="PENDING"&&<div className="row-actions">{has("advances.approve")&&<button className="approve-button" onClick={()=>action(x.id,"approve")}>اعتماد</button>}{has("advances.reject")&&<button className="reject-button" onClick={()=>action(x.id,"reject")}>رفض</button>}</div>}
   {x.status==="APPROVED"&&has("advances.pay")&&<button className="approve-button" onClick={()=>action(x.id,"pay")}>صرف السلفة</button>}
   {x.status==="PAID"&&x.repayment_status==="OPEN"&&has("advances.repay")&&<button className="secondary-btn" onClick={()=>repay(x.id,Number(x.remaining_amount))}>تسجيل سداد</button>}
  </td></tr>)}
  {!items.length&&<tr><td colSpan={10}>لا توجد سلف.</td></tr>}</tbody></table></div>
 </section>
 </section></main></div>
}
