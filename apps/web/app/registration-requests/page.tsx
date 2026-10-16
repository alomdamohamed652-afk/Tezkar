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
      setRoles(roleResult.data.filter(r=>r.is_active && r.code!=="manager"));
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

  return <div className="app-shell"><Sidebar active="/registration-requests"/><main className="main" dir="rtl">
    <header className="topbar"><div><h1 className="page-title">طلبات إنشاء الحسابات</h1><p className="page-subtitle">راجع الطلب، واختار الدور، وبعد الموافقة الحساب يقدر يسجّل الدخول.</p></div><button className="secondary-btn" onClick={()=>void load()} disabled={loading}>تحديث القائمة</button></header><section className="content">
    {error&&<div className="alert error" role="alert">{error}</div>}{message&&<div className="alert success" role="status">{message}</div>}
    <section className="card">
      <div className="card-header"><div><h2 className="card-title">طلبات معلّقة</h2><p className="form-hint">لن يحصل أي حساب على صلاحيات قبل موافقتك.</p></div><span>{requests.length} طلب</span></div>
      {loading?<p className="empty">جاري تحميل الطلبات...</p>:requests.length===0?<p className="empty">مفيش طلبات تسجيل معلّقة حاليًا.</p>:<div className="table-scroll"><table><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الموبايل</th><th>تاريخ الطلب</th><th>الدور عند التفعيل</th><th>الإجراء</th></tr></thead><tbody>
        {requests.map(item=><tr key={item.id}><td>{item.full_name}</td><td dir="ltr">{item.username}</td><td>{item.phone||"—"}</td><td>{new Date(item.created_at).toLocaleString("ar-EG")}</td><td><select value={selected[item.id]??""} onChange={e=>setSelected(s=>({...s,[item.id]:e.target.value}))} aria-label={"دور "+item.username}><option value="">اختار الدور</option>{roles.map(role=><option key={role.id} value={role.code}>{role.name}</option>)}</select></td><td><div className="form-actions"><button className="primary-button" disabled={busy===item.id||!selected[item.id]} onClick={()=>void review(item,"approve")}>{busy===item.id?"جاري التنفيذ...":"موافقة وتفعيل"}</button><button className="danger-button" disabled={busy===item.id} onClick={()=>void review(item,"reject")}>رفض</button></div></td></tr>)}
      </tbody></table></div>}
    </section></section>
  </main></div>;
}
