"use client";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";
import {SearchableSelect} from "../../components/searchable-select";

type Employee={id:string;code:string;full_name:string;is_active?:boolean};
type Shift={id:string;code:string;name:string;start_time:string;end_time:string;crosses_midnight:boolean;rate_group_id:string;rate_group_name:string|null;is_active:boolean};
type RateGroup={id:string;code:string;name:string;is_active:boolean};
type Leader={id:string;shift_id:string;shift_name:string;employee_id:string;employee_name:string;assignment_type:string;starts_on:string|null;ends_on:string|null};
type Assigned={id:string;shift_id:string;employee_id:string;employee_code:string;employee_name:string;starts_on:string|null;ends_on:string|null;is_active:boolean};

export default function ShiftLeadersPage(){
 const {has}=usePermissions();
 const [leaders,setLeaders]=useState<Leader[]>([]),[assigned,setAssigned]=useState<Assigned[]>([]),[shifts,setShifts]=useState<Shift[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[rateGroups,setRateGroups]=useState<RateGroup[]>([]);
 const [shift,setShift]=useState(""),[employee,setEmployee]=useState(""),[staffShift,setStaffShift]=useState(""),[staffEmployee,setStaffEmployee]=useState(""),[error,setError]=useState(""),[saving,setSaving]=useState(false);
 const [shiftEditId,setShiftEditId]=useState(""),[shiftName,setShiftName]=useState(""),[shiftStart,setShiftStart]=useState("08:00"),[shiftEnd,setShiftEnd]=useState("16:00"),[shiftCrossesMidnight,setShiftCrossesMidnight]=useState(false),[shiftRateGroup,setShiftRateGroup]=useState("");

 async function load(){
  try{
   const [l,s,e]=await Promise.all([api<{data:Leader[]}>("/api/shift-leaders"),api<{data:Shift[]}>("/api/shifts"),api<{data:Employee[]}>("/api/employees")]);
   setLeaders(l.data);setShifts(s.data);setEmployees(e.data);
   try{const g=await api<{data:RateGroup[]}>("/api/rate-groups");setRateGroups(g.data.filter(x=>x.is_active));if(!shiftRateGroup&&g.data.find(x=>x.is_active))setShiftRateGroup(g.data.find(x=>x.is_active)!.id)}catch{}
   const activeShifts=s.data.filter(x=>x.is_active);
   if(!shift&&activeShifts[0])setShift(activeShifts[0].id);
   if(!employee&&e.data[0])setEmployee(e.data[0].id);
   if(!staffShift&&activeShifts[0])setStaffShift(activeShifts[0].id);
   if(!staffEmployee&&e.data[0])setStaffEmployee(e.data[0].id);
   if(activeShifts[0])await loadAssigned(staffShift&&activeShifts.some(x=>x.id===staffShift)?staffShift:activeShifts[0].id);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل بيانات الورديات")}
 }
 async function loadAssigned(id:string){
  if(!id){setAssigned([]);return}
  try{const x=await api<{data:Assigned[]}>("/api/shifts/"+id+"/employees");setAssigned(x.data)}catch(e){setError(e instanceof Error?e.message:"تعذر تحميل موظفي الوردية")}
 }
 useEffect(()=>{void load()},[]);
 useEffect(()=>{if(staffShift)void loadAssigned(staffShift)},[staffShift]);

 async function saveShift(e:FormEvent){
  e.preventDefault();setError("");setSaving(true);
  try{
   const body={name:shiftName.trim(),startTime:shiftStart,endTime:shiftEnd,crossesMidnight:shiftCrossesMidnight,rateGroupId:shiftRateGroup};
   if(shiftEditId)await api("/api/shifts/"+shiftEditId,{method:"PATCH",body:JSON.stringify(body)});
   else await api("/api/shifts",{method:"POST",body:JSON.stringify(body)});
   setShiftEditId("");setShiftName("");setShiftStart("08:00");setShiftEnd("16:00");setShiftCrossesMidnight(false);
   setError("");await load();
  }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ بيانات الوردية")}finally{setSaving(false)}
 }
 function editShift(x:Shift){
  setShiftEditId(x.id);setShiftName(x.name);setShiftStart(String(x.start_time).slice(0,5));setShiftEnd(String(x.end_time).slice(0,5));setShiftCrossesMidnight(x.crosses_midnight);setShiftRateGroup(x.rate_group_id);
 }
 async function reactivateShift(id:string){
  setSaving(true);setError("");
  try{await api("/api/shifts/"+id,{method:"PATCH",body:JSON.stringify({isActive:true})});await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر إعادة تفعيل الوردية")}finally{setSaving(false)}
 }
 async function deactivateShift(id:string){
  if(!window.confirm("تعطيل الوردية؟ سيتم إنهاء ربط الموظفين ورؤساء الوردية بها مع الاحتفاظ بالسجلات التاريخية."))return;
  setSaving(true);setError("");
  try{await api("/api/shifts/"+id,{method:"PATCH",body:JSON.stringify({isActive:false})});await load()}
  catch(e){setError(e instanceof Error?e.message:"تعذر تعطيل الوردية")}finally{setSaving(false)}
 }
 async function add(e:FormEvent){e.preventDefault();setError("");setSaving(true);try{await api("/api/shifts/"+shift+"/leaders",{method:"POST",body:JSON.stringify({employeeId:employee})});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعيين رئيس الوردية")}finally{setSaving(false)}}
 async function assignEmployee(e:FormEvent){e.preventDefault();setError("");setSaving(true);try{await api("/api/shifts/"+staffShift+"/employees",{method:"POST",body:JSON.stringify({employeeId:staffEmployee})});await loadAssigned(staffShift)}catch(e){setError(e instanceof Error?e.message:"تعذر ربط الموظف بالوردية")}finally{setSaving(false)}}
 async function removeEmployee(employeeId:string){try{await api("/api/shifts/"+staffShift+"/employees/"+employeeId,{method:"DELETE"});await loadAssigned(staffShift)}catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء ربط الموظف")}}
 async function removeLeader(id:string){try{await api("/api/shift-leaders/"+id,{method:"DELETE"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء التكليف")}}

 const shiftOptions=useMemo(()=>shifts.filter(x=>x.is_active).map(x=>({value:x.id,label:x.name,meta:x.code})),[shifts]);
 const employeeOptions=useMemo(()=>employees.filter(x=>x.is_active!==false).map(x=>({value:x.id,label:x.full_name,meta:x.code})),[employees]);
 const rateGroupOptions=useMemo(()=>rateGroups.map(x=>({value:x.id,label:x.name,meta:x.code})),[rateGroups]);

 return <div className="app-shell"><Sidebar active="/shift-leaders"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">الورديات والموظفون</h1><p className="page-subtitle">اربط الموظفين بالوردية مرة واحدة، وبعدها تظهر أسماؤهم تلقائيًا في مسحوبات الوردية والإنتاج.</p></div></header>
  <section className="content">
   {error&&<div className="alert error">{error}</div>}
   {has("shifts.create")&&<section className="card">
    <div className="card-header"><div><h2 className="card-title">{shiftEditId?"تعديل الوردية":"إضافة وردية جديدة"}</h2><div className="form-hint">يمكن إنشاء أي عدد من الورديات وتحديد مواعيدها ومجموعة الأجر المرتبطة بها.</div></div></div>
    <form className="form-grid" onSubmit={saveShift}>
     <label>اسم الوردية<input value={shiftName} onChange={e=>setShiftName(e.target.value)} required minLength={2} maxLength={120} placeholder="مثال: الوردية الصباحية"/></label>
     <label>بداية الوردية<input type="time" value={shiftStart} onChange={e=>setShiftStart(e.target.value)} required/></label>
     <label>نهاية الوردية<input type="time" value={shiftEnd} onChange={e=>setShiftEnd(e.target.value)} required/></label>
     <label>مجموعة الأجر<SearchableSelect value={shiftRateGroup} onChange={setShiftRateGroup} options={rateGroupOptions} placeholder="اختر مجموعة الأجر" searchPlaceholder="ابحث عن مجموعة الأجر"/></label>
     <label className="checkbox-label"><input type="checkbox" checked={shiftCrossesMidnight} onChange={e=>setShiftCrossesMidnight(e.target.checked)}/> الوردية تمتد لليوم التالي</label>
     <div className="form-actions"><button className="primary-button" disabled={saving||!shiftName.trim()||!shiftRateGroup}>{shiftEditId?"حفظ التعديلات":"إضافة الوردية"}</button>{shiftEditId&&<button type="button" className="secondary-btn" onClick={()=>{setShiftEditId("");setShiftName("");setShiftStart("08:00");setShiftEnd("16:00");setShiftCrossesMidnight(false)}}>إلغاء التعديل</button>}</div>
    </form>
    {!rateGroups.length&&<div className="form-hint">لا توجد مجموعات أجر متاحة؛ أضف مجموعة أجر نشطة أولًا من البيانات الأساسية.</div>}
   </section>}
   <section className="card">
    <div className="card-header"><div><h2 className="card-title">إدارة الورديات</h2><div className="form-hint">تعطيل الوردية يحفظ تاريخها ولا يحذف سجلاتها.</div></div><span className="count-badge">{shifts.length}</span></div>
    <div className="table-wrap"><table><thead><tr><th>الكود</th><th>اسم الوردية</th><th>من</th><th>إلى</th><th>مجموعة الأجر</th><th>الحالة</th><th></th></tr></thead><tbody>
     {shifts.map(x=><tr key={x.id}><td className="mono">{x.code}</td><td className="strong">{x.name}</td><td>{String(x.start_time).slice(0,5)}</td><td>{String(x.end_time).slice(0,5)}{x.crosses_midnight?" · اليوم التالي":""}</td><td>{x.rate_group_name||"—"}</td><td>{x.is_active?"نشطة":"معطلة"}</td><td>{has("shifts.create")&&(x.is_active?<div className="row-actions"><button className="secondary-btn" onClick={()=>editShift(x)}>تعديل</button><button className="danger-button" disabled={saving} onClick={()=>void deactivateShift(x.id)}>تعطيل</button></div>:<button className="secondary-btn" disabled={saving} onClick={()=>void reactivateShift(x.id)}>إعادة تفعيل</button>)}</td></tr>)}
     {!shifts.length&&<tr><td colSpan={7}>لا توجد ورديات مسجلة.</td></tr>}
    </tbody></table></div>
   </section>
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
