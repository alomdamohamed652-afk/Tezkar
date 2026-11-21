"use client";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {formatQuantity} from "../../lib/format";
import {SearchableSelect} from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Product=Item&{unit_name:string};
type Stock={product_id:string;warehouse_id:string;quantity:number|string;product_name:string;warehouse_name:string;unit_name:string};
type Warehouse=Item;
type Employee=Item&{full_name?:string};
type Order=Item&{order_name:string;status:string};
type OrderStage={id:string;order_id:string;order_code:string;order_name:string;stage_name:string;output_product_id:string|null;output_product_name:string|null;status:string};
type Line={productId:string;warehouseId:string;quantity:string;notes:string};
type Row={id:string;code:string;withdrawal_date:string;created_at?:string;shift_code:string;shift_name:string;employee_name:string|null;order_code:string|null;order_name:string|null;line_count:number;total_quantity:number;product_names?:string;line_descriptions?:string;notes?:string|null};

export default function ShiftWithdrawalsPage(){
 const {has}=usePermissions();
 const [shifts,setShifts]=useState<Item[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[assignedEmployees,setAssignedEmployees]=useState<Employee[]>([]),[products,setProducts]=useState<Product[]>([]),[warehouses,setWarehouses]=useState<Warehouse[]>([]),[stock,setStock]=useState<Stock[]>([]),[orders,setOrders]=useState<Order[]>([]),[orderStages,setOrderStages]=useState<OrderStage[]>([]),[rows,setRows]=useState<Row[]>([]),[totalRows,setTotalRows]=useState(0),[loadingMore,setLoadingMore]=useState(false);
 const [shiftId,setShiftId]=useState(""),[employeeId,setEmployeeId]=useState(""),[orderId,setOrderId]=useState(""),[orderStageId,setOrderStageId]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10)),[notes,setNotes]=useState("");
 const [lines,setLines]=useState<Line[]>([{productId:"",warehouseId:"",quantity:"",notes:""}]),[error,setError]=useState(""),[saving,setSaving]=useState(false),[loadingEmployees,setLoadingEmployees]=useState(false);
 const [filterFrom,setFilterFrom]=useState(""),[filterTo,setFilterTo]=useState(""),[filterTimeFrom,setFilterTimeFrom]=useState(""),[filterTimeTo,setFilterTimeTo]=useState(""),[filterShift,setFilterShift]=useState("ALL"),[filterEmployee,setFilterEmployee]=useState("ALL"),[filterOrder,setFilterOrder]=useState("ALL"),[filterProduct,setFilterProduct]=useState(""),[filterDescription,setFilterDescription]=useState("");

 async function load(){
  try{
   const [s,e,p,w,st,o,os,r]=await Promise.all([
    api<{data:Item[]}>("/api/shifts"),api<{data:Employee[]}>("/api/employees"),api<{data:Product[]}>("/api/products"),
    api<{data:Warehouse[]}>("/api/warehouses"),api<{data:Stock[]}>("/api/warehouse/stock"),api<{data:Order[]}>("/api/orders"),api<{data:OrderStage[]}>("/api/order-stages"),
    api<{data:Row[];pagination?:{total:number}}>("/api/shift-withdrawals?limit=300&offset=0")
   ]);
   setShifts(s.data);setEmployees(e.data);setProducts(p.data);setWarehouses(w.data);setStock(st.data);setOrders(o.data.filter(x=>x.status!=="COMPLETED"&&x.status!=="CANCELLED"));setOrderStages(os.data);setRows(r.data);setTotalRows(r.pagination?.total??r.data.length);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل مسحوبات الورديات")}
 }
 async function loadMore(){
  if(loadingMore||rows.length>=totalRows)return;
  setLoadingMore(true);
  try{
   const r=await api<{data:Row[];pagination?:{total:number}}>(`/api/shift-withdrawals?limit=300&offset=${rows.length}`);
   setRows(current=>[...current,...r.data.filter(item=>!current.some(existing=>existing.id===item.id))]);
   setTotalRows(r.pagination?.total??totalRows);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل المزيد من مسحوبات الورديات")}
  finally{setLoadingMore(false)}
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

 const productOptionsFor=(line:Line)=>products.filter(p=>p.name&&stock.some(s=>s.product_id===p.id&&(!line.warehouseId||s.warehouse_id===line.warehouseId))).map(p=>({value:p.id,label:p.name,meta:p.code}));
 const warehouseOptionsFor=(line:Line)=>warehouses.filter(w=>stock.some(s=>s.warehouse_id===w.id&&(!line.productId||s.product_id===line.productId))).map(w=>({value:w.id,label:w.name,meta:w.code}));
 const stockQuantity=(line:Line)=>stock.filter(s=>s.product_id===line.productId&&s.warehouse_id===line.warehouseId).reduce((sum,s)=>sum+Number(s.quantity||0),0);
 const employeeOptions=useMemo(()=>assignedEmployees.map(x=>({value:x.id,label:x.full_name||x.name,meta:x.code})),[assignedEmployees]);
 const activeStageOptions=useMemo(()=>orderStages.filter(x=>x.order_id===orderId&&x.status!=="COMPLETED"&&x.status!=="CANCELLED").map(x=>({value:x.id,label:x.stage_name,meta:x.output_product_name||""})),[orderStages,orderId]);
 const filteredRows=useMemo(()=>rows.filter(r=>{
  const time=r.created_at?new Date(r.created_at).toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",hour12:false}):"";
  const productMatch=!filterProduct||String(r.product_names||"").toLocaleLowerCase().includes(filterProduct.toLocaleLowerCase());
  const descText=[r.notes||"",r.line_descriptions||"",r.code].join(" ").toLocaleLowerCase();
  return (!filterFrom||r.withdrawal_date>=filterFrom)&&(!filterTo||r.withdrawal_date<=filterTo)&&
   (!filterTimeFrom||time>=filterTimeFrom)&&(!filterTimeTo||time<=filterTimeTo)&&
   (filterShift==="ALL"||r.shift_code===filterShift)&&
   (filterEmployee==="ALL"||(r.employee_name||"")===filterEmployee)&&
   (filterOrder==="ALL"||(r.order_code||"")===filterOrder)&&productMatch&&
   (!filterDescription||descText.includes(filterDescription.toLocaleLowerCase()));
 }),[rows,filterFrom,filterTo,filterTimeFrom,filterTimeTo,filterShift,filterEmployee,filterOrder,filterProduct,filterDescription]);

 async function printWithdrawal(row:Row){
  try{
   const detail=await api<{data:{withdrawal:Row;lines:Array<{product_code:string;product_name:string;warehouse_name:string;unit_name:string;quantity:number;notes:string|null}>}}>(`/api/shift-withdrawals/${row.id}`);
   const w=window.open("","_blank","width=820,height=900");
   if(!w)return;
   const linesHtml=detail.data.lines.map((line,index)=>`<tr><td>${index+1}</td><td><strong>${line.product_name}</strong><div class="muted">${line.product_code}</div></td><td>${line.warehouse_name}</td><td>${line.quantity}</td><td>${line.unit_name}</td><td>${line.notes||"—"}</td></tr>`).join("");
   w.document.write(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>${row.code}</title><style>
   body{font-family:Arial,sans-serif;padding:32px;color:#111}h1{margin:0 0 8px}.head{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:18px 0}.code{font-family:monospace;font-weight:700;font-size:20px}.muted{color:#666;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border:1px solid #bbb;padding:9px;text-align:right}th{background:#f3f3f3}.total{font-weight:700;font-size:16px;margin-top:16px}.footer{margin-top:28px;font-size:12px;color:#666}@media print{body{padding:12mm}}
   </style></head><body><h1>مسحوبات الوردية</h1><div class="code">${row.code}</div><div class="head"><div>التاريخ: <b>${row.withdrawal_date}</b></div><div>الوردية: <b>${row.shift_name}</b></div><div>الموظف المسؤول: <b>${row.employee_name||"—"}</b></div><div>الطلبية: <b>${row.order_code?`${row.order_code} — ${row.order_name}`:"عام"}</b></div></div><table><thead><tr><th>#</th><th>الصنف</th><th>المخزن</th><th>الكمية</th><th>الوحدة</th><th>البيان</th></tr></thead><tbody>${linesHtml}</tbody></table><div class="total">إجمالي الأصناف: ${row.line_count} — إجمالي الكمية: ${row.total_quantity}</div><div class="footer">هذا الإذن مرقم تسلسليًا من نظام تذكار — تفاصيل كل صنف مطبوعة في نفس الإذن.</div><script>window.onload=()=>{window.focus();window.print()};</script></body></html>`);
   w.document.close();
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل تفاصيل المسحوبات للطباعة")}
 }
 function update(i:number,key:keyof Line,value:string){setLines(a=>a.map((x,n)=>{if(n!==i)return x;const next={...x,[key]:value};if(key==="productId"&&next.warehouseId&&!stock.some(s=>s.product_id===value&&s.warehouse_id===next.warehouseId))next.warehouseId="";if(key==="warehouseId"&&next.productId&&!stock.some(s=>s.product_id===next.productId&&s.warehouse_id===value))next.productId="";return next}))}
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
   {(has("warehouse.move")||has("warehouse.shift_withdrawal.create"))&&<form className="card form-card" onSubmit={submit}><div className="card-header"><div><h2 className="card-title">مسحوب وردية جديد</h2><div className="form-hint">المكان غير مطلوب للمستخدم؛ تذكار يسحب من أقدم دفعات التكلفة المتاحة داخل المخزن.</div></div></div>
    <div className="form-grid">
     <label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shifts.map(x=>({value:x.id,label:x.name,meta:x.code}))} placeholder="اختر الوردية"/></label>
     <label>الموظف المسؤول<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employeeOptions} placeholder={loadingEmployees?"جارٍ تحميل موظفي الوردية":"اختر الموظف المسؤول"} searchPlaceholder="ابحث باسم الموظف"/></label>
     <label>الطلبية<SearchableSelect value={orderId} onChange={v=>{setOrderId(v);setOrderStageId("")}} options={orders.map(x=>({value:x.id,label:x.order_name,meta:x.code}))} placeholder="اختر الطلبية التي سيُصرف لها المخزون"/></label>
     <label>مرحلة الطلب <span className="optional">اختياري</span><SearchableSelect value={orderStageId} onChange={setOrderStageId} options={activeStageOptions} placeholder={orderId?"اختر المرحلة":"اختر الطلبية أولًا"}/></label>
     <label>التاريخ<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
     <label style={{gridColumn:"1/-1"}}>الملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="بيان المسحوب أو سبب الصرف"/></label>
    </div>
    <div className="withdrawal-lines">{lines.map((x,i)=><div className="withdrawal-line" key={i}>
      <div><SearchableSelect value={x.productId} onChange={v=>update(i,"productId",v)} options={productOptionsFor(x)} placeholder="اختر صنفًا متاحًا" searchPlaceholder="ابحث باسم الصنف أو الكود"/>{x.productId&&x.warehouseId&&<small className="form-hint">المتاح: {formatQuantity(stockQuantity(x),0)}</small>}</div>
      <SearchableSelect value={x.warehouseId} onChange={v=>update(i,"warehouseId",v)} options={warehouseOptionsFor(x)} placeholder={x.productId?"مخازن بها الصنف":"اختر المخزن لعرض أصنافه"}/>
      <input type="number" min="0.001" step="0.001" value={x.quantity} onChange={e=>update(i,"quantity",e.target.value)} placeholder="العدد"/>
      <input value={x.notes} onChange={e=>update(i,"notes",e.target.value)} placeholder="بيان الصنف (اختياري)"/>
      <button type="button" className="danger-button" onClick={()=>remove(i)} disabled={lines.length===1}>حذف</button>
    </div>)}</div>
    <div className="form-actions"><button type="button" className="secondary-btn" onClick={add}>إضافة صنف</button><button className="primary-button" disabled={saving||!shiftId||!employeeId||!orderId||lines.some(x=>!x.productId||!x.warehouseId||!x.quantity||Number(x.quantity)>stockQuantity(x))}>{saving?"جارٍ الحفظ...":"تسجيل المسحوبات"}</button></div>
   </form>}

   <section className="card"><div className="card-header"><h2 className="card-title">سجل مسحوبات الورديات</h2><span className="count-badge">{filteredRows.length} / {rows.length}</span></div>
    <div className="card-body">
     <h3 className="card-title">فلاتر البحث</h3>
     <div className="form-grid">
      <label>من تاريخ<input type="date" value={filterFrom} onChange={e=>setFilterFrom(e.target.value)}/></label>
      <label>إلى تاريخ<input type="date" value={filterTo} onChange={e=>setFilterTo(e.target.value)}/></label>
      <label>من وقت<input type="time" value={filterTimeFrom} onChange={e=>setFilterTimeFrom(e.target.value)}/></label>
      <label>إلى وقت<input type="time" value={filterTimeTo} onChange={e=>setFilterTimeTo(e.target.value)}/></label>
      <label>الوردية<select value={filterShift} onChange={e=>setFilterShift(e.target.value)}><option value="ALL">كل الورديات</option>{shifts.map(x=><option key={x.id} value={x.code}>{x.name}</option>)}</select></label>
      <label>الموظف المسؤول<select value={filterEmployee} onChange={e=>setFilterEmployee(e.target.value)}><option value="ALL">كل الموظفين</option>{Array.from(new Set(rows.map(x=>x.employee_name).filter((x):x is string=>Boolean(x)))).sort().map(x=><option key={x} value={x}>{x}</option>)}</select></label>
      <label>الطلبية<select value={filterOrder} onChange={e=>setFilterOrder(e.target.value)}><option value="ALL">كل الطلبيات</option>{Array.from(new Map(rows.filter(x=>x.order_code).map(x=>[x.order_code!,x.order_name||x.order_code!])).entries()).map(([code,name])=><option key={code} value={code}>{code} — {name}</option>)}</select></label>
      <label>الصنف<input value={filterProduct} onChange={e=>setFilterProduct(e.target.value)} placeholder="ابحث باسم الصنف"/></label>
      <label>البيان أو الكود<input value={filterDescription} onChange={e=>setFilterDescription(e.target.value)} placeholder="ابحث في الملاحظات والبيان"/></label>
     </div>
     <div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>{setFilterFrom("");setFilterTo("");setFilterTimeFrom("");setFilterTimeTo("");setFilterShift("ALL");setFilterEmployee("ALL");setFilterOrder("ALL");setFilterProduct("");setFilterDescription("")}}>مسح الفلاتر</button></div>
    </div>
    <div className="table-wrap"><table><thead><tr><th>الكود</th><th>التاريخ</th><th>الوقت</th><th>الوردية</th><th>الموظف المسؤول</th><th>الطلبية</th><th>الأصناف</th><th>الإجمالي</th><th></th></tr></thead>
     <tbody>{filteredRows.map(r=><tr key={r.id}><td className="mono strong">{r.code}</td><td>{r.withdrawal_date}</td><td>{r.created_at?new Date(r.created_at).toLocaleTimeString("ar-EG",{hour:"2-digit",minute:"2-digit"}):"—"}</td><td>{r.shift_name}</td><td>{r.employee_name||"—"}</td><td>{r.order_code?r.order_code+" — "+r.order_name:"—"}</td><td>{r.line_count}</td><td>{r.total_quantity}</td><td><button className="secondary-btn" onClick={()=>printWithdrawal(r)}>طباعة</button></td></tr>)}{!filteredRows.length&&<tr><td colSpan={9}>لا توجد مسحوبات مطابقة للفلاتر.</td></tr>}</tbody>
    </table></div>
    {rows.length<totalRows&&<div className="form-actions"><button type="button" className="secondary-btn" onClick={()=>void loadMore()} disabled={loadingMore}>{loadingMore?"جارٍ تحميل المزيد...":"تحميل المزيد من السجل"}</button><span className="form-hint">تم تحميل {rows.length} من إجمالي {totalRows} مسحوب</span></div>}
   </section>
  </section></main></div>;
}
