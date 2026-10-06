"use client";
import { FormEvent, useEffect, useState } from "react";

const API=process.env.NEXT_PUBLIC_API_URL??"http://localhost:4000";
type Item={id:string;code:string;name:string};
type Employee={id:string;code:string;full_name:string};
type User={id:string;code:string;username:string;full_name:string|null;role_codes:string[];is_active:boolean};

export default function SettingsPage(){
 const [departments,setDepartments]=useState<Item[]>([]),[roles,setRoles]=useState<Item[]>([]),[employees,setEmployees]=useState<Employee[]>([]),[users,setUsers]=useState<User[]>([]);
 const [message,setMessage]=useState(""),[error,setError]=useState("");
 const [deptCode,setDeptCode]=useState(""),[deptName,setDeptName]=useState("");
 const [jobCode,setJobCode]=useState(""),[jobName,setJobName]=useState(""),[jobDept,setJobDept]=useState("");
 const [username,setUsername]=useState(""),[password,setPassword]=useState(""),[role,setRole]=useState("worker"),[employee,setEmployee]=useState("");
 async function load(){
  const [d,j,r,u,e]=await Promise.all(["/api/departments","/api/job-titles","/api/roles","/api/users","/api/employees"].map(p=>fetch(API+p,{credentials:"include"}).then(async x=>({ok:x.ok,b:await x.json()}))));
  if([d,j,r,u,e].some(x=>!x.ok)){window.location.replace("/login");return;}
  setDepartments(d.b.data);setRoles(r.b.data);setUsers(u.b.data);setEmployees(e.b.data);
 }
 useEffect(()=>{load().catch(()=>window.location.replace("/login"));},[]);
 async function post(path:string,body:unknown){
  setError("");setMessage("");const res=await fetch(API+path,{method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify(body)});const b=await res.json();if(!res.ok)throw new Error(b?.error?.message??"تعذر تنفيذ العملية");return b;
 }
 async function addDept(e:FormEvent){e.preventDefault();try{await post("/api/departments",{code:deptCode,name:deptName});setDeptCode("");setDeptName("");setMessage("تم إضافة القسم");await load();}catch(x){setError(x instanceof Error?x.message:"حدث خطأ");}}
 async function addJob(e:FormEvent){e.preventDefault();try{await post("/api/job-titles",{code:jobCode,name:jobName,departmentId:jobDept||null});setJobCode("");setJobName("");setMessage("تم إضافة الوظيفة");await load();}catch(x){setError(x instanceof Error?x.message:"حدث خطأ");}}
 async function addUser(e:FormEvent){e.preventDefault();try{await post("/api/users",{username,password,roleCode:role,employeeId:employee||null});setUsername("");setPassword("");setMessage("تم إنشاء الحساب");await load();}catch(x){setError(x instanceof Error?x.message:"حدث خطأ");}}
 return <main className="settings-page">
  <header className="settings-header"><div><h1>الإعدادات والإدارة</h1><p>إدارة الهيكل الإداري وحسابات النظام</p></div><button className="secondary-btn" onClick={()=>window.location.replace("/")}>العودة للوحة التحكم</button></header>
  {message&&<div className="success-box">{message}</div>}{error&&<div className="auth-error">{error}</div>}
  <div className="settings-grid">
   <section className="card"><div className="section-title"><h3>الأقسام</h3></div><form className="mini-form" onSubmit={addDept}><input placeholder="الكود مثل PROD" value={deptCode} onChange={e=>setDeptCode(e.target.value)}/><input placeholder="اسم القسم" value={deptName} onChange={e=>setDeptName(e.target.value)}/><button className="primary-btn">إضافة قسم</button></form><div className="simple-list">{departments.map(x=><div key={x.id}><b>{x.code}</b><span>{x.name}</span></div>)}</div></section>
   <section className="card"><div className="section-title"><h3>الوظائف</h3></div><form className="mini-form" onSubmit={addJob}><input placeholder="الكود مثل SUPERVISOR" value={jobCode} onChange={e=>setJobCode(e.target.value)}/><input placeholder="اسم الوظيفة" value={jobName} onChange={e=>setJobName(e.target.value)}/><select value={jobDept} onChange={e=>setJobDept(e.target.value)}><option value="">بدون قسم</option>{departments.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select><button className="primary-btn">إضافة وظيفة</button></form></section>
   <section className="card settings-wide"><div className="section-title"><h3>حسابات المستخدمين</h3></div><form className="user-form" onSubmit={addUser}><input placeholder="اسم المستخدم" value={username} onChange={e=>setUsername(e.target.value)}/><input placeholder="كلمة المرور — 12 حرفًا على الأقل" type="password" value={password} onChange={e=>setPassword(e.target.value)}/><select value={role} onChange={e=>setRole(e.target.value)}>{roles.map(x=><option key={x.id} value={x.code}>{x.name}</option>)}</select><select value={employee} onChange={e=>setEmployee(e.target.value)}><option value="">حساب بدون موظف</option>{employees.map(x=><option key={x.id} value={x.id}>{x.code} — {x.full_name}</option>)}</select><button className="primary-btn">إنشاء حساب</button></form><table className="table"><thead><tr><th>المستخدم</th><th>الموظف</th><th>الدور</th><th>الحالة</th></tr></thead><tbody>{users.map(u=><tr key={u.id}><td>{u.username}</td><td>{u.full_name??"—"}</td><td>{u.role_codes.join("، ")||"—"}</td><td><span className="status">{u.is_active?"نشط":"موقوف"}</span></td></tr>)}</tbody></table></section>
  </div>
 </main>;
}