"use client";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Item={id:string;code:string;name:string};
type Leader={id:string;shift_id:string;shift_name:string;employee_id:string;employee_name:string;assignment_type:string;starts_on:string|null;ends_on:string|null};
type Assigned={id:string;shift_id:string;employee_id:string;employee_code:string;employee_name:string;starts_on:string|null;ends_on:string|null;is_active:boolean};

export default function ShiftLeadersPage(){
 const {has}=usePermissions();
 const [leaders,setLeaders]=useState<Leader[]>([]),[assigned,setAssigned]=useState<Assigned[]>([]),[shifts,setShifts]=useState<Item[]>([]),[employees,setEmployees]=useState<Item[]>([]);
 const [shift,setShift]=useState(""),[employee,setEmployee]=useState(""),[staffShift,setStaffShift]=useState(""),[staffEmployee,setStaffEmployee]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);

 async function load(){
  try{
   const [l,s,e]=await Promise.all([api<{data:Leader[]}>("/api/shift-leaders"),api<{data:Item[]}>("/api/shifts"),api<{data:Item[]}>("/api/employees")]);
   setLeaders(l.data);setShifts(s.data);setEmployees(e.data);
   if(!shift&&s.data[0])setShift(s.data[0].id);
   if(!employee&&e.data[0])setEmployee(e.data[0].id);
   if(!staffShift&&s.data[0])setStaffShift(s.data[0].id);
   if(!staffEmployee&&e.data[0])setStaffEmployee(e.data[0].id);
   if(s.data[0])await loadAssigned(staffShift||s.data[0].id);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل بيانات الورديات")}
 }
 async function loadAssigned(id:string){
  if(!id){setAssigned([]);return}
  try{const x=await api<{data:Assigned[]}>("/api/shifts/"+id+"/employees");setAssigned(x.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل موظفي الوردية")}
 }
 useEffect(()=>{void load()},[]);
 useEffect(()=>{if(staffShift)void loadAssigned(staffShift)},[staffShift]);

 async function add(e:FormEvent){e.preventDefault();setError("");setSaving(true);try{await api("/api/shifts/"+shift+"/leaders",{method:"POST",body:JSON.stringify({employeeId:employee})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعيين رئيس الوردية")}finally{setSaving(false)}}
 async function assignEmployee(e:FormEvent){e.preventDefault();setError("");setSaving(true);try{await api("/api/shifts/"+staffShift+"/employees",{method:"POST",body:JSON.stringify({employeeId:staffEmployee})});await loadAssigned(staffShift)}catch(e){setError(e instanceof Error?e.message:"تعذر ربط الموظف بالوردية")}finally{setSaving(false)}}
 async function removeEmployee(employeeId:string){try{await api("/api/shifts/"+staffShift+"/employees/"+employeeId,{method:"DELETE"});await loadAssigned(staffShift)}catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء ربط الموظف")}}
 async function removeLeader(id:string){try{await api("/api/shift-leaders/"+id,{method:"DELETE"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء التكليف")}}

 const shiftOptions=useMemo(()=>shifts.map(x=>({value:x.id,label:x.name,meta:x.code})),[shifts]);
 const employeeOptions=useMemo(()=>employees.map(x=>({value:x.id,label:x.name,meta:x.code})),[employees]);

 return <div className="app-shell"><Sidebar active="/shift-leaders"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">الورديات والموظفون</h1><p className="page-subtitle">اربط الموظفين بالوردية مرة واحدة، وبعدها تظهر أسماؤهم تلقائيًا في مسحوبات الوردية والإنتاج.</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   <div className="master-grid">
    <section className="card">
     <div className="card-header"><div><h2 className="card-title">ربط موظف بوردية</h2><div className="form-hint">الموظف لن يظهر كمسؤول مسحوبات لهذه الوردية إلا بعد الربط.</div></div></div>
     {has("shifts.assign_employee")&&<form className="mini-form" onSubmit={assignEmployee}>
      <SearchableSelect value={staffShift} onChange={setStaffShift} options={shiftOptions} placeholder="اختر الوردية" searchPlaceholder="ابحث عن الوردية"/>
      <SearchableSelect value={staffEmployee} onChange={setStaffEmployee} options={employeeOptions} placeholder="اختر الموظف" searchPlaceholder="ابحث باسم الموظف"/>
      <button className="primary-button" disabled={saving||!staffShift||!staffEmployee}>ربط الموظف</button>
     </form>}
     <div className="table-wrap"><table><thead><tr><th>الموظف</th><th>الكود</th><th>من</th><th>إلى</th><th></th></tr></thead><tbody>
      {assigned.map(x=><tr key={x.id}><td className="strong">{x.employee_name}</td><td className="mono">{x.employee_code}</td><td>{x.starts_on||"—"}</td><td>{x.ends_on||"مفتوح"}</td><td>{has("shifts.assign_employee")&&<button className="danger-button" onClick={()=>removeEmployee(x.employee_id)}>إلغاء الربط</button>}</td></tr>)}
      {!assigned.length&&<tr><td colSpan={5}>لا يوجد موظفون مربوطون بالوردية.</td></tr>}
     </tbody></table></div>
    </section>

    <section className="card">
     <div className="card-header"><div><h2 className="card-title">رئيس الوردية</h2><div className="form-hint">رئيس الوردية يظل أيضًا موظفًا مربوطًا بالوردية تلقائيًا.</div></div></div>
     {has("shifts.assign_leader")&&<form className="mini-form" onSubmit={add}>
      <SearchableSelect value={shift} onChange={setShift} options={shiftOptions} placeholder="اختر الوردية" searchPlaceholder="ابحث عن الوردية"/>
      <SearchableSelect value={employee} onChange={setEmployee} options={employeeOptions} placeholder="اختر الموظف" searchPlaceholder="ابحث باسم الموظف"/>
      <button className="primary-button" disabled={saving||!shift||!employee}>تعيين رئيس</button>
     </form>}
     <div className="table-wrap"><table><thead><tr><th>الوردية</th><th>رئيس الوردية</th><th>من</th><th>إلى</th><th></th></tr></thead><tbody>
      {leaders.map(x=><tr key={x.id}><td>{x.shift_name}</td><td className="strong">{x.employee_name}</td><td>{x.starts_on||"—"}</td><td>{x.ends_on||"مفتوح"}</td><td>{has("shifts.assign_leader")&&<button className="danger-button" onClick={()=>removeLeader(x.id)}>إلغاء</button>}</td></tr>)}
      {!leaders.length&&<tr><td colSpan={5}>لا توجد تكليفات.</td></tr>}
     </tbody></table></div>
    </section>
   </div>
  </section>
 </main></div>;
}
