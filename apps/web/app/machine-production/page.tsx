"use client";
import {FormEvent,useEffect,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";

type Item={id:string;code:string;name:string};
type Machine=Item&{machine_type:string|null};
type Row={id:string;code:string;work_date:string;quantity:string;machine_name:string;product_name:string;employee_name:string|null;order_code:string|null;stage_name:string|null};

export default function MachineProductionPage(){
 const {has}=usePermissions(); const [machines,setMachines]=useState<Machine[]>([]),[products,setProducts]=useState<Item[]>([]),[employees,setEmployees]=useState<Item[]>([]),[shifts,setShifts]=useState<Item[]>([]),[rows,setRows]=useState<Row[]>([]);
 const [name,setName]=useState(""),[type,setType]=useState(""),[machine,setMachine]=useState(""),[product,setProduct]=useState(""),[employee,setEmployee]=useState(""),[shift,setShift]=useState(""),[date,setDate]=useState(new Date().toISOString().slice(0,10)),[qty,setQty]=useState(""),[notes,setNotes]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 async function load(){try{const [m,p,e,s,r]=await Promise.all([api<{data:Machine[]}>("/api/machines"),api<{data:Item[]}>("/api/products"),api<{data:Item[]}>("/api/employees"),api<{data:Item[]}>("/api/shifts"),api<{data:Row[]}>("/api/machine-production")]);setMachines(m.data);setProducts(p.data);setEmployees(e.data);setShifts(s.data);setRows(r.data);if(!machine&&m.data[0])setMachine(m.data[0].id);if(!product&&p.data[0])setProduct(p.data[0].id)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل إنتاج الماكينات")}}
 useEffect(()=>{void load()},[]);
 async function addMachine(e:FormEvent){e.preventDefault();try{await api("/api/machines",{method:"POST",body:JSON.stringify({name,machineType:type||undefined})});setName("");setType("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إضافة الماكينة")}}
 async function addProduction(e:FormEvent){e.preventDefault();setSaving(true);try{await api("/api/machine-production",{method:"POST",body:JSON.stringify({machineId:machine,productId:product,employeeId:employee||null,shiftId:shift||null,workDate:date,quantity:Number(qty),notes})});setQty("");setNotes("");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تسجيل إنتاج الماكينة")}finally{setSaving(false)}}
 return <div className="app-shell"><Sidebar active="/machine-production"/><main className="main"><header className="topbar"><div><h1 className="page-title">إنتاج الماكينات</h1><p className="page-subtitle">كل ماكينة لها سجل إنتاج مستقل مع الموظف والوردية والتاريخ</p></div></header><section className="content">{error&&<div className="alert error">{error}</div>}
 {has("machines.create")&&<form className="card mini-form" onSubmit={addMachine}><input placeholder="اسم الماكينة" value={name} onChange={e=>setName(e.target.value)} required/><input placeholder="نوع / وصف الماكينة" value={type} onChange={e=>setType(e.target.value)}/><button className="primary-button">إضافة ماكينة</button></form>}
 {has("machine_production.create")&&<form className="card form-card" onSubmit={addProduction}><div className="card-header"><h2 className="card-title">تسجيل إنتاج ماكينة</h2></div><div className="form-grid">
 <label>الماكينة<select value={machine} onChange={e=>setMachine(e.target.value)}>{machines.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
 <label>المنتج<select value={product} onChange={e=>setProduct(e.target.value)}>{products.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
 <label>الموظف<select value={employee} onChange={e=>setEmployee(e.target.value)}><option value="">بدون موظف</option>{employees.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
 <label>الوردية<select value={shift} onChange={e=>setShift(e.target.value)}><option value="">بدون وردية</option>{shifts.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
 <label>التاريخ<input type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>الكمية<input inputMode="decimal" value={qty} onChange={e=>setQty(e.target.value)} required/></label>
 <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={notes} onChange={e=>setNotes(e.target.value)}/></label></div><div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ التسجيل...":"تسجيل الإنتاج"}</button></div></form>}
 <section className="card"><div className="card-header"><h2 className="card-title">سجل إنتاج الماكينات</h2></div><div className="table-wrap"><table><thead><tr><th>الكود</th><th>الماكينة</th><th>المنتج</th><th>الموظف</th><th>الطلب</th><th>المرحلة</th><th>الكمية</th><th>التاريخ</th></tr></thead><tbody>{rows.map(x=><tr key={x.id}><td>{x.code}</td><td>{x.machine_name}</td><td>{x.product_name}</td><td>{x.employee_name??"—"}</td><td>{x.order_code??"—"}</td><td>{x.stage_name??"—"}</td><td>{Number(x.quantity).toLocaleString("ar-EG")}</td><td>{x.work_date}</td></tr>)}</tbody></table></div></section>
 </section></main></div>;
}