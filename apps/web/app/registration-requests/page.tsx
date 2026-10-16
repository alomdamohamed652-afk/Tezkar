"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "../../components/sidebar";
import { api } from "../../lib/api";

type RegistrationRequest={id:string;full_name:string;username:string;phone:string|null;status:string;created_at:string};
type Role={id:string;code:string;name:string;is_system:boolean;is_active:boolean};

export default function RegistrationRequestsPage(){
  const [requests,setRequests]=useState<RegistrationRequest[]>([]);
  const [roles,setRoles]=useState<Role[]>([]);
  const [selected,setSelected]=useState<Record<string,string>>({});
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [reqs,roleResult]=await Promise.all([
        api<{data:RegistrationRequest[]}>("/api/registration-requests"),
        api<{data:Role[]}>("/api/roles")
      ]);
      setRequests(reqs.data);
      setRoles(roleResult.data.filter(r=>r.is_active));
      setSelected(current=>{
        const next={...current};
        for(const req of reqs.data)if(!next[req.id])next[req.id]=roleResult.data.find(r=>r.code==="employee")?.code??roleResult.data.find(r=>!r.is_system)?.code??roleResult.data[0]?.code??"";
        return next;
      });
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل طلبات التسجيل");}
    finally{setLoading(false);}
  },[]);

  useEffect(()=>{void load();},[load]);

  async function review(item:RegistrationRequest,action:"approve"|"reject"){
    setBusy(item.id);setError("");setMessage("");
    try{
      if(action==="approve"){
        const roleCode=selected[item.id];
        if(!roleCode)throw new Error("اختار الدور قبل تفعيل الحساب");
        await api("/api/registration-requests/"+item.id+"/approve",{method:"POST",body:JSON.stringify({roleCode})});
        setMessage("تم تفعيل حساب "+item.username+" بالدور المحدد.");
      }else{
        const reason=window.prompt("سبب الرفض (اختياري):")??"";
        await api("/api/registration-requests/"+item.id+"/reject",{method:"POST",body:JSON.stringify({reason})});
        setMessage("تم رفض طلب "+item.username+".");
      }
      await load();
    }catch(e){setError(e instanceof Error?e.message:"تعذر مراجعة الطلب");}
    finally{setBusy(null);}
  }

  return <div className="app-layout"><Sidebar active="/registration-requests"/><main className="page-content" dir="rtl">
    <header className="page-header"><div><span className="eyebrow">إدارة الحسابات</span><h1>طلبات إنشاء الحسابات</h1><p>راجع الطلب، واختار الدور، وبعد الموافقة الحساب يقدر يسجّل الدخول.</p></div><button className="button-secondary" onClick={()=>void load()} disabled={loading}>تحديث القائمة</button></header>
    {error&&<div className="alert alert-error" role="alert">{error}</div>}{message&&<div className="alert alert-success" role="status">{message}</div>}
    <section className="panel">
      <div className="panel-header"><div><h2>طلبات معلّقة</h2><p>لن يحصل أي حساب على صلاحيات قبل موافقتك.</p></div><span className="count-badge">{requests.length}</span></div>
      {loading?<p className="empty-state">جاري تحميل الطلبات...</p>:requests.length===0?<p className="empty-state">مفيش طلبات تسجيل معلّقة حاليًا.</p>:<div className="table-wrap"><table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الموبايل</th><th>تاريخ الطلب</th><th>الدور عند التفعيل</th><th>الإجراء</th></tr></thead><tbody>
        {requests.map(item=><tr key={item.id}><td>{item.full_name}</td><td dir="ltr">{item.username}</td><td>{item.phone||"—"}</td><td>{new Date(item.created_at).toLocaleString("ar-EG")}</td><td><select value={selected[item.id]??""} onChange={e=>setSelected(s=>({...s,[item.id]:e.target.value}))} aria-label={"دور "+item.username}><option value="">اختار الدور</option>{roles.map(role=><option key={role.id} value={role.code}>{role.name}</option>)}</select></td><td><div className="table-actions"><button className="button-primary" disabled={busy===item.id||!selected[item.id]} onClick={()=>void review(item,"approve")}>{busy===item.id?"جاري التنفيذ...":"موافقة وتفعيل"}</button><button className="button-danger" disabled={busy===item.id} onClick={()=>void review(item,"reject")}>رفض</button></div></td></tr>)}
      </tbody></table></div>}
    </section>
  </main></div>;
}
