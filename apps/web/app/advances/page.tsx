"use client";
import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Advance={id:string;code:string;employee_name:string;amount:number;reason:string;status:string;created_at:string;rejection_reason:string|null;repayment_method:string;installment_amount:number|null;production_percentage:number|null;repaid_amount:number;remaining_amount:number;repayment_status:string;requested_by_username?:string|null;reviewed_by_username?:string|null;paid_by_username?:string|null};
type Repayment={id:string;amount:number;payment_date:string;notes:string|null;created_by_username:string};
type Employee={id:string;full_name:string;code:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
const labels:Record<string,string>={PENDING:"قيد الاعتماد",APPROVED:"معتمدة",REJECTED:"مرفوضة",PAID:"مصروفة",CANCELLED:"ملغاة"};
const repaymentLabels:Record<string,string>={FIXED_INSTALLMENT:"قسط ثابت",PRODUCTION_PERCENTAGE:"نسبة من الإنتاج",CUSTOM:"دفعات مخصصة"};

export default function AdvancesPage(){
 const {has,permissions}=usePermissions();
 const [items,setItems]=useState<Advance[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[employeeId,setEmployeeId]=useState(""),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[method,setMethod]=useState("CUSTOM"),[installment,setInstallment]=useState(""),[percentage,setPercentage]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const [filterEmployeeId,setFilterEmployeeId]=useState(""),[statusFilter,setStatusFilter]=useState(""),[repaymentFilter,setRepaymentFilter]=useState(""),[filterFrom,setFilterFrom]=useState(""),[filterTo,setFilterTo]=useState(""),[search,setSearch]=useState("");
 const [repaymentTarget,setRepaymentTarget]=useState(""),[repayments,setRepayments]=useState<Repayment[]>([]),[repaymentsLoading,setRepaymentsLoading]=useState(false);
 async function load(){
  try{
   const q=new URLSearchParams();if(filterEmployeeId)q.set("employeeId",filterEmployeeId);if(statusFilter)q.set("status",statusFilter);if(repaymentFilter)q.set("repaymentStatus",repaymentFilter);if(filterFrom)q.set("from",filterFrom);if(filterTo)q.set("to",filterTo);if(search.trim())q.set("q",search.trim());
   const a=await api<{data:Advance[]}>("/api/advances"+(q.toString()?"?"+q.toString():""));setItems(a.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل السلف")}
 }
 useEffect(()=>{void load()},[filterEmployeeId,statusFilter,repaymentFilter,filterFrom,filterTo,search]);
 // Load the picker independently from the advances ledger. The session permissions arrive
 // asynchronously, and creating an advance must not depend on permission to view the ledger.
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
   productionPercentage:method==="PRODUCTION_PERCENTAGE"?Number(normalizeNumber(percentage)):undefined
  })});
  setAmount("");setReason("");setEmployeeId("");setMethod("CUSTOM");setInstallment("");setPercentage("");await load();
 }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء السلفة")}finally{setSaving(false)}}
 async function action(id:string,a:"approve"|"reject"|"pay"){try{if(a==="reject"){const r=window.prompt("سبب الرفض؟");if(!r)return;await api("/api/advances/"+id+"/reject",{method:"POST",body:JSON.stringify({reason:r})})}else await api("/api/advances/"+id+"/"+a,{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ العملية")}}
 async function toggleRepayments(id:string){
  if(repaymentTarget===id){setRepaymentTarget("");setRepayments([]);return}
  setRepaymentTarget(id);setRepaymentsLoading(true);setError("");
  try{setRepayments((await api<{data:Repayment[]}>("/api/advances/"+id+"/repayments")).data)}
  catch(e){setError(e instanceof Error?e.message:"تعذر تحميل سجل السداد")}finally{setRepaymentsLoading(false)}
 }
 async function repay(id:string,remaining:number){
  const raw=window.prompt("مبلغ السداد — المتبقي "+remaining);if(raw===null)return;
  const amountValue=Number(normalizeNumber(raw));if(!Number.isFinite(amountValue)||amountValue<=0){setError("مبلغ السداد غير صحيح");return}
  try{await api("/api/advances/"+id+"/repayments",{method:"POST",body:JSON.stringify({amount:amountValue,repaymentType:"CUSTOM"})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل السداد")}
 }
 return <div className="app-shell"><Sidebar active="/advances"/><main className="main"><header className="topbar"><div><h1 className="page-title">السلف</h1><p className="page-subtitle">سلف الموظفين تُسجّل إداريًا فقط، مع صرف واعتماد وسجل سداد كامل.</p></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 <section className="card"><div className="card-header"><div><h2 className="card-title">فلترة السلف</h2><div className="form-hint">ابحث بالموظف أو الكود أو السبب، وفلتر حسب الحالة وفترة التسجيل.</div></div></div>
  <div className="form-grid finance-four-grid">
   <label>الموظف<select value={filterEmployeeId} onChange={e=>setFilterEmployeeId(e.target.value)}><option value="">كل الموظفين</option>{employees.map(x=><option key={x.id} value={x.id}>{x.full_name} — {x.code}</option>)}</select></label>
   <label>حالة السلفة<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="">كل الحالات</option><option value="PENDING">قيد الاعتماد</option><option value="APPROVED">معتمدة</option><option value="REJECTED">مرفوضة</option><option value="PAID">مصروفة</option><option value="CANCELLED">ملغاة</option></select></label>
   <label>حالة السداد<select value={repaymentFilter} onChange={e=>setRepaymentFilter(e.target.value)}><option value="">كل حالات السداد</option><option value="OPEN">متبقي سداد</option><option value="SETTLED">مسددة بالكامل</option></select></label>
   <label>بحث بالاسم أو الكود أو السبب<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="اسم الموظف أو سبب السلفة"/></label>
   <label>من تاريخ<input type="date" value={filterFrom} onChange={e=>setFilterFrom(e.target.value)}/></label>
   <label>إلى تاريخ<input type="date" value={filterTo} onChange={e=>setFilterTo(e.target.value)}/></label>
   <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>{setFilterEmployeeId("");setStatusFilter("");setRepaymentFilter("");setFilterFrom("");setFilterTo("");setSearch("")}}>مسح الفلاتر</button></div>
  </div>
 </section>
 {has("advances.create")&&<form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">إضافة سلفة لموظف</h2><div className="form-hint">العامل لا ينشئ السلفة؛ الإدارة/الحسابات تسجلها على حساب الموظف.</div></div></div>
  <div className="form-grid">
   <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.filter(x=>x.id).map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>
   <label>المبلغ<input type="text" inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="مثال: ٥٠٠ أو 500.50" required/></label>
   <label>طريقة السداد<select value={method} onChange={e=>setMethod(e.target.value)}><option value="CUSTOM">دفعات مخصصة</option><option value="FIXED_INSTALLMENT">قسط ثابت</option><option value="PRODUCTION_PERCENTAGE">نسبة من الإنتاج</option></select></label>
   {method==="FIXED_INSTALLMENT"&&<label>قيمة القسط<input type="text" inputMode="decimal" value={installment} onChange={e=>setInstallment(e.target.value)} required/></label>}
   {method==="PRODUCTION_PERCENTAGE"&&<label>النسبة %<input type="text" inputMode="decimal" value={percentage} onChange={e=>setPercentage(e.target.value)} required/></label>}
   <label style={{gridColumn:"1/-1"}}>السبب<input value={reason} onChange={e=>setReason(e.target.value)} required/></label>
  </div>
  <div className="form-actions"><button className="primary-button" disabled={saving||!employeeId}>{saving?"جارٍ الحفظ...":"حفظ السلفة"}</button></div>
 </form>}
 <section className="card"><div className="card-header"><div><h2 className="card-title">سجل السلف</h2><div className="form-hint">كل سلفة لها مبلغ أصلي، مدفوع، متبقي، وطريقة سداد.</div></div><span className="count-badge">{items.length}</span></div>
  <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>المبلغ</th><th>المدفوع</th><th>المتبقي</th><th>سبب السلفة</th><th>طريقة السداد</th><th>تاريخ التسجيل</th><th>سجّلها</th><th>اعتمدها</th><th>صرفها</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
  {items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.employee_name}</td><td className="money">{Number(x.amount).toLocaleString("ar-EG")}</td><td className="money">{Number(x.repaid_amount||0).toLocaleString("ar-EG")}</td><td className="money">{Number(x.remaining_amount||0).toLocaleString("ar-EG")}</td><td>{x.reason}{x.rejection_reason&&<div className="form-hint">سبب الرفض: {x.rejection_reason}</div>}</td><td>{repaymentLabels[x.repayment_method]||x.repayment_method}{x.repayment_method==="FIXED_INSTALLMENT"&&x.installment_amount? <div className="form-hint">{Number(x.installment_amount).toLocaleString("ar-EG")} ج.م شهريًا</div>:null}{x.repayment_method==="PRODUCTION_PERCENTAGE"&&x.production_percentage? <div className="form-hint">{Number(x.production_percentage).toLocaleString("ar-EG")}% من الإنتاج المعتمد</div>:null}{x.repayment_method==="FIXED_INSTALLMENT"||x.repayment_method==="PRODUCTION_PERCENTAGE"?<div className="form-hint">السداد يُسجل آليًا</div>:null}</td><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td><td>{x.requested_by_username||"—"}</td><td>{x.reviewed_by_username||"—"}</td><td>{x.paid_by_username||"—"}</td><td><span className={"status "+x.status.toLowerCase()}>{labels[x.status]||x.status}{x.repayment_status==="SETTLED"?" · مسددة":""}</span></td><td>
   {x.status==="PENDING"&&<div className="row-actions">{has("advances.approve")&&<button className="approve-button" onClick={()=>action(x.id,"approve")}>اعتماد</button>}{has("advances.reject")&&<button className="reject-button" onClick={()=>action(x.id,"reject")}>رفض</button>}</div>}
   {x.status==="APPROVED"&&has("advances.pay")&&<button className="approve-button" onClick={()=>action(x.id,"pay")}>صرف السلفة</button>}
   {x.status==="PAID"&&x.repayment_status==="OPEN"&&has("advances.repay")&&<button className="secondary-btn" onClick={()=>repay(x.id,Number(x.remaining_amount))}>تسجيل سداد</button>}{x.status==="PAID"&&<button className="secondary-btn" onClick={()=>void toggleRepayments(x.id)}>{repaymentTarget===x.id?"إخفاء سجل السداد":"سجل السداد"}</button>}
  </td></tr>)}
  {!items.length&&<tr><td colSpan={13}>لا توجد سلف مطابقة للفلاتر.</td></tr>}</tbody></table></div>
 </section>
 {repaymentTarget&&<section className="card nested-card"><div className="card-header"><div><h3 className="card-title">سجل سداد السلفة</h3><div className="form-hint">كل دفعة تعرض التاريخ واسم الحساب الذي سجّلها.</div></div><button className="secondary-btn" onClick={()=>{setRepaymentTarget("");setRepayments([])}}>إغلاق</button></div>
   {repaymentsLoading?<div className="empty">جارٍ تحميل سجل السداد...</div>:<div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>المبلغ</th><th>البيان</th><th>الحساب المسجّل</th></tr></thead><tbody>{repayments.map(r=><tr key={r.id}><td>{new Date(r.payment_date).toLocaleDateString("ar-EG")}</td><td className="money">{Number(r.amount).toLocaleString("ar-EG",{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>{r.notes||"سداد سلفة"}</td><td>{r.created_by_username}</td></tr>)}{!repayments.length&&<tr><td colSpan={4}>لا توجد دفعات سداد مسجلة.</td></tr>}</tbody></table></div>}
  </section>}
 </section></main></div>
}
