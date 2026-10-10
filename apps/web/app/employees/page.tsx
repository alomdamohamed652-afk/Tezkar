"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { SearchableSelect } from "../../components/searchable-select";

type Employee={id:string;code:string;full_name:string;phone:string|null;department_name:string|null;job_title_name:string|null;role_code:string|null;is_active:boolean;hired_at:string|null};
type Department={id:string;code:string;name:string};
type JobTitle={id:string;code:string;name:string;department_id:string|null};
type Role={id:string;code:string;name:string};
type Shift={id:string;code:string;name:string};
type ShiftAssignment={id:string;shift_id:string;shift_code:string;shift_name:string;starts_on:string|null;ends_on:string|null};

export default function EmployeesPage(){
  const {has}=usePermissions();
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [departments,setDepartments]=useState<Department[]>([]);
  const [jobs,setJobs]=useState<JobTitle[]>([]);
  const [roles,setRoles]=useState<Role[]>([]);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[showForm,setShowForm]=useState(false),[error,setError]=useState("");
  const [fullName,setFullName]=useState(""),[phone,setPhone]=useState(""),[departmentId,setDepartmentId]=useState(""),[jobTitleId,setJobTitleId]=useState(""),[hiredAt,setHiredAt]=useState(""),[roleCode,setRoleCode]=useState("worker");
  const [credentials,setCredentials]=useState<{username:string;password:string;roleCode:string}|null>(null);
  const [shiftList,setShiftList]=useState<Shift[]>([]),[shiftTarget,setShiftTarget]=useState<Employee|null>(null),[assignedShifts,setAssignedShifts]=useState<ShiftAssignment[]>([]),[assignShiftId,setAssignShiftId]=useState(""),[shiftSaving,setShiftSaving]=useState(false),[deactivateTarget,setDeactivateTarget]=useState<Employee|null>(null);
  const [editTarget,setEditTarget]=useState<Employee|null>(null),[editName,setEditName]=useState(""),[editPhone,setEditPhone]=useState(""),[editDepartment,setEditDepartment]=useState(""),[editJob,setEditJob]=useState(""),[editRole,setEditRole]=useState(""),[editSaving,setEditSaving]=useState(false);

  async function load(){
    setLoading(true);setError("");
    try{
      const [e,d,j,r]=await Promise.all([
        api<{data:Employee[]}>("/api/employees"),api<{data:Department[]}>("/api/departments"),
        api<{data:JobTitle[]}>("/api/job-titles"),api<{data:Role[]}>("/api/roles")
      ]);
      const s=await api<{data:Shift[]}>("/api/shifts");
      setEmployees(e.data);setDepartments(d.data);setJobs(j.data);setRoles(r.data);setShiftList(s.data);
      if(!r.data.some(x=>x.code===roleCode)&&r.data[0])setRoleCode(r.data[0].code);
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل البيانات");}
    finally{setLoading(false);}
  }
  useEffect(()=>{void load()},[]);

  async function deactivate(){if(!deactivateTarget)return;try{await api("/api/employees/"+deactivateTarget.id,{method:"DELETE"});setDeactivateTarget(null);await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعطيل الموظف")}}
  async function restoreEmployee(employee:Employee){setError("");try{await api("/api/employees/"+employee.id+"/activate",{method:"POST"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تفعيل الموظف")}}

  async function submit(event:FormEvent){
    event.preventDefault();setSaving(true);setError("");setCredentials(null);
    try{
      const result=await api<{data:{employee:Employee;credentials:{username:string;password:string;roleCode:string}}}>("/api/employees",{
        method:"POST",body:JSON.stringify({fullName,phone:phone||undefined,departmentId:departmentId||null,jobTitleId:jobTitleId||null,hiredAt:hiredAt||null,roleCode})
      });
      setCredentials(result.data.credentials);
      setFullName("");setPhone("");setDepartmentId("");setJobTitleId("");setHiredAt("");setShowForm(false);await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الموظف");}
    finally{setSaving(false);}
  }

  function openEdit(employee:Employee){
    setEditTarget(employee);setEditName(employee.full_name);setEditPhone(employee.phone??"");
    setEditDepartment(departments.find(x=>x.name===employee.department_name)?.id??"");
    setEditJob(jobs.find(x=>x.name===employee.job_title_name)?.id??"");
    setEditRole(employee.role_code??"worker");
  }
  async function saveEdit(){
    if(!editTarget)return;setEditSaving(true);setError("");
    try{await api("/api/employees/"+editTarget.id,{method:"PATCH",body:JSON.stringify({fullName:editName.trim(),phone:editPhone.trim()||null,departmentId:editDepartment||null,jobTitleId:editJob||null,roleCode:editRole.trim()})});setEditTarget(null);await load()}
    catch(e){setError(e instanceof Error?e.message:"تعذر تعديل الموظف")}finally{setEditSaving(false)}
  }
  async function openShifts(employee:Employee){
    setShiftTarget(employee);setAssignShiftId("");
    try{const x=await api<{data:ShiftAssignment[]}>("/api/employees/"+employee.id+"/shifts");setAssignedShifts(x.data)}
    catch(e){setError(e instanceof Error?e.message:"تعذر تحميل ورديات الموظف")}
  }
  async function assignShift(){
    if(!shiftTarget||!assignShiftId)return;setShiftSaving(true);setError("");
    try{await api("/api/shifts/"+assignShiftId+"/employees",{method:"POST",body:JSON.stringify({employeeId:shiftTarget.id})});await openShifts(shiftTarget)}
    catch(e){setError(e instanceof Error?e.message:"تعذر ربط الموظف بالوردية")}finally{setShiftSaving(false)}
  }
  async function removeShift(a:ShiftAssignment){
    if(!shiftTarget)return;
    try{await api("/api/shifts/"+a.shift_id+"/employees/"+shiftTarget.id,{method:"DELETE"});await openShifts(shiftTarget)}
    catch(e){setError(e instanceof Error?e.message:"تعذر إلغاء ربط الموظف بالوردية")}
  }

  const filteredJobs=jobs.filter(x=>!departmentId||x.department_id===departmentId);

  return <div className="app-shell"><Sidebar active="/employees"/><main className="main">
    <header className="topbar"><div><h1 className="page-title">الموظفون</h1><p className="page-subtitle">إضافة الموظف تنشئ له حساب دخول تلقائيًا بالدور المحدد</p></div>
      {has("employees.create")&&<button className="primary-button" onClick={()=>setShowForm(v=>!v)}>{showForm?"إلغاء":"+ إضافة موظف"}</button>}</header>
    <section className="content">
      {error&&<div className="alert error">{error}</div>}
      {credentials&&<div className="card" style={{border:"1px solid #d9a441",background:"#fffaf0"}}><div className="card-header"><h2 className="card-title">بيانات الدخول الجديدة</h2></div><p>احفظ البيانات وسلمها للموظف. كلمة المرور لن تظهر مرة أخرى.</p><div className="form-grid"><label>اسم المستخدم<input readOnly value={credentials.username}/></label><label>كلمة المرور<input readOnly value={credentials.password}/></label><label>الدور<input readOnly value={credentials.roleCode}/></label></div></div>}
      {showForm&&has("employees.create")&&<form className="card form-card" onSubmit={submit}><div className="card-header"><h2 className="card-title">موظف جديد + حساب دخول</h2></div>
        <div className="form-grid">
          <label>اسم الموظف<input value={fullName} onChange={e=>setFullName(e.target.value)} required/></label>
          <label>رقم الهاتف<input value={phone} onChange={e=>setPhone(e.target.value)}/></label>
          <label>القسم<select value={departmentId} onChange={e=>{setDepartmentId(e.target.value);setJobTitleId("")}}><option value="">بدون قسم</option>{departments.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label>الوظيفة<select value={jobTitleId} onChange={e=>setJobTitleId(e.target.value)}><option value="">بدون وظيفة</option>{filteredJobs.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label>دور النظام<select value={roleCode} onChange={e=>setRoleCode(e.target.value)}>{roles.map(x=><option key={x.id} value={x.code}>{x.name}</option>)}</select></label>
          <label>تاريخ التعيين<input type="date" value={hiredAt} onChange={e=>setHiredAt(e.target.value)}/></label>
        </div><div className="form-actions"><button className="primary-button" disabled={saving}>{saving?"جارٍ إنشاء الموظف والحساب...":"حفظ الموظف وإنشاء الحساب"}</button></div>
      </form>}
      <section className="card"><div className="card-header"><h2 className="card-title">قائمة الموظفين</h2><span className="count-badge">{employees.length}</span></div>
        {loading?<div className="empty">جارٍ تحميل البيانات...</div>:!employees.length?<div className="empty">لا يوجد موظفون مسجلون.</div>:<div className="table-wrap"><table><thead><tr><th>الاسم</th><th>الكود</th><th>القسم</th><th>الوظيفة</th><th>الهاتف</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>{employees.map(x=><tr key={x.id}><td className="strong">{x.full_name}</td><td className="mono">{x.code}</td><td>{x.department_name??"—"}</td><td>{x.job_title_name??"—"}</td><td>{x.phone??"—"}</td><td><span className={"status "+(x.is_active?"success":"muted")}>{x.is_active?"نشط":"غير نشط"}</span></td><td><div className="row-actions">{has("employees.edit")&&x.is_active&&<button className="secondary-btn" onClick={()=>openEdit(x)}>تعديل</button>}{has("shifts.assign_employee")&&x.is_active&&<button className="secondary-btn" onClick={()=>openShifts(x)}>الورديات</button>}{has("employees.delete")&&x.is_active&&<button className="danger-button" onClick={()=>setDeactivateTarget(x)}>تعطيل</button>}{has("employees.edit")&&!x.is_active&&<button className="secondary-btn" onClick={()=>restoreEmployee(x)}>تفعيل</button>}</div></td></tr>)}</tbody></table></div>}
      </section>
    </section>
    {editTarget&&<div className="modal-backdrop" onClick={()=>setEditTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">تعديل الموظف</h2><button className="secondary-btn" onClick={()=>setEditTarget(null)}>إغلاق</button></div><div className="form-grid"><label>اسم الموظف<input value={editName} onChange={e=>setEditName(e.target.value)}/></label><label>الهاتف<input value={editPhone} onChange={e=>setEditPhone(e.target.value)}/></label><label>القسم<select value={editDepartment} onChange={e=>{setEditDepartment(e.target.value);setEditJob("")}}><option value="">بدون قسم</option>{departments.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>الوظيفة<select value={editJob} onChange={e=>setEditJob(e.target.value)}><option value="">بدون وظيفة</option>{jobs.filter(x=>!editDepartment||x.department_id===editDepartment).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label><label>دور النظام<select value={editRole} onChange={e=>setEditRole(e.target.value)}>{roles.map(x=><option key={x.id} value={x.code}>{x.name}</option>)}</select></label></div><div className="form-actions"><button className="primary-button" disabled={editSaving||!editName.trim()} onClick={saveEdit}>{editSaving?"جارٍ الحفظ...":"حفظ التعديل"}</button></div></div></div>}
    {shiftTarget&&<div className="modal-backdrop" onClick={()=>setShiftTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><div><h2 className="card-title">ورديات الموظف</h2><div className="form-hint">{shiftTarget.full_name}</div></div><button className="secondary-btn" onClick={()=>setShiftTarget(null)}>إغلاق</button></div><div className="form-actions"><SearchableSelect value={assignShiftId} onChange={setAssignShiftId} options={shiftList.map(x=>({value:x.id,label:x.name,meta:x.code}))} placeholder="اختر وردية"/><button className="primary-button" disabled={shiftSaving||!assignShiftId} onClick={assignShift}>{shiftSaving?"جارٍ الربط...":"ربط بالوردية"}</button></div><div className="master-list">{assignedShifts.map(a=><div className="master-row" key={a.id}><strong>{a.shift_name}</strong><span>{a.shift_code}</span><button className="danger-button" onClick={()=>removeShift(a)}>إلغاء الربط</button></div>)}{!assignedShifts.length&&<div className="empty">الموظف غير مربوط بأي وردية.</div>}</div></div></div>}
    {deactivateTarget&&<div className="modal-backdrop" onClick={()=>setDeactivateTarget(null)}><div className="modal-card" onClick={e=>e.stopPropagation()}><div className="card-header"><h2 className="card-title">تعطيل الموظف</h2><button className="secondary-btn" onClick={()=>setDeactivateTarget(null)}>إغلاق</button></div><p>سيتم تعطيل الموظف وحساب الدخول المرتبط به، ولن تُحذف سجلاته التاريخية.</p><div className="form-actions"><button className="secondary-btn" onClick={()=>setDeactivateTarget(null)}>إلغاء</button><button className="danger-button" onClick={deactivate}>تأكيد التعطيل</button></div></div></div>}
  </main></div>;
}