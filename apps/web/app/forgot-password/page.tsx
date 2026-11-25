"use client";
import { FormEvent, useState } from "react";
import Link from "next/link";
import { API_BASE as API } from "../../lib/api-base";
import { OtpInput } from "../../components/otp-input";

type Path = "email" | "admin";
type EmailStep = "phone" | "email" | "code" | "done";

export default function ForgotPasswordPage() {
  const [path, setPath] = useState<Path>("email");
  const [step, setStep] = useState<EmailStep>("phone");
  const [phone, setPhone] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [login, setLogin] = useState("");
  const [adminPhone, setAdminPhone] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function post(url: string, body: Record<string, string>) {
    const res = await fetch(`${API}${url}`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error?.message ?? "حدث خطأ. حاول مرة أخرى.");
    return payload;
  }

  async function submitLookup(e: FormEvent) {
    e.preventDefault(); if (loading) return;
    setError(""); setLoading(true);
    try {
      const res = await post("/api/auth/password-reset/email/lookup", { phone: phone.trim() });
      setMaskedEmail(res?.data?.maskedEmail ?? "");
      setStep("email");
    } catch (err) { setError(err instanceof Error ? err.message : "تعذر التحقق من الرقم"); }
    finally { setLoading(false); }
  }

  async function submitRequest(e: FormEvent) {
    e.preventDefault(); if (loading) return;
    setError(""); setMessage(""); setLoading(true);
    try {
      const res = await post("/api/auth/password-reset/email/request", { phone: phone.trim(), email: email.trim() });
      setMessage(res?.message ?? "لو البيانات مطابقة لحسابك هيوصلك كود التحقق على بريدك خلال دقائق.");
      setStep("code");
    } catch (err) { setError(err instanceof Error ? err.message : "تعذر إرسال الكود"); }
    finally { setLoading(false); }
  }

  async function submitConfirm(e: FormEvent) {
    e.preventDefault(); if (loading) return;
    setError(""); setLoading(true);
    try {
      const res = await post("/api/auth/password-reset/email/confirm", { phone: phone.trim(), code: code.trim(), newPassword, confirmPassword });
      setMessage(res?.message ?? "تم تغيير كلمة المرور.");
      setStep("done");
    } catch (err) { setError(err instanceof Error ? err.message : "تعذر تأكيد الكود"); }
    finally { setLoading(false); }
  }

  async function submitAdmin(e: FormEvent) {
    e.preventDefault(); if (loading) return;
    setError(""); setMessage(""); setLoading(true);
    try {
      const res = await post("/api/auth/password-reset-requests", { login: login.trim(), phone: adminPhone.trim() });
      setMessage(res?.message ?? "تم إرسال الطلب للإدارة. تابع مع المدير بعد المراجعة.");
    } catch (err) { setError(err instanceof Error ? err.message : "تعذر إرسال الطلب"); }
    finally { setLoading(false); }
  }

  return <main className="auth-page" dir="rtl"><div className="auth-shell">
    <section className="auth-showcase" aria-label="نظام تذكار">
      <div className="auth-showcase-top">
        <div className="auth-logo-mark"><img src="/tezkar-logo.png" alt="شعار تذكار" /></div>
        <div><strong>تذكار</strong><span>إدارة المصنع</span></div>
      </div>
      <div className="auth-showcase-content">
        <span className="auth-kicker">استعادة الوصول</span>
        <h2>رجّع حسابك<br /><em>في دقائق.</em></h2>
        <p>استعادة فورية بكود على بريدك الإلكتروني المسجل، أو طلب مراجعة من الإدارة لو البريد مش متاح.</p>
        <div className="auth-feature-list">
          <div><b>01</b><span>كود تحقق يوصلك على بريدك خلال دقائق</span></div>
          <div><b>02</b><span>الكود صالح 10 دقائق ويُستخدم مرة واحدة</span></div>
          <div><b>03</b><span>بديل آمن بمراجعة الإدارة عند الحاجة</span></div>
        </div>
      </div>
      <div className="auth-showcase-footer">TEZKAR ERP <span>•</span> Factory Management</div>
    </section>

    <section className="auth-card" aria-labelledby="forgot-title">
      <div className="auth-mobile-brand">
        <div className="auth-logo-mark"><img src="/tezkar-logo.png" alt="شعار تذكار" /></div>
        <div><strong>تذكار</strong><span>إدارة المصنع</span></div>
      </div>

      <div className="auth-heading">
        <span className="auth-small-label">استعادة الوصول</span>
        <h1 id="forgot-title">نسيت كلمة المرور؟</h1>
        <p>عندك طريقين: استعادة فورية على بريدك الإلكتروني المسجل، أو طلب مراجعة من الإدارة.</p>
      </div>

      {path === "email" && <div className="auth-steps" aria-hidden="true">
        {["التحقق","التعيين","الانتهاء"].map((label,i)=>{
          const idx = step === "phone" || step === "email" ? 0 : step === "code" ? 1 : 2;
          return <div key={label} className={"auth-step"+(i<idx?" done":i===idx?" current":"")}><span className="auth-step-dot">{i<idx?"✓":i+1}</span><span className="auth-step-label">{label}</span></div>;
        })}
      </div>}

      <div className="auth-tabs">
        <button type="button" className={path === "email" ? "primary-button" : "secondary-btn"} onClick={() => { setPath("email"); setError(""); setMessage(""); }}>على البريد — فوري</button>
        <button type="button" className={path === "admin" ? "primary-button" : "secondary-btn"} onClick={() => { setPath("admin"); setError(""); setMessage(""); }}>من الإدارة — 6 لـ 24 ساعة</button>
      </div>

      {path === "email" && <>
        {step === "phone" && <form className="auth-form" onSubmit={submitLookup}>
          <label className="auth-field"><span>رقم الموبايل المسجل في حسابك</span><div className="auth-input-wrap"><input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="01xxxxxxxxx" autoFocus required /></div></label>
          {error ? <div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div> : null}
          <button className="auth-submit" disabled={loading}><span>{loading ? "جاري التحقق..." : "متابعة"}</span>{!loading && <span className="auth-submit-arrow">←</span>}</button>
        </form>}

        {step === "email" && <form className="auth-form" onSubmit={submitRequest}>
          <p className="auth-masked">البريد المسجل على هذا الرقم: <b dir="ltr">{maskedEmail}</b></p>
          <label className="auth-field"><span>اكتب بريدك الإلكتروني كاملًا</span><div className="auth-input-wrap"><input value={email} onChange={e => setEmail(e.target.value)} type="email" dir="ltr" placeholder="name@example.com" autoFocus required /></div></label>
          {error ? <div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div> : null}
          <button className="auth-submit" disabled={loading}><span>{loading ? "جاري الإرسال..." : "إرسال الكود"}</span>{!loading && <span className="auth-submit-arrow">←</span>}</button>
          <button type="button" className="secondary-btn auth-secondary-wide" onClick={() => { setStep("phone"); setError(""); }}>تغيير رقم الموبايل</button>
        </form>}

        {step === "code" && <form className="auth-form" onSubmit={submitConfirm}>
          {message ? <div className="auth-banner success" role="status">{message}</div> : null}
          <div className="auth-note" role="note">لو الرسالة مش ظاهرة في الوارد، بص في السبام / الرسائل غير الهامة.</div>
          <label className="auth-field"><span>كود التحقق (6 أرقام)</span><OtpInput value={code} onChange={setCode} autoFocus/></label>
          <label className="auth-field"><span>كلمة المرور الجديدة (12 حرفًا على الأقل)</span><div className="auth-input-wrap"><input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" minLength={12} autoComplete="new-password" required /></div></label>
          <label className="auth-field"><span>تأكيد كلمة المرور الجديدة</span><div className="auth-input-wrap"><input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} type="password" minLength={12} autoComplete="new-password" required /></div></label>
          {error ? <div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div> : null}
          <button className="auth-submit" disabled={loading}><span>{loading ? "جاري التأكيد..." : "تغيير كلمة المرور"}</span>{!loading && <span className="auth-submit-arrow">←</span>}</button>
          <button type="button" className="secondary-btn auth-secondary-wide" onClick={() => { setStep("email"); setError(""); }}>إرسال الكود مرة أخرى</button>
        </form>}

        {step === "done" && <>
          <div className="auth-banner success" role="status">{message} سجّل دخولك بكلمة المرور الجديدة.</div>
          <Link href="/login" className="auth-submit auth-submit-link"><span>تسجيل الدخول</span><span className="auth-submit-arrow">←</span></Link>
        </>}
      </>}

      {path === "admin" && <form className="auth-form" onSubmit={submitAdmin}>
        <p className="auth-masked">الطلب بيروح للإدارة للمراجعة، وبياخد من 6 لـ 24 ساعة.</p>
        <label className="auth-field"><span>اسم المستخدم أو رقم الموبايل</span><div className="auth-input-wrap"><input value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" required placeholder="اسم المستخدم أو رقم الموبايل المسجل" /></div></label>
        <label className="auth-field"><span>رقم الموبايل المسجل (للمساعدة في تحديد الحساب)</span><div className="auth-input-wrap"><input value={adminPhone} onChange={e => setAdminPhone(e.target.value)} inputMode="tel" placeholder="01xxxxxxxxx" /></div></label>
        {error ? <div className="auth-error" role="alert"><span className="auth-error-icon">!</span><span>{error}</span></div> : null}
        {message ? <div className="auth-banner success" role="status">{message}</div> : null}
        <button className="auth-submit" disabled={loading}><span>{loading ? "جاري إرسال الطلب..." : "إرسال طلب للإدارة"}</span>{!loading && <span className="auth-submit-arrow">←</span>}</button>
      </form>}

      <div className="auth-links"><Link href="/login">العودة لتسجيل الدخول</Link></div>

      <div className="auth-security">
        <span className="auth-lock">●</span>
        <span>اتصال آمن — بيانات حسابك لا تظهر في الصفحة</span>
      </div>
    </section>
  </div></main>;
}
