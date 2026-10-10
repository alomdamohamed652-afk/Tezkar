"use client";

import {useEffect,useMemo,useState} from "react";
import {api} from "../../lib/api";
import {Sidebar,usePermissions} from "../../components/sidebar";

type Item={id:string;code:string;name:string};
type Employee={id:string;code:string;full_name:string;is_active:boolean};
type User={id:string;code:string;username:string;full_name:string|null;employee_code:string|null;role_codes:string[];is_active:boolean;is_bootstrap:boolean};
type Permission={id:string;code:string;module:string;entity:string;action:string;scope:string|null};

const moduleNames:Record<string,string>={iam:"الحسابات والصلاحيات",hr:"الموارد البشرية",orders:"الطلبات",production:"الإنتاج",warehouse:"المخزن",finance:"المالية",master:"البيانات الأساسية",reports:"التقارير",dashboard:"لوحة التحكم",earnings:"المستحقات",auth:"الحساب"};
const actionNames:Record<string,string>={view:"عرض",create:"إضافة",edit:"تعديل",delete:"حذف",manage:"إدارة",approve:"اعتماد",reject:"رفض",move:"حركة",dashboard:"لوحة",change_password:"تغيير كلمة المرور"};

export default function SettingsPage(){
 const {has}=usePermissions();
 const [tab,setTab]=useState("permissions"),[roles,setRoles]=useState<Item[]>([]),[permissions,setPermissions]=useState<Permission[]>([]),[roleId,setRoleId]=useState(""),[rolePermissionIds,setRolePermissionIds]=useState<string[]>([]);
 const [users,setUsers]=useState<User[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[departments,setDepartments]=useState<Item[]>([]),[jobs,setJobs]=useState<Item[]>([]);
 const [message,setMessage]=useState(""),[error,setError]=useState(""),[query,setQuery]=useState("");

 async function load(){
  try{
   const [r,p,u,e,d,j]=await Promise.all([
    api<{data:Item[]}>("/api/roles"),api<{data:Permission[]}>("/api/permissions"),api<{data:User[]}>("/api/users"),
    api<{data:Employee[]}>("/api/employees"),api<{data:Item[]}>("/api/departments"),api<{data:Item[]}>("/api/job-titles")
   ]);
   setRoles(r.data);setPermissions(p.data);setUsers(u.data);setEmployees(e.data);setDepartments(d.data);setJobs(j.data);
   if(!roleId&&r.data[0])setRoleId(r.data[0].id);
  }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل الإعدادات")}
 }
 useEffect(()=>{void load()},[]);
 useEffect(()=>{if(!roleId)return;api<{data:{id:string}[]}>("/api/roles/"+roleId+"/permissions").then(x=>setRolePermissionIds(x.data.map(v=>v.id))).catch(()=>setRolePermissionIds([]))},[roleId]);

 const groups=useMemo(()=>{const m=new Map<string,Permission[]>();for(const p of permissions){const arr=m.get(p.module)||[];arr.push(p);m.set(p.module,arr)}return Array.from(m.entries())},[permissions]);
 const filteredUsers=users.filter(x=>(x.username+" "+(x.full_name??"")+" "+x.role_codes.join(" ")).toLowerCase().includes(query.toLowerCase()));
 const filteredEmployees=employees.filter(x=>(x.full_name+" "+x.code).toLowerCase().includes(query.toLowerCase()));

 async function savePermissions(){try{await api("/api/roles/"+roleId+"/permissions",{method:"PUT",body:JSON.stringify({permissionIds:rolePermissionIds})});setMessage("تم حفظ صلاحيات الدور");}catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الصلاحيات")}}
 async function deactivateUser(id:string){if(!confirm("تعطيل الحساب؟ لن يستطيع تسجيل الدخول بعد ذلك."))return;try{await api("/api/users/"+id,{method:"DELETE"});setMessage("تم تعطيل الحساب");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعطيل الحساب")}}
 async function setUserActive(id:string,isActive:boolean){if(!confirm(isActive?"إعادة تفعيل الحساب؟":"تعطيل الحساب؟"))return;try{await api("/api/users/"+id,{method:"PATCH",body:JSON.stringify({isActive})});setMessage(isActive?"تمت إعادة تفعيل الحساب":"تم تعطيل الحساب");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تحديث حالة الحساب")}}
 async function resetUserPassword(id:string,username:string){const password=window.prompt("اكتب كلمة مرور مؤقتة جديدة للحساب @"+username+" (١٢ حرفًا على الأقل). سيتم إنهاء الجلسات الحالية.");if(password===null)return;if(password.length<12){setError("كلمة المرور يجب أن تكون ١٢ حرفًا على الأقل.");return}try{await api("/api/users/"+id+"/reset-password",{method:"POST",body:JSON.stringify({password})});setMessage("تمت إعادة تعيين كلمة المرور وإنهاء الجلسات الحالية. سلّم كلمة المرور المؤقتة للموظف بطريقة آمنة.");setError("");}catch(e){setError(e instanceof Error?e.message:"تعذر إعادة تعيين كلمة المرور")}}
 async function deactivateEmployee(id:string){if(!confirm("تعطيل الموظف وحسابه المرتبط؟"))return;try{await api("/api/employees/"+id,{method:"DELETE"});setMessage("تم تعطيل الموظف");await load()}catch(e){setError(e instanceof Error?e.message:"تعذر تعطيل الموظف")}}

 return <div className="app-shell"><Sidebar active="/settings"/><main className="main">
  <header className="topbar"><div><h1 className="page-title">الإعدادات والإدارة</h1><p className="page-subtitle">تحكم كامل في الحسابات، الصلاحيات والبيانات الإدارية.</p></div></header>
  <section className="content">
   {message&&<div className="success-box">{message}</div>}{error&&<div className="alert error">{error}</div>}
   <div className="settings-tabs">
    <button className={"tab "+(tab==="permissions"?"active":"")} onClick={()=>setTab("permissions")}>الصلاحيات والأدوار</button>
    <button className={"tab "+(tab==="users"?"active":"")} onClick={()=>setTab("users")}>حسابات المستخدمين</button>
    <button className={"tab "+(tab==="employees"?"active":"")} onClick={()=>setTab("employees")}>الموظفون</button>
    <button className={"tab "+(tab==="structure"?"active":"")} onClick={()=>setTab("structure")}>الهيكل الإداري</button>
   </div>

   {tab==="permissions"&&<section className="card settings-wide"><div className="card-header settings-card-title"><div><h2 className="card-title">صلاحيات الأدوار</h2><div className="settings-help">كل صلاحية يمكن تشغيلها أو إيقافها بشكل مستقل للدور المحدد.</div></div><div className="settings-toolbar" style={{border:0,padding:0}}><select value={roleId} onChange={e=>setRoleId(e.target.value)}>{roles.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><button className="primary-button" onClick={savePermissions} disabled={!has("rbac.manage")}>حفظ التعديلات</button></div></div>
    <div className="settings-permission-grid">{groups.map(([module,items])=><div key={module} className="permission-group"><div className="permission-group-title">{moduleNames[module]||module}<span>{items.length}</span></div>{items.map(p=><label className="settings-permission" key={p.id}><input type="checkbox" checked={rolePermissionIds.includes(p.id)} onChange={e=>setRolePermissionIds(v=>e.target.checked?[...v,p.id]:v.filter(id=>id!==p.id))}/><div><strong>{actionNames[p.action]||p.action} · {p.entity}</strong><code>{p.code}</code></div></label>)}</div>)}</div>
   </section>}

   {tab==="users"&&<section className="card settings-wide"><div className="card-header settings-card-title"><div><h2 className="card-title">حسابات المستخدمين</h2><div className="settings-help">الحذف هنا آمن: الحساب يتم تعطيله بدل حذف السجل التاريخي.</div></div></div>
    <div className="settings-toolbar"><input placeholder="بحث بالاسم أو اسم المستخدم أو الدور" value={query} onChange={e=>setQuery(e.target.value)}/><a className="primary-button" href="/employees">إضافة موظف + حساب</a></div>
    {filteredUsers.map(u=><div className="settings-account-row" key={u.id}><div><strong>{u.full_name||u.username}</strong><div className="form-hint">@{u.username}</div></div><div>{u.employee_code||"حساب إداري"}</div><div>{u.role_codes.join("، ")||"—"}</div><div><div className="row-actions">{!u.is_bootstrap&&has("users.edit")&&<button className="secondary-btn" onClick={()=>void resetUserPassword(u.id,u.username)}>إعادة تعيين كلمة المرور</button>}{u.is_bootstrap?<span className="status">حساب أساسي</span>:u.is_active?<button className="danger-button" onClick={()=>deactivateUser(u.id)}>تعطيل</button>:has("users.edit")?<button className="approve-button" onClick={()=>void setUserActive(u.id,true)}>إعادة تفعيل</button>:<span className="status muted">معطل</span>}</div></div></div>)}
   </section>}

   {tab==="employees"&&<section className="card settings-wide"><div className="card-header settings-card-title"><div><h2 className="card-title">الموظفون</h2><div className="settings-help">تعطيل الموظف يعطل الحساب المرتبط به أيضًا.</div></div></div>
    <div className="settings-toolbar"><input placeholder="بحث باسم الموظف" value={query} onChange={e=>setQuery(e.target.value)}/><a className="primary-button" href="/employees">فتح شاشة الموظفين</a></div>
    {filteredEmployees.map(e=><div className="settings-account-row" key={e.id}><div><strong>{e.full_name}</strong><div className="form-hint">{e.code}</div></div><div>{e.is_active?"نشط":"معطل"}</div><div></div><div>{e.is_active?<button className="danger-button" onClick={()=>deactivateEmployee(e.id)}>تعطيل</button>:<span className="status muted">معطل</span>}</div></div>)}
   </section>}

   {tab==="structure"&&<div className="settings-grid"><section className="card"><div className="card-header"><h2 className="card-title">الأقسام</h2><span className="count-badge">{departments.length}</span></div><div className="simple-list">{departments.map(x=><div key={x.id}><b>{x.code}</b><span>{x.name}</span></div>)}</div></section><section className="card"><div className="card-header"><h2 className="card-title">الوظائف</h2><span className="count-badge">{jobs.length}</span></div><div className="simple-list">{jobs.map(x=><div key={x.id}><b>{x.code}</b><span>{x.name}</span></div>)}</div></section></div>}
  </section>
 </main></div>;
}
