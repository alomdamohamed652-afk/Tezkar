"use client";
import { FormEvent, useState } from "react";
import Link from "next/link";
import { API_BASE as API } from "../../lib/api-base";

export default function ForgotPasswordPage() {
  const [login,setLogin]=useState("");
  const [phone,setPhone]=useState("");
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [loading,setLoading]=useState(false);
  async function submit(e:FormEvent) {
    e.preventDefault(); if(loading)return;
    setError("");setMessage("");setLoading(true);
    try {
      const res=await fetch(`${API}/api/auth/password-reset-requests`,{method:"POST",headers:{"content-type":"application/json"},credentials:"include",body:JSON.stringify({login:login.trim(),phone:phone.trim()})});
      const body=await res.json().catch(()=>null);
      if(!res.ok) throw new Error(body?.error?.message ?? "تعذر إرسال الطلب");
      setMessage(body?.message ?? "تم إرسال الطلب للإدارة. تابع مع المدير بعد المراجعة.");
    } catch(e) {setError(e instanceof Error?e.message:"تعذر إرسال الطلب");}
    finally {setLoading(false);}
  }
  return <main className="auth-page" dir="rtl"><div className="auth-shell"><section className="auth-card" style={{maxWidth:520,margin:"auto"}}><div className="auth-heading"><span className="auth-small-label">استعادة الوصول</span><h1>نسيت كلمة المرور؟</h1><p>قدّم طلب إعادة تعيين كلمة المرور، وسيصل للإدارة للمراجعة. المدير هو من يعتمد إعادة التعيين.</p></div><form className="auth-form" onSubmit={submit}><label className="auth-field"><span>اسم المستخدم أو رقم الموبايل</span><input value={login} onChange={e=>setLogin(e.target.value)} autoComplete="username" required placeholder="اسم المستخدم أو رقم الموبايل المسجل"/></label><label className="auth-field"><span>رقم الموبايل المسجل (للمساعدة في تحديد الحساب)</span><input value={phone} onChange={e=>setPhone(e.target.value)} inputMode="tel" placeholder="01xxxxxxxxx"/></label>{error?<div className="auth-error" role="alert">{error}</div>:null}{message?<div role="status" style={{padding:12,borderRadius:12,background:"#e8f7ef",color:"#176b48"}}>{message}</div>:null}<button className="auth-submit" disabled={loading}>{loading?"جاري إرسال الطلب...":"إرسال طلب للإدارة"}</button></form><p style={{textAlign:"center",marginTop:20}}><Link href="/login">العودة لتسجيل الدخول</Link></p></section></div></main>;
}
