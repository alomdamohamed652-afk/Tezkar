"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "../../components/sidebar";
import { api } from "../../lib/api";

type RegistrationRequest={id:string;full_name:string;username:string;phone:string|null;status:string;created_at:string};
type Role={id:string;code:string;name:string;is_system:boolean;is_active:boolean};
type Employee={id:string;code:string;full_name:string;phone?:string|null;is_active:boolean};
type ApprovalChoice={roleCode:string;accountType:"employee"|"standalone";employeeId:string};

export default function RegistrationRequestsPage(){
  const [requests,setRequests]=useState<RegistrationRequest[]>([]);
  const [roles,setRoles]=useState<Role[]>([]);
  const [employees,setEmployees]=useState<Employee[]>([]);
  const [choices,setChoices]=useState<Record<string,ApprovalChoice>>({});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [reqs,roleResult,employeeResult]=await Promise.all([
        api<{data:RegistrationRequest[]}>("/api/registration-requests"),
        api<{data:Role[]}>("/api/roles"),
        api<{data:Employee[]}>("/api/employees")
      ]);
      const activeRoles=roleResult.data.filter(r=>r.is_active&&r.code!=="manager");
      setRequests(reqs.data);
      setRoles(activeRoles);
      setEmployees(employeeResult.data.filter(e=>e.is_active));
      setChoices(current=>{
        const next={...current};
        for(const req of reqs.data){
          if(!next[req.id])next[req.id]={
            roleCode:activeRoles.find(r=>r.code==="employee")?.code??activeRoles.find(r=>!r.is_system)?.code??activeRoles[0]?.code??"",
            accountType:"standalone",
            employeeId:""
          };
        }
        return next;
      });
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل طلبات التسجيل أو قائمة الموظفين");}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();},[load]);

  function updateChoice(id:string,patch:Partial<ApprovalChoice>){
    setChoices(current=>({ ...current,[id]:{...(current[id]??{roleCode:"",accountType:"standalone",employeeId:""}),...patch} }));
  }

  async function review(item:RegistrationRequest,action:"approve"|"reject"){
    setBusy(item.id);setError("");setMessage("");
    try{
      if(action==="approve"){
        const choice=choices[item.id];
        if(!choice?.roleCode)throw new Error("اختار الدور قبل تفعيل الحساب");
        if(choice.accountType==="employee"&&!choice.employeeId)throw new Error("اختار الموظف اللي هيتربط بالحساب");
        await api("/api/registration-requests/"+item.id+"/approve",{
          method:"POST",
          body:JSON.stringify({roleCode:choice.roleCode,accountType:choice.accountType,employeeId:choice.accountType==="employee"?choice.employeeId:null})
        });
        setMessage("تم تفعيل حساب "+item.username+(choice.accountType==="employee"?" وربطه بملف الموظف المختار.":" كمستخدم مستقل.")+" ويمكنه الدخول باليوزر أو رقم الموبايل.");
      }else{
        const reason=window.prompt("سبب الرفض (اختياري):")??"";
        await api("/api/registration-requests/"+item.id+"/reject",{method:"POST",body:JSON.stringify({reason})});
        setMessage("تم رفض طلب "+item.username+".");
      }
      await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر مراجعة الطلب");}
    finally{setBusy(null);}
  }

  return <div className="app-shell"><Sidebar active="/registration-requests"/><main className="main" dir="rtl">
    <header className="topbar"><div><h1 className="page-title">طلبات إنشاء الحسابات</h1><p className="page-subtitle">فعّل الحساب، اختار صلاحياته، وحدد هل يرتبط بموظف موجود أم يكون مستخدمًا مستقلًا.</p></div><button className="secondary-btn" onClick={()=>void load()} disabled={loading}>تحديث القائمة</button></header>
    <section className="content">
      {error&&<div className="alert error" role="alert">{error}</div>}{message&&<div className="alert success" role="status">{message}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:12,marginBottom:16}}>
        <div style={{padding:15,borderRadius:14,background:"#eff6ff",border:"1px solid #bfdbfe",color:"#1e40af"}}><strong style={{display:"block",fontSize:13}}>ربط بحساب عامل</strong><span style={{fontSize:12}}>اختار موظفًا موجودًا ليرتبط حساب الدخول بملفه وسجلاته.</span></div>
        <div style={{padding:15,borderRadius:14,background:"#f5f3ff",border:"1px solid #ddd6fe",color:"#5b21b6"}}><strong style={{display:"block",fontSize:13}}>مستخدم مستقل</strong><span style={{fontSize:12}}>ينشئ حساب دخول وصلاحيات بدون ربطه بملف موظف.</span></div>
      </div>
      <section className="card">
        <div className="card-header"><div><h2 className="card-title">طلبات معلّقة</h2><p className="form-hint">رقم الموبايل إلزامي وسيُستخدم لتسجيل الدخول بجانب اسم المستخدم.</p></div><span>{requests.length} طلب</span></div>
        {loading?<p className="empty">جاري تحميل الطلبات...</p>:requests.length===0?<p className="empty">مفيش طلبات تسجيل معلّقة حاليًا.</p>:<div className="table-scroll"><table><thead><tr><th>الاسم والبيانات</th><th>نوع الحساب</th><th>الدور</th><th>ربط الموظف</th><th>الإجراء</th></tr></thead><tbody>
          {requests.map(item=>{
            const choice=choices[item.id]??{roleCode:"",accountType:"standalone" as const,employeeId:""};
            return <tr key={item.id}>
              <td><strong>{item.full_name}</strong><div dir="ltr" style={{textAlign:"right",fontSize:12,color:"var(--muted,#64748b)"}}>{item.username}</div><div style={{fontSize:12,fontWeight:800,color:"#047857",marginTop:4}}>{item.phone||"طلب قديم بدون رقم موبايل"}</div><small style={{color:"var(--muted,#64748b)"}}>{new Date(item.created_at).toLocaleString("ar-EG")}</small></td>
              <td><div style={{display:"grid",gap:7,minWidth:150}}>
                <label style={{display:"flex",alignItems:"center",gap:7,padding:8,borderRadius:9,border:choice.accountType==="employee"?"1px solid #93c5fd":"1px solid var(--border,#e2e8f0)",background:choice.accountType==="employee"?"#eff6ff":"transparent",fontSize:12,fontWeight:800}}><input type="radio" name={"account-"+item.id} checked={choice.accountType==="employee"} onChange={()=>updateChoice(item.id,{accountType:"employee"})}/> حساب عامل</label>
                <label style={{display:"flex",alignItems:"center",gap:7,padding:8,borderRadius:9,border:choice.accountType==="standalone"?"1px solid #c4b5fd":"1px solid var(--border,#e2e8f0)",background:choice.accountType==="standalone"?"#f5f3ff":"transparent",fontSize:12,fontWeight:800}}><input type="radio" name={"account-"+item.id} checked={choice.accountType==="standalone"} onChange={()=>updateChoice(item.id,{accountType:"standalone",employeeId:""})}/> مستخدم مستقل</label>
              </div></td>
              <td><select style={{minWidth:135}} value={choice.roleCode} onChange={e=>updateChoice(item.id,{roleCode:e.target.value})} aria-label={"دور "+item.username}><option value="">اختار الدور</option>{roles.map(role=><option key={role.id} value={role.code}>{role.name}</option>)}</select></td>
              <td>{choice.accountType==="employee"?<select style={{minWidth:190,maxWidth:240}} value={choice.employeeId} onChange={e=>updateChoice(item.id,{employeeId:e.target.value})} aria-label={"الموظف المرتبط "+item.username}><option value="">اختار الموظف</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name} — {employee.code}{employee.phone?" · "+employee.phone:""}</option>)}</select>:<span style={{display:"inline-flex",padding:"7px 10px",borderRadius:8,background:"#f5f3ff",color:"#6d28d9",fontSize:12,fontWeight:800}}>بدون ربط بموظف</span>}</td>
              <td><div className="form-actions" style={{flexWrap:"wrap",minWidth:140}}><button className="primary-button" disabled={busy===item.id||!choice.roleCode||(choice.accountType==="employee"&&!choice.employeeId)||!item.phone} onClick={()=>void review(item,"approve")}>{busy===item.id?"جاري التنفيذ...":"موافقة وتفعيل"}</button><button className="danger-button" disabled={busy===item.id} onClick={()=>void review(item,"reject")}>رفض</button></div>{!item.phone&&<small style={{display:"block",color:"#b91c1c",marginTop:5}}>الطلب قديم؛ يلزم إعادة التسجيل برقم موبايل.</small>}</td>
            </tr>;
          })}
        </tbody></table></div>}
      </section>
    </section>
  </main></div>;
}
