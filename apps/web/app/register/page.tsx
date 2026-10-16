"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { API_BASE as API } from "../../lib/api-base";

export default function RegisterPage() {
  const [fullName,setFullName]=useState("");
  const [username,setUsername]=useState("");
  const [phone,setPhone]=useState("");
  const [password,setPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [error,setError]=useState("");
  const [submitted,setSubmitted]=useState(false);
  const [loading,setLoading]=useState(false);

  async function submit(event:FormEvent) {
    event.preventDefault();
    if(loading)return;
    setError("");
    if(password!==confirmPassword){setError("كلمتا المرور غير متطابقتين");return;}
    setLoading(true);
    try {
      const response=await fetch(`${API}/api/auth/register`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        credentials:"include",
        body:JSON.stringify({fullName,username:username.trim(),phone,password,confirmPassword})
      });
      const body=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(body?.error?.message??"تعذر إرسال طلب التسجيل");
      setSubmitted(true);
    } catch(err) {
      setError(err instanceof Error?err.message:"تعذر إرسال طلب التسجيل");
    } finally {setLoading(false);}
  }

  return <main className="auth-page" dir="rtl"><div className="auth-shell">
    <section className="auth-showcase" aria-label="نظام تذكار">
      <div className="auth-showcase-top"><div className="auth-logo-mark"><img src="https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png" alt="شعار تذكار"/></div><div><strong>تذكار</strong><span>إدارة المصنع</span></div></div>
      <div className="auth-showcase-content"><span className="auth-kicker">إنشاء حساب جديد</span><h2>حسابك يبدأ<br/><em>بموافقة الإدارة.</em></h2><p>قدّم طلب التسجيل، ومدير النظام هيراجع بياناتك ويحدد الدور والصلاحيات المناسبة قبل تفعيل الحساب.</p></div>
      <div className="auth-showcase-footer">TEZKAR ERP <span>•</span> Factory Management</div>
    </section>
    <section className="auth-card" aria-labelledby="register-title">
      <div className="auth-heading"><span className="auth-small-label">طلب انضمام للمنصة</span><h1 id="register-title">{submitted?"طلبك وصل للإدارة":"إنشاء حساب"}</h1><p>{submitted?"تم استلام طلبك بنجاح. لن تتمكن من الدخول إلا بعد موافقة المدير.":"املأ البيانات التالية لإرسال طلب تفعيل حسابك."}</p></div>
      {submitted?<div className="auth-security" role="status"><span className="auth-lock">✓</span><span>تم إرسال الطلب. احتفظ باسم المستخدم وكلمة المرور للدخول بعد التفعيل.</span></div>:<form className="auth-form" onSubmit={submit}>
        <label className="auth-field"><span>الاسم بالكامل</span><div className="auth-input-wrap"><input value={fullName} onChange={e=>setFullName(e.target.value)} autoComplete="name" minLength={3} maxLength={160} required placeholder="اكتب اسمك بالكامل"/></div></label>
        <label className="auth-field"><span>اسم المستخدم (إنجليزي)</span><div className="auth-input-wrap"><input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z0-9._-]{3,100}" required placeholder="مثال: ahmed.mohamed"/></div></label>
        <label className="auth-field"><span>رقم الموبايل (اختياري)</span><div className="auth-input-wrap"><input value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel" maxLength={30} inputMode="tel" placeholder="01xxxxxxxxx"/></div></label>
        <label className="auth-field"><span>كلمة المرور (12 حرفًا على الأقل)</span><div className="auth-input-wrap"><input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={200} required placeholder="أنشئ كلمة مرور قوية"/></div></label>
        <label className="auth-field"><span>تأكيد كلمة المرور</span><div className="auth-input-wrap"><input value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={200} required placeholder="أعد كتابة كلمة المرور"/></div></label>
        {error&&<div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div>}
        <button className="auth-submit" disabled={loading}><span>{loading?"جاري إرسال الطلب...":"إرسال طلب التسجيل"}</span>{!loading&&<span className="auth-submit-arrow">←</span>}</button>
      </form>}
      <div className="auth-security"><span className="auth-lock">●</span><span>إنشاء الحساب لا يمنحك صلاحية الدخول تلقائيًا.</span></div>
      <p style={{textAlign:"center",marginTop:20}}><Link href="/login">عندك حساب بالفعل؟ تسجيل الدخول</Link></p>
    </section>
  </div></main>;
}
