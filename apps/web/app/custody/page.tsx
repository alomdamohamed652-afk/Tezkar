"use client";
import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Custody={id:string;code:string;employee_name:string;custody_type:string;description:string;quantity:number;unit_value:number;total_value:number;status:string;issued_at:string;due_date:string|null;returned_quantity:number;remaining_quantity:number};
type Employee={id:string;full_name:string;code:string};
const normalizeNumber=(v:string)=>v.replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g,"").replace(/٫/g,".");
const labels:Record<string,string>={ACTIVE:"نشطة",PARTIAL_RETURNED:"مرتجع جزئي",RETURNED:"مُسواة",DAMAGED:"تالف",LOST:"مفقودة",CANCELLED:"ملغاة"};

export default function CustodyPage(){
 const {has}=usePermissions();
 const [items,setItems]=useState<Custody[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[employeeId,setEmployeeId]=useState(""),[type,setType]=useState(""),[description,setDescription]=useState(""),[quantity,setQuantity]=useState(""),[unitValue,setUnitValue]=useState(""),[dueDate,setDueDate]=useState(""),[notes,setNotes]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 async function load(){try{
  const suffix=employeeId?"?employeeId="+encodeURIComponent(employeeId):"";
  setItems((await api<{data:Custody[]}>("/api/custodies"+suffix)).data);
  if(has("custody.create")&&!employees.length)setEmployees((await api<{data:Employee[]}>("/api/employees")).data);
 }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل العهد")}
 }
 useEffect(()=>{void load()},[employeeId]);
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{
  await api("/api/custodies",{method:"POST",body:JSON.stringify({employeeId,custodyType:type,description,quantity:Number(normalizeNumber(quantity)),unitValue:Number(normalizeNumber(unitValue||"0")),dueDate:dueDate||null,notes:notes||null})});
  setEmployeeId("");setType("");setDescription("");setQuantity("");setUnitValue("");setDueDate("");setNotes("");await load();
 }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل العهدة")}finally{setSaving(false)}}
 async function settle(x:Custody){
  const raw=window.prompt("الكمية المرتجعة — المتبقي "+x.remaining_quantity);if(raw===null)return;
  const q=Number(normalizeNumber(raw));if(!Number.isFinite(q)||q<=0||q>x.remaining_quantity){setError("كمية المرتجع غير صحيحة");return}
  const damage=window.prompt("قيمة التلف إن وجدت","0");if(damage===null)return;
  const shortage=window.prompt("قيمة العجز إن وجد","0");if(shortage===null)return;
  try{await api("/api/custodies/"+x.id+"/settlements",{method:"POST",body:JSON.stringify({returnedQuantity:q,damageValue:Number(normalizeNumber(damage)),shortageValue:Number(normalizeNumber(shortage))})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسوية العهدة")}
 }
 return <div className="app-shell"><Sidebar active="/custody"/><main className="main"><header className="topbar"><div><h1 className="page-title">عهد الموظفين</h1><p className="page-subtitle">تسجيل العهدة على الموظف، متابعة المتبقي، ثم تسويتها بسجل مستقل.</p></div></header><section className="content">
 {error&&<div className="alert error">{error}</div>}
 {has("custody.create")&&<form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">تسجيل عهدة</h2><div className="form-hint">كل عهدة تحصل على رقم CUS مستقل ولا تتغير قيمتها القديمة بعد التسوية.</div></div></div>
  <div className="form-grid">
   <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.map(x=>({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>
   <label>نوع العهدة<input value={type} onChange={e=>setType(e.target.value)} placeholder="مثال: هاتف / أدوات / خامات" required/></label>
   <label>الوصف<input value={description} onChange={e=>setDescription(e.target.value)} placeholder="تفاصيل العهدة" required/></label>
   <label>الكمية<input type="text" inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} required/></label>
   <label>قيمة الوحدة<input type="text" inputMode="decimal" value={unitValue} onChange={e=>setUnitValue(e.target.value)} placeholder="0"/></label>
   <label>تاريخ الاستحقاق<input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>
   <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)}/></label>
  </div>
  <div className="form-actions"><button className="primary-button" disabled={saving||!employeeId}>{saving?"جارٍ الحفظ...":"تسجيل العهدة"}</button></div>
 </form>}
 <section className="card"><div className="card-header"><div><h2 className="card-title">سجل العهد</h2><div className="form-hint">المرتجع والتلف والعجز لا يمسحون السجل الأصلي.</div></div><span className="count-badge">{items.length}</span></div>
  <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>نوع العهدة</th><th>الوصف</th><th>الأصل</th><th>المرتجع</th><th>المتبقي</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
  {items.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.employee_name}</td><td>{x.custody_type}</td><td>{x.description}</td><td>{Number(x.quantity).toLocaleString("ar-EG")}</td><td>{Number(x.returned_quantity||0).toLocaleString("ar-EG")}</td><td>{Number(x.remaining_quantity||0).toLocaleString("ar-EG")}</td><td><span className="status">{labels[x.status]||x.status}</span></td><td>{x.remaining_quantity>0&&has("custody.settle")&&<button className="secondary-btn" onClick={()=>settle(x)}>تسوية / مرتجع</button>}</td></tr>)}
  {!items.length&&<tr><td colSpan={9}>لا توجد عهد مسجلة.</td></tr>}</tbody></table></div>
 </section>
 </section></main></div>
}
