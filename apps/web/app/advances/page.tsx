"use client";
import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Advance={id:string;code:string;employee_name:string;amount:number;reason:string;status:string;created_at:string;rejection_reason:string|null;repayment_method:string;installment_amount:number|null;production_percentage:number|null;repaid_amount:number;remaining_amount:number;repayment_status:string};
type Employee={id:string;full_name:string;code:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
const labels:Record<string,string>={PENDING:"قيد الاعتماد",APPROVED:"معتمدة",REJECTED:"مرفوضة",PAID:"مصروفة",CANCELLED:"ملغاة"};
const repaymentLabels:Record<string,string>={FIXED_INSTALLMENT:"قسط ثابت",PRODUCTION_PERCENTAGE:"نسبة من الإنتاج",CUSTOM:"دفعات مخصصة"};

export default function AdvancesPage(){
 const {has}=usePermissions();
 const [items,setItems]=useState<Advance[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[employeeId,setEmployeeId]=useState(""),[amount,setAmount]=useState(""),[reason,setReason]=useState(""),[method,setMethod]=useState("CUSTOM"),[installment,setInstallment]=useState(""),[percentage,setPercentage]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 async function load(){
  try{
   const suffix=employeeId?"?employeeId="+encodeURIComponent(employeeId):"";
   const a=await api<{data:Advance[]}>("/api/advances"+suffix);setItems(a.data);
   if(has("advances.create")&&!employees.length)setEmployees((await api<{data:Employee[]}>("/api/advances/eligible-employees")).data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل السلف")}
 }
 useEffect(()=>{void load()},[employeeId]);
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{
  await api("/api/advances",{method:"POST",body:JSON.stringify({
   employeeId,amount:Number(normalizeNumber(amount)),reason,repaymentMethod:method,
   installmentAmount:method==="FIXED_INSTALLMENT"?Number(normalizeNumber(installment)):undefined,
   productionPercentage:method==="PRODUCTION_PERCENTAGE"?Number(normalizeNumber(percentage)):undefined
  })});
  setAmount("");setReason("");setEmployeeId("");setMethod("CUSTOM");setInstallment("");setPercentage("");await load();
 }catch(e){setError(e instanceof Error?e.message:"تعذر إنشاء السلفة")}finally{setSaving(false)}}
 async function action(id:string,a:"approve"|"reject"|"pay"){try{if(a==="reject"){const r=window.prompt("سبب الرفض؟");if(!r)return;await api("/api/advances/"+id+"/reject",{method:"POST",body:JSON.stringify({reason:r})})}else await api("/api/advances/"+id+"/"+a,{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تنفيذ العملية")}}
 async function repay(id:string,remaining:number){
  const raw=window.prompt("مبلغ السداد — المتبقي "+remaining);if(raw===null)return;
  const amountValue=Number(normalizeNumber(raw));if(!Number.isFinite(amountValue)||amountValue<=0){setError("مبلغ السداد غير صحيح");return}
  try{await api("/api/advances/"+id+"/repayments",{method:"POST",body:JSON.stringify({amount:amountValue,repaymentType:"CUSTOM"})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل السداد")}
 }
 return <div className="app-shell"><Sidebar active="/advances"/><main className="main"><header className="topbar"><div><h1 className="page-title">السلف</h1><p className="page-subtitle">سلف الموظفين تُسجّل إداريًا فقط، مع صرف واعتماد وسجل سداد كامل.</p></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
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
  <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>المبلغ</th><th>المدفوع</th><th>المتبقي</th><th>طريقة السداد</th><th>التاريخ</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
  {items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.employee_name}</td><td className="money">{Number(x.amount).toLocaleString("ar-EG")}</td><td className="money">{Number(x.repaid_amount||0).toLocaleString("ar-EG")}</td><td className="money">{Number(x.remaining_amount||0).toLocaleString("ar-EG")}</td><td>{repaymentLabels[x.repayment_method]||x.repayment_method}</td><td>{new Date(x.created_at).toLocaleString("ar-EG")}</td><td><span className={"status "+x.status.toLowerCase()}>{labels[x.status]||x.status}{x.repayment_status==="SETTLED"?" · مسددة":""}</span></td><td>
   {x.status==="PENDING"&&<div className="row-actions">{has("advances.approve")&&<button className="approve-button" onClick={()=>action(x.id,"approve")}>اعتماد</button>}{has("advances.reject")&&<button className="reject-button" onClick={()=>action(x.id,"reject")}>رفض</button>}</div>}
   {x.status==="APPROVED"&&has("advances.pay")&&<button className="approve-button" onClick={()=>action(x.id,"pay")}>صرف السلفة</button>}
   {x.status==="PAID"&&x.repayment_status==="OPEN"&&has("advances.repay")&&<button className="secondary-btn" onClick={()=>repay(x.id,Number(x.remaining_amount))}>تسجيل سداد</button>}
  </td></tr>)}
  {!items.length&&<tr><td colSpan={9}>لا توجد سلف.</td></tr>}</tbody></table></div>
 </section>
 </section></main></div>
}
