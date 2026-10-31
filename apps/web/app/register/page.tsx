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
    if(phone.replace(/\D/g,"").length<10){setError("رقم الموبايل إلزامي ولازم يحتوي على 10 أرقام على الأقل");return;}
    if(password!==confirmPassword){setError("كلمتا المرور غير متطابقتين");return;}
    setLoading(true);
    try {
      const response=await fetch(`${API}/api/auth/register`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        credentials:"include",
        body:JSON.stringify({fullName,username:username.trim(),phone:phone.trim(),password,confirmPassword})
      });
      const body=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(body?.error?.message??"تعذر إرسال طلب التسجيل");
      setSubmitted(true);
    } catch(err) {
      setError(err instanceof Error?err.message:"تعذر إرسال طلب التسجيل");
    } finally {setLoading(false);}
  }

  return <main className="auth-page" dir="rtl">
    <div className="auth-shell">
      <section className="auth-showcase" aria-label="نظام تذكار">
        <div className="auth-showcase-top"><div className="auth-logo-mark"><img src="https://raw.githubusercontent.com/alomdamohamed652-afk/Tezkar/main/tezkar%20logo.png" alt="شعار تذكار"/></div><div><strong>تذكار</strong><span>إدارة المصنع</span></div></div>
        <div className="auth-showcase-content"><span className="auth-kicker">بوابة انضمام جديدة</span><h2>حسابك يبدأ<br/><em>بموافقة الإدارة.</em></h2><p>أنشئ طلبك مرة واحدة، والإدارة هتراجع بياناتك وتحدد صلاحياتك وتربط حسابك بملف الموظف لو كنت مسجلًا كموظف.</p>
          <div style={{display:"grid",gap:12,marginTop:24}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{display:"grid",placeItems:"center",width:32,height:32,borderRadius:10,background:"rgba(34,197,94,.18)",color:"#86efac",fontWeight:900}}>1</span><span>اكتب بياناتك ورقم الموبايل الصحيح</span></div>
            <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{display:"grid",placeItems:"center",width:32,height:32,borderRadius:10,background:"rgba(34,197,94,.18)",color:"#86efac",fontWeight:900}}>2</span><span>الإدارة تختار نوع الحساب والدور</span></div>
            <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{display:"grid",placeItems:"center",width:32,height:32,borderRadius:10,background:"rgba(34,197,94,.18)",color:"#86efac",fontWeight:900}}>3</span><span>بعد التفعيل تدخل باليوزر أو الموبايل</span></div>
          </div>
        </div>
        <div className="auth-showcase-footer">TEZKAR ERP <span>•</span> Factory Management</div>
      </section>
      <section className="auth-card" aria-labelledby="register-title">
        <div style={{display:"inline-flex",alignItems:"center",gap:8,alignSelf:"flex-start",padding:"7px 11px",borderRadius:999,background:"#ecfdf5",border:"1px solid #a7f3d0",color:"#047857",fontSize:12,fontWeight:900,marginBottom:14}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#10b981"}}/> تسجيل مستخدم جديد
        </div>
        <div className="auth-heading"><span className="auth-small-label">طلب انضمام للمنصة</span><h1 id="register-title">{submitted?"طلبك وصل للإدارة":"إنشاء حساب"}</h1><p>{submitted?"تم استلام طلبك بنجاح. لن تتمكن من الدخول إلا بعد موافقة المدير.":"املأ البيانات التالية لإرسال طلب تفعيل حسابك."}</p></div>
        {submitted?<div className="auth-security" role="status"><span className="auth-lock">✓</span><span>تم إرسال الطلب. بعد التفعيل تقدر تدخل باسم المستخدم أو رقم الموبايل المسجل مع كلمة المرور نفسها.</span></div>:<form className="auth-form" onSubmit={submit}>
          <label className="auth-field"><span>الاسم بالكامل</span><div className="auth-input-wrap"><input value={fullName} onChange={e=>setFullName(e.target.value)} autoComplete="name" minLength={3} maxLength={160} required placeholder="اكتب اسمك بالكامل"/></div></label>
          <label className="auth-field"><span>اسم المستخدم (إنجليزي)</span><div className="auth-input-wrap"><input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z0-9._-]{3,100}" minLength={3} maxLength={100} required placeholder="مثال: ahmed.mohamed"/></div><small style={{color:"var(--muted,#64748b)"}}>تقدر تستخدمه أو رقم الموبايل لتسجيل الدخول.</small></label>
          <label className="auth-field"><span>رقم الموبايل <b style={{color:"#dc2626"}}>* إلزامي</b></span><div className="auth-input-wrap"><input value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel" minLength={10} maxLength={30} inputMode="tel" pattern="[+()0-9 .-]{10,30}" required placeholder="01xxxxxxxxx"/></div><small style={{color:"var(--muted,#64748b)"}}>لازم يكون رقم صحيح ومش مرتبط بحساب تاني.</small></label>
          <label className="auth-field"><span>كلمة المرور (12 حرفًا على الأقل)</span><div className="auth-input-wrap"><input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={200} required placeholder="أنشئ كلمة مرور قوية"/></div></label>
          <label className="auth-field"><span>تأكيد كلمة المرور</span><div className="auth-input-wrap"><input value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={200} required placeholder="أعد كتابة كلمة المرور"/></div></label>
          {error&&<div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div>}
          <button className="auth-submit" disabled={loading} style={{background:"linear-gradient(135deg,#059669,#047857)",boxShadow:"0 10px 24px rgba(5,150,105,.22)"}}><span>{loading?"جاري إرسال الطلب...":"إنشاء الحساب وإرسال الطلب"}</span>{!loading&&<span className="auth-submit-arrow">←</span>}</button>
        </form>}
        <div className="auth-security"><span className="auth-lock">●</span><span>إنشاء الطلب لا يمنحك صلاحية الدخول تلقائيًا.</span></div>
        <p style={{textAlign:"center",marginTop:20}}><Link href="/login">عندك حساب بالفعل؟ تسجيل الدخول</Link></p>
      </section>
    </div>
  </main>;
}
