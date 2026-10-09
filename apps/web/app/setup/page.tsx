"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { API_BASE as API } from "../../lib/api-base";

export default function SetupPage() {
  const router=useRouter();
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [confirm,setConfirm]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  useEffect(()=>{
    fetch(`${API}/api/auth/me`,{credentials:"include"})
      .then(async r=>({ok:r.ok,data:await r.json()}))
      .then(({ok,data})=>{
        if(!ok) router.replace("/login");
        else if(!data.data?.mustCompleteSetup) router.replace("/");
      }).catch(()=>router.replace("/login"));
  },[router]);

  async function submit(e:FormEvent){
    e.preventDefault(); setError("");
    if(password!==confirm){setError("كلمتا المرور غير متطابقتين");return;}
    setLoading(true);
    try{
      const res=await fetch(`${API}/api/auth/complete-first-run`,{
        method:"POST",headers:{"content-type":"application/json"},
        credentials:"include",body:JSON.stringify({username,password,confirmPassword:confirm})
      });
      const body=await res.json();
      if(!res.ok) throw new Error(body?.error?.message ?? "تعذر إنشاء الحساب");
      router.replace("/login?setup=done");
    }catch(err){setError(err instanceof Error?err.message:"تعذر إنشاء الحساب");}
    finally{setLoading(false);}
  }

  return <main className="auth-page">
    <section className="auth-card">
      <div className="setup-badge">إعداد أول تشغيل</div>
      <h1>أنشئ حساب المدير الأساسي</h1>
      <p className="auth-muted">الحساب المؤقت مخصص للدخول الأول فقط. بعد إنشاء الحساب الجديد سيتم تعطيله تلقائياً.</p>
      <form onSubmit={submit}>
        <label>اسم المستخدم الجديد<input value={username} onChange={e=>setUsername(e.target.value)} minLength={3} required /></label>
        <label>كلمة المرور الجديدة<input value={password} onChange={e=>setPassword(e.target.value)} type="password" minLength={12} required /></label>
        <label>تأكيد كلمة المرور<input value={confirm} onChange={e=>setConfirm(e.target.value)} type="password" minLength={12} required /></label>
        {error && <div className="auth-error">{error}</div>}
        <button className="primary-btn" disabled={loading}>{loading ? "جاري إنشاء الحساب..." : "إنشاء حساب المدير"}</button>
      </form>
      <div className="auth-note">سيتم منح الحساب الجديد صلاحية مدير النظام، ثم تسجيل خروج الحساب المؤقت وإلغاؤه.</div>
    </section>
  </main>;
}
