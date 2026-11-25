"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { API_BASE as API } from "../../lib/api-base";
import { OtpInput } from "../../components/otp-input";

export default function RegisterPage() {
  const [fullName,setFullName]=useState("");
  const [username,setUsername]=useState("");
  const [phone,setPhone]=useState("");
  const [password,setPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [email,setEmail]=useState("");
  const [emailCode,setEmailCode]=useState("");
  const [codeSent,setCodeSent]=useState(false);
  const [codeSending,setCodeSending]=useState(false);
  const [codeMessage,setCodeMessage]=useState("");
  const [error,setError]=useState("");
  const [submitted,setSubmitted]=useState(false);
  const [loading,setLoading]=useState(false);

  async function sendEmailCode() {
    if(codeSending)return;
    setError("");setCodeMessage("");
    const trimmed=email.trim();
    if(!/^\S+@\S+\.\S+$/.test(trimmed)){setError("اكتب البريد الإلكتروني بشكل صحيح الأول");return;}
    setCodeSending(true);
    try {
      const response=await fetch(`${API}/api/auth/register/email/request`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        credentials:"include",
        body:JSON.stringify({email:trimmed})
      });
      const body=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(body?.error?.message??"تعذر إرسال كود التحقق");
      setCodeSent(true);
      setCodeMessage(body?.message??"تم إرسال كود التحقق إلى بريدك.");
    } catch(err) {
      setError(err instanceof Error?err.message:"تعذر إرسال كود التحقق");
    } finally {setCodeSending(false);}
  }

  async function submit(event:FormEvent) {
    event.preventDefault();
    if(loading)return;
    setError("");
    if(phone.replace(/\D/g,"").length<10){setError("رقم الموبايل إلزامي ولازم يحتوي على 10 أرقام على الأقل");return;}
    if(password!==confirmPassword){setError("كلمتا المرور غير متطابقتين");return;}
    if(!codeSent||emailCode.trim().length<4){setError("أرسل كود التحقق لبريدك الإلكتروني واكتبه هنا");return;}
    setLoading(true);
    try {
      const response=await fetch(`${API}/api/auth/register`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        credentials:"include",
        body:JSON.stringify({fullName,username:username.trim(),phone:phone.trim(),password,confirmPassword,email:email.trim(),emailCode:emailCode.trim()})
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
        <div className="auth-showcase-top"><div className="auth-logo-mark"><img src="/tezkar-logo.png" alt="شعار تذكار"/></div><div><strong>تذكار</strong><span>إدارة المصنع</span></div></div>
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
        <div className="auth-mobile-brand">
          <div className="auth-logo-mark"><img src="/tezkar-logo.png" alt="شعار تذكار"/></div>
          <div><strong>تذكار</strong><span>إدارة المصنع</span></div>
        </div>
        <div className="auth-chip">
          <span style={{width:8,height:8,borderRadius:"50%",background:"#10b981"}}/> تسجيل مستخدم جديد
        </div>
        <div className="auth-heading"><span className="auth-small-label">طلب انضمام للمنصة</span><h1 id="register-title">{submitted?"طلبك وصل للإدارة":"إنشاء حساب"}</h1><p>{submitted?"تم استلام طلبك بنجاح. لن تتمكن من الدخول إلا بعد موافقة المدير.":"املأ البيانات التالية لإرسال طلب تفعيل حسابك."}</p></div>
        {submitted?<div className="auth-security" role="status"><span className="auth-lock">✓</span><span>تم إرسال الطلب. بعد التفعيل تقدر تدخل باسم المستخدم أو رقم الموبايل المسجل مع كلمة المرور نفسها.</span></div>:<form className="auth-form" onSubmit={submit}>
          <label className="auth-field"><span>الاسم بالكامل</span><div className="auth-input-wrap"><input value={fullName} onChange={e=>setFullName(e.target.value)} autoComplete="name" minLength={3} maxLength={160} required placeholder="اكتب اسمك بالكامل"/></div></label>
          <label className="auth-field"><span>اسم المستخدم (إنجليزي)</span><div className="auth-input-wrap"><input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" pattern="[A-Za-z0-9._-]{3,100}" minLength={3} maxLength={100} required placeholder="مثال: ahmed.mohamed"/></div><small className="auth-hint">تقدر تستخدمه أو رقم الموبايل لتسجيل الدخول.</small></label>
          <label className="auth-field"><span>رقم الموبايل <b style={{color:"#f87171"}}>* إلزامي</b></span><div className="auth-input-wrap"><input value={phone} onChange={e=>setPhone(e.target.value)} autoComplete="tel" minLength={10} maxLength={30} inputMode="tel" pattern="[+()0-9 .-]{10,30}" required placeholder="01xxxxxxxxx"/></div><small className="auth-hint">لازم يكون رقم صحيح ومش مرتبط بحساب تاني.</small></label>
          <label className="auth-field"><span>البريد الإلكتروني <b style={{color:"#f87171"}}>* إلزامي</b></span><div className="auth-input-wrap"><input value={email} onChange={e=>{setEmail(e.target.value);setCodeSent(false);setEmailCode("");setCodeMessage("")}} type="email" dir="ltr" autoComplete="email" maxLength={320} required placeholder="name@example.com"/></div><small className="auth-hint">هيوصلك عليه كود تحقق، وهتقدر بيه تستعيد كلمة المرور بعدين.</small></label>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <button type="button" className="secondary-btn" onClick={()=>void sendEmailCode()} disabled={codeSending||!email.trim()}>{codeSending?"جاري الإرسال...":codeSent?"إعادة إرسال الكود":"إرسال كود التحقق"}</button>
            {codeMessage&&<span style={{color:"#176b48",fontSize:12,fontWeight:700}}>{codeMessage}</span>}
          </div>
          {codeSent&&<div className="auth-note" role="note">لو الرسالة مش ظاهرة في الوارد، بص في السبام / الرسائل غير الهامة.</div>}
          {codeSent&&<label className="auth-field"><span>كود التحقق من البريد (6 أرقام)</span><OtpInput value={emailCode} onChange={setEmailCode}/></label>}
          <label className="auth-field"><span>كلمة المرور (12 حرفًا على الأقل)</span><div className="auth-input-wrap"><input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={200} required placeholder="أنشئ كلمة مرور قوية"/></div></label>
          <label className="auth-field"><span>تأكيد كلمة المرور</span><div className="auth-input-wrap"><input value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={200} required placeholder="أعد كتابة كلمة المرور"/></div></label>
          {error&&<div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div>}
          <button className="auth-submit" disabled={loading}><span>{loading?"جاري إرسال الطلب...":"إنشاء الحساب وإرسال الطلب"}</span>{!loading&&<span className="auth-submit-arrow">←</span>}</button>
        </form>}
        <div className="auth-security"><span className="auth-lock">●</span><span>إنشاء الطلب لا يمنحك صلاحية الدخول تلقائيًا.</span></div>
        <p style={{textAlign:"center",marginTop:20}}><Link href="/login">عندك حساب بالفعل؟ تسجيل الدخول</Link></p>
      </section>
    </div>
  </main>;
}
