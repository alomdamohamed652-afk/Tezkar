"use client";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Product=Item&{unit_name:string};
type Warehouse=Item;
type Location={id:string;code:string;name:string;warehouse_id:string};
type Line={productId:string;warehouseId:string;locationId:string;quantity:string;notes:string};
type Row={id:string;code:string;withdrawal_date:string;shift_code:string;shift_name:string;employee_name:string|null;line_count:number;total_quantity:number};

export default function ShiftWithdrawalsPage(){
 const [shifts,setShifts]=useState<Item[]>([]),[products,setProducts]=useState<Product[]>([]),[warehouses,setWarehouses]=useState<Warehouse[]>([]),[locations,setLocations]=useState<Location[]>([]),[rows,setRows]=useState<Row[]>([]);
 const [shiftId,setShiftId]=useState(""),[employeeId,setEmployeeId]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10)),[notes,setNotes]=useState("");
 const [lines,setLines]=useState<Line[]>([{productId:"",warehouseId:"",locationId:"",quantity:"",notes:""}]),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 async function load(){try{const [s,p,w,l,r]=await Promise.all([api<{data:Item[]}>("/api/shifts"),api<{data:Product[]}>("/api/products"),api<{data:Warehouse[]}>("/api/warehouses"),api<{data:Location[]}>("/api/warehouse/locations"),api<{data:Row[]}>("/api/shift-withdrawals")]);setShifts(s.data);setProducts(p.data);setWarehouses(w.data);setLocations(l.data);setRows(r.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل مسحوبات الورديات")}}
 useEffect(()=>{void load()},[]);
 const productOptions=useMemo(()=>products.filter(x=>x.name).map(x=>({value:x.id,label:x.name,meta:x.code})),[products]);
 function update(i:number,key:keyof Line,value:string){setLines(a=>a.map((x,n)=>n===i?{...x,[key]:value}:x))}
 function add(){setLines(a=>[...a,{productId:"",warehouseId:"",locationId:"",quantity:"",notes:""}])}
 function remove(i:number){setLines(a=>a.filter((_,n)=>n!==i))}
 async function submit(e:FormEvent){e.preventDefault();setSaving(true);setError("");try{await api("/api/shift-withdrawals",{method:"POST",body:JSON.stringify({shiftId,withdrawalDate:date,employeeId:employeeId||null,notes:notes||null,lines:lines.map(x=>({...x,quantity:Number(x.quantity)}))})});setLines([{productId:"",warehouseId:"",locationId:"",quantity:"",notes:""}]);setNotes("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل المسحوبات")}finally{setSaving(false)}}
 return <div className="app-shell"><Sidebar active="/shift-withdrawals"/><main className="main"><header className="topbar"><div><h1 className="page-title">مسحوبات الوردية</h1><p className="page-subtitle">اكتب اسم الصنف أو الكود، حدد الكمية والمقاس/المكان، والنظام يسجل الصرف ويطبع السجل لاحقًا.</p></div></header><section className="content">{error&&<div className="alert error">{error}</div>}
 <form className="card form-card" onSubmit={submit}><div className="card-header"><h2 className="card-title">مسحوب وردية جديد</h2></div>
 <div className="form-grid"><label>الوردية<SearchableSelect value={shiftId} onChange={setShiftId} options={shifts.map(x=>({value:x.id,label:x.name,meta:x.code}))} placeholder="اختر الوردية"/></label><label>التاريخ<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>الملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="اختياري"/></label></div>
 <div className="withdrawal-lines">{lines.map((x,i)=><div className="withdrawal-line" key={i}><SearchableSelect value={x.productId} onChange={v=>update(i,"productId",v)} options={productOptions} placeholder="اكتب اسم الصنف أو الكود"/><select value={x.warehouseId} onChange={e=>{update(i,"warehouseId",e.target.value);update(i,"locationId","")}}><option value="">المخزن</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select><select value={x.locationId} onChange={e=>update(i,"locationId",e.target.value)}><option value="">المكان</option>{locations.filter(l=>l.warehouse_id===x.warehouseId).map(l=><option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}</select><input type="number" min="0.001" step="0.001" value={x.quantity} onChange={e=>update(i,"quantity",e.target.value)} placeholder="العدد"/><button type="button" className="danger-button" onClick={()=>remove(i)} disabled={lines.length===1}>حذف</button></div>)}</div>
 <div className="form-actions"><button type="button" className="secondary-btn" onClick={add}>إضافة صنف</button><button className="primary-button" disabled={saving}>{saving?"جارٍ الحفظ...":"تسجيل المسحوبات"}</button></div></form>
 <section className="card"><div className="card-header"><h2 className="card-title">سجل مسحوبات الورديات</h2><span className="count-badge">{rows.length}</span></div><div className="table-wrap"><table><thead><tr><th>الكود</th><th>التاريخ</th><th>الوردية</th><th>الموظف</th><th>الأصناف</th><th>الإجمالي</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td className="mono strong">{r.code}</td><td>{r.withdrawal_date}</td><td>{r.shift_name}</td><td>{r.employee_name||"—"}</td><td>{r.line_count}</td><td>{r.total_quantity}</td></tr>)}{!rows.length&&<tr><td colSpan={6}>لا توجد مسحوبات.</td></tr>}</tbody></table></div></section>
 </section></main></div>;
}