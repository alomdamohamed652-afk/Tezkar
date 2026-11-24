"use client";
import { FormEvent, useState } from "react";
import Link from "next/link";
import { API_BASE as API } from "../../lib/api-base";

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

  return <main className="auth-page" dir="rtl"><div className="auth-shell"><section className="auth-card" style={{ maxWidth: 520, margin: "auto" }}>
    <div className="auth-heading"><span className="auth-small-label">استعادة الوصول</span><h1>نسيت كلمة المرور؟</h1><p>عندك طريقين: استعادة فورية على بريدك الإلكتروني المسجل، أو طلب مراجعة من الإدارة.</p></div>

    <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
      <button type="button" className={path === "email" ? "primary-button" : "secondary-btn"} style={{ flex: 1 }} onClick={() => { setPath("email"); setError(""); setMessage(""); }}>على البريد — فوري</button>
      <button type="button" className={path === "admin" ? "primary-button" : "secondary-btn"} style={{ flex: 1 }} onClick={() => { setPath("admin"); setError(""); setMessage(""); }}>من الإدارة — 6 لـ 24 ساعة</button>
    </div>

    {path === "email" && <>
      {step === "phone" && <form className="auth-form" onSubmit={submitLookup}>
        <label className="auth-field"><span>رقم الموبايل المسجل في حسابك</span><input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="01xxxxxxxxx" autoFocus required /></label>
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <button className="auth-submit" disabled={loading}>{loading ? "جاري التحقق..." : "متابعة"}</button>
      </form>}

      {step === "email" && <form className="auth-form" onSubmit={submitRequest}>
        <p style={{ margin: "0 0 4px" }}>البريد المسجل للرقم ده يبدأ بالشكل: <b dir="ltr">{maskedEmail}</b></p>
        <label className="auth-field"><span>اكتب بريدك الإلكتروني كاملًا</span><input value={email} onChange={e => setEmail(e.target.value)} type="email" dir="ltr" placeholder="name@example.com" autoFocus required /></label>
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <button className="auth-submit" disabled={loading}>{loading ? "جاري الإرسال..." : "إرسال الكود"}</button>
        <button type="button" className="secondary-btn" onClick={() => { setStep("phone"); setError(""); }}>تغيير رقم الموبايل</button>
      </form>}

      {step === "code" && <form className="auth-form" onSubmit={submitConfirm}>
        {message ? <div role="status" style={{ padding: 12, borderRadius: 12, background: "#e8f7ef", color: "#176b48" }}>{message}</div> : null}
        <label className="auth-field"><span>كود التحقق (6 أرقام)</span><input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} dir="ltr" placeholder="••••••" autoFocus required /></label>
        <label className="auth-field"><span>كلمة المرور الجديدة (12 حرفًا على الأقل)</span><input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" minLength={12} autoComplete="new-password" required /></label>
        <label className="auth-field"><span>تأكيد كلمة المرور الجديدة</span><input value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} type="password" minLength={12} autoComplete="new-password" required /></label>
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <button className="auth-submit" disabled={loading}>{loading ? "جاري التأكيد..." : "تغيير كلمة المرور"}</button>
        <button type="button" className="secondary-btn" onClick={() => { setStep("email"); setError(""); }}>إعادة إرسال كود</button>
      </form>}

      {step === "done" && <div role="status" style={{ padding: 12, borderRadius: 12, background: "#e8f7ef", color: "#176b48" }}>{message} <Link href="/login">تسجيل الدخول</Link></div>}
    </>}

    {path === "admin" && <form className="auth-form" onSubmit={submitAdmin}>
      <p style={{ margin: "0 0 4px", color: "#64748b" }}>الطلب بيروح للإدارة للمراجعة، وبياخد من 6 لـ 24 ساعة.</p>
      <label className="auth-field"><span>اسم المستخدم أو رقم الموبايل</span><input value={login} onChange={e => setLogin(e.target.value)} autoComplete="username" required placeholder="اسم المستخدم أو رقم الموبايل المسجل" /></label>
      <label className="auth-field"><span>رقم الموبايل المسجل (للمساعدة في تحديد الحساب)</span><input value={adminPhone} onChange={e => setAdminPhone(e.target.value)} inputMode="tel" placeholder="01xxxxxxxxx" /></label>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      {message ? <div role="status" style={{ padding: 12, borderRadius: 12, background: "#e8f7ef", color: "#176b48" }}>{message}</div> : null}
      <button className="auth-submit" disabled={loading}>{loading ? "جاري إرسال الطلب..." : "إرسال طلب للإدارة"}</button>
    </form>}

    <p style={{ textAlign: "center", marginTop: 20 }}><Link href="/login">العودة لتسجيل الدخول</Link></p>
  </section></div></main>;
}
