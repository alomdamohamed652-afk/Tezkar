"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function LoginPage() {
  const router = useRouter();
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  async function submit(e:FormEvent) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const res=await fetch(`${API}/api/auth/login`,{
        method:"POST",headers:{"content-type":"application/json"},
        credentials:"include",body:JSON.stringify({username,password})
      });
      const body=await res.json();
      if(!res.ok) throw new Error(body?.error?.message ?? "تعذر تسجيل الدخول");
      router.replace(body.requiresSetup ? "/setup" : "/");
    } catch(err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل الدخول");
    } finally { setLoading(false); }
  }

  return <main className="auth-page">
    <section className="auth-card">
      <div className="auth-brand"><div className="brand-mark">ت</div><div><strong>TEZKAR</strong><span>Factory Management</span></div></div>
      <h1>تسجيل الدخول</h1>
      <p className="auth-muted">ادخل إلى نظام إدارة المصنع</p>
      <form onSubmit={submit}>
        <label>اسم المستخدم<input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required /></label>
        <label>كلمة المرور<input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="current-password" required /></label>
        {error && <div className="auth-error">{error}</div>}
        <button className="primary-btn" disabled={loading}>{loading ? "جاري الدخول..." : "تسجيل الدخول"}</button>
      </form>
      <div className="auth-note">في أول تشغيل فقط، استخدم حساب المدير المؤقت ثم سيطلب منك إنشاء حساب مدير جديد.</div>
    </section>
  </main>;
}
