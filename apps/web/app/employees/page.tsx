"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";

type Employee={id:string;code:string;full_name:string;phone:string|null;department_name:string|null;job_title_name:string|null;is_active:boolean;hired_at:string|null};
type Department={id:string;code:string;name:string};
type JobTitle={id:string;code:string;name:string;department_id:string|null};
type Role={id:string;code:string;name:string};

export default function EmployeesPage(){
  const {has}=usePermissions();
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [departments,setDepartments]=useState<Department[]>([]);
  const [jobs,setJobs]=useState<JobTitle[]>([]);
  const [roles,setRoles]=useState<Role[]>([]);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[showForm,setShowForm]=useState(false),[error,setError]=useState("");
  const [fullName,setFullName]=useState(""),[phone,setPhone]=useState(""),[departmentId,setDepartmentId]=useState(""),[jobTitleId,setJobTitleId]=useState(""),[hiredAt,setHiredAt]=useState(""),[roleCode,setRoleCode]=useState("worker");
  const [credentials,setCredentials]=useState<{username:string;password:string;roleCode:string}|null>(null);

  async function load(){
    setLoading(true);setError("");
    try{
      const [e,d,j,r]=await Promise.all([
        api<{data:Employee[]}>("/api/employees"),api<{data:Department[]}>("/api/departments"),
        api<{data:JobTitle[]}>("/api/job-titles"),api<{data:Role[]}>("/api/roles")
      ]);
      setEmployees(e.data);setDepartments(d.data);setJobs(j.data);setRoles(r.data);
      if(!r.data.some(x=>x.code===roleCode)&&r.data[0])setRoleCode(r.data[0].code);
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل البيانات");}
    finally{setLoading(false);}
  }
  useEffect(()=>{void load()},[]);

  async function deactivate(id:string){if(!confirm("تعطيل الموظف؟ سيتم تعطيل حساب الدخول المرتبط به أيضًا."))return;try{await api("/api/employees/"+id,{method:"DELETE"});await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعطيل الموظف")}}

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

  async function editEmployee(employee:Employee){
    const fullName=window.prompt("اسم الموظف",employee.full_name);
    if(fullName===null)return;
    const phone=window.prompt("رقم الهاتف",employee.phone??"");
    if(phone===null)return;
    const departmentName=window.prompt("اسم القسم (اتركه فارغًا لبدون قسم)",employee.department_name??"");
    if(departmentName===null)return;
    const department=departments.find(x=>x.name.trim().toLowerCase()===departmentName.trim().toLowerCase());
    if(departmentName.trim()&& !department){setError("القسم المكتوب غير موجود. اختر قسمًا من شاشة الإضافة.");return;}
    const jobName=window.prompt("اسم الوظيفة (اتركه فارغًا لبدون وظيفة)",employee.job_title_name??"");
    if(jobName===null)return;
    const job=jobs.find(x=>x.name.trim().toLowerCase()===jobName.trim().toLowerCase());
    if(jobName.trim()&&!job){setError("الوظيفة المكتوبة غير موجودة. اختر وظيفة من شاشة الإضافة.");return;}
    const role=window.prompt("كود دور النظام (مثال: worker / supervisor / manager)",roles.find(x=>x.name===employee.job_title_name)?.code??"worker");
    if(role===null)return;
    try{
      await api("/api/employees/"+employee.id,{method:"PATCH",body:JSON.stringify({
        fullName:fullName.trim(),phone:phone.trim()||null,departmentId:department?.id??null,jobTitleId:job?.id??null,roleCode:role.trim()
      })});
      await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر تعديل الموظف");}
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
        {loading?<div className="empty">جارٍ تحميل البيانات...</div>:!employees.length?<div className="empty">لا يوجد موظفون مسجلون.</div>:<div className="table-wrap"><table><thead><tr><th>الاسم</th><th>الكود</th><th>القسم</th><th>الوظيفة</th><th>الهاتف</th><th>الحالة</th><th>إجراءات</th></tr></thead><tbody>{employees.map(x=><tr key={x.id}><td className="strong">{x.full_name}</td><td className="mono">{x.code}</td><td>{x.department_name??"—"}</td><td>{x.job_title_name??"—"}</td><td>{x.phone??"—"}</td><td><span className={"status "+(x.is_active?"success":"muted")}>{x.is_active?"نشط":"غير نشط"}</span></td><td><div className="row-actions">{has("employees.edit")&&x.is_active&&<button className="secondary-btn" onClick={()=>editEmployee(x)}>تعديل</button>}{has("employees.delete")&&x.is_active&&<button className="danger-button" onClick={()=>deactivate(x.id)}>تعطيل</button>}</div></td></tr>)}</tbody></table></div>}
      </section>
    </section></main></div>;
}