"use client";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Product=Item&{unit_name:string};
type Warehouse=Item;
type Employee=Item&{full_name?:string};
type Order=Item&{order_name:string;status:string};
type OrderStage={id:string;order_id:string;order_code:string;order_name:string;stage_name:string;output_product_id:string|null;output_product_name:string|null;status:string};
type Line={productId:string;warehouseId:string;quantity:string;notes:string};
type Row={id:string;code:string;withdrawal_date:string;shift_code:string;shift_name:string;employee_name:string|null;order_code:string|null;order_name:string|null;line_count:number;total_quantity:number};

export default function ShiftWithdrawalsPage(){
 const [shifts,setShifts]=useState<Item[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[assignedEmployees,setAssignedEmployees]=useState<Employee[]>([]),[products,setProducts]=useState<Product[]>([]),[warehouses,setWarehouses]=useState<Warehouse[]>([]),[orders,setOrders]=useState<Order[]>([]),[orderStages,setOrderStages]=useState<OrderStage[]>([]),[rows,setRows]=useState<Row[]>([]);
 const [shiftId,setShiftId]=useState(""),[employeeId,setEmployeeId]=useState(""),[orderId,setOrderId]=useState(""),[orderStageId,setOrderStageId]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10)),[notes,setNotes]=useState("");
 const [lines,setLines]=useState<Line[]>([{productId:"",warehouseId:"",quantity:"",notes:""}]),[error,setError]=useState(""),[saving,setSaving]=useState(false),[loadingEmployees,setLoadingEmployees]=useState(false);

 async function load(){
  try{
   const [s,e,p,w,o,os,r]=await Promise.all([
    api<{data:Item[]}>("/api/shifts"),api<{data:Employee[]}>("/api/employees"),api<{data:Product[]}>("/api/products"),
    api<{data:Warehouse[]}>("/api/warehouses"),api<{data:Order[]}>("/api/orders"),api<{data:OrderStage[]}>("/api/order-stages"),
    api<{data:Row[]}>("/api/shift-withdrawals")
   ]);
   setShifts(s.data);setEmployees(e.data);setProducts(p.data);setWarehouses(w.data);setOrders(o.data.filter(x=>x.status!=="COMPLETED"&&x.status!=="CANCELLED"));setOrderStages(os.data);setRows(r.data);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل مسحوبات الورديات")}
 }
 useEffect(()=>{void load()},[]);

 useEffect(()=>{
  setEmployeeId("");
  if(!shiftId){setAssignedEmployees([]);return}
  setLoadingEmployees(true);
  api<{data:ArrayItem[]}>("/api/shifts/"+shiftId+"/employees")
    .then(x=>setAssignedEmployees(x.data.map(a=>({id:a.employee_id,code:a.employee_code,name:a.employee_name,full_name:a.employee_name}))))
    .catch(e=>setError(e instanceof Error?e.message:"تعذر تحميل موظفي الوردية"))
    .finally(()=>setLoadingEmployees(false));
 },[shiftId]);

 type ArrayItem={employee_id:string;employee_code:string;employee_name:string};

 const productOptions=useMemo(()=>products.filter(x=>x.name).map(x=>({value:x.id,label:x.name,meta:x.code})),[products]);
 const warehouseOptions=useMemo(()=>warehouses.map(x=>({value:x.id,label:x.name,meta:x.code})),[warehouses]);
 const employeeOptions=useMemo(()=>assignedEmployees.map(x=>({value:x.id,label:x.full_name||x.name,meta:x.code})),[assignedEmployees]);
 const activeStageOptions=useMemo(()=>orderStages.filter(x=>x.order_id===orderId&&x.status!=="COMPLETED"&&x.status!=="CANCELLED").map(x=>({value:x.id,label:x.stage_name,meta:x.output_product_name||""})),[orderStages,orderId]);

 function update(i:number,key:keyof Line,value:string){setLines(a=>a.map((x,n)=>n===i?{...x,[key]:value}:x))}
 function add(){setLines(a=>[...a,{productId:"",warehouseId:"",quantity:"",notes:""}])}
 function remove(i:number){setLines(a=>a.filter((_,n)=>n!==i))}

 async function submit(e:FormEvent){
  e.preventDefault();setSaving(true);setError("");
  try{
   await api("/api/shift-withdrawals",{method:"POST",body:JSON.stringify({
    shiftId,withdrawalDate:date,employeeId,orderId:orderId||null,orderStageId:orderStageId||null,notes:notes||null,
    lines:lines.map(x=>({...x,quantity:Number(x.quantity)}))
   })});
   setLines([{productId:"",warehouseId:"",quantity:"",notes:""}]);setNotes("");setOrderId("");setOrderStageId("");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المسحوبات")}finally{setSaving(false)}
 }

 return <div className="app-shell"><Sidebar active="/shift-withdrawals"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">مسحوبات الوردية</h1><p className="page-subtitle">الصرف يخرج من المخزون باسم الموظف المسؤول والوردية والطلبية، وتُحمل تكلفة المسحوب على الطلبية تلقائيًا.</p></div></header>
  <section className="content">{error&&<div className="alert error">{error}</div>}
   <form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">مسحوب وردية جديد</h2><div className="form-hint">المكان غير مطلوب للمستخدم؛ تذكار يسحب من أقدم دفعات التكلفة المتاحة داخل المخزن.</div></div></div>
    <div className="form-grid">
     <label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shifts.map(x=>({value:x.id,label:x.name,meta:x.code}))} placeholder="اختر الوردية"/></label>
     <label>الموظف المسؤول<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employeeOptions} placeholder={loadingEmployees?"جارٍ تحميل موظفي الوردية":"اختر الموظف المسؤول"} searchPlaceholder="ابحث باسم الموظف"/></label>
     <label>الطلبية<SearchableSelect value={orderId} onChange={v=>{setOrderId(v);setOrderStageId("")}} options={orders.map(x=>({value:x.id,label:x.order_name,meta:x.code}))} placeholder="اختر الطلبية التي سيُصرف لها المخزون"/></label>
     <label>مرحلة الطلب <span className="optional">اختياري</span><SearchableSelect value={orderStageId} onChange={setOrderStageId} options={activeStageOptions} placeholder={orderId?"اختر المرحلة":"اختر الطلبية أولًا"}/></label>
     <label>التاريخ<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
     <label style={{gridColumn:"1/-1"}}>الملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="بيان المسحوب أو سبب الصرف"/></label>
    </div>
    <div className="withdrawal-lines">{lines.map((x,i)=><div className="withdrawal-line" key={i}>
      <SearchableSelect value={x.productId} onChange={v=>update(i,"productId",v)} options={productOptions} placeholder="اكتب اسم الصنف أو الكود" searchPlaceholder="ابحث باسم الصنف أو الكود"/>
      <SearchableSelect value={x.warehouseId} onChange={v=>update(i,"warehouseId",v)} options={warehouseOptions} placeholder="المخزن"/>
      <input type="number" min="0.001" step="0.001" value={x.quantity} onChange={e=>update(i,"quantity",e.target.value)} placeholder="العدد"/>
      <input value={x.notes} onChange={e=>update(i,"notes",e.target.value)} placeholder="بيان الصنف (اختياري)"/>
      <button type="button" className="danger-button" onClick={()=>remove(i)} disabled={lines.length===1}>حذف</button>
    </div>)}</div>
    <div className="form-actions"><button type="button" className="secondary-btn" onClick={add}>إضافة صنف</button><button className="primary-button" disabled={saving||!shiftId||!employeeId||!orderId||lines.some(x=>!x.productId||!x.warehouseId||!x.quantity)}>{saving?"جارٍ الحفظ...":"تسجيل المسحوبات"}</button></div>
   </form>

   <section className="card"><div className="card-header"><h2 className="card-title">سجل مسحوبات الورديات</h2><span className="count-badge">{rows.length}</span></div>
    <div className="table-wrap"><table><thead><tr><th>الكود</th><th>التاريخ</th><th>الوردية</th><th>الموظف المسؤول</th><th>الطلبية</th><th>الأصناف</th><th>الإجمالي</th></tr></thead>
     <tbody>{rows.map(r=><tr key={r.id}><td className="mono strong">{r.code}</td><td>{r.withdrawal_date}</td><td>{r.shift_name}</td><td>{r.employee_name||"—"}</td><td>{r.order_code?r.order_code+" — "+r.order_name:"—"}</td><td>{r.line_count}</td><td>{r.total_quantity}</td></tr>)}{!rows.length&&<tr><td colSpan={7}>لا توجد مسحوبات.</td></tr>}</tbody>
    </table></div>
   </section>
  </section></main></div>;
}
