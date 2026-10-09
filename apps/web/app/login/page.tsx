"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function LoginPage() {
  const router = useRouter();
  const [username,setUsername]=useState("");
  const [password,setPassword]=useState("");
  const [showPassword,setShowPassword]=useState(false);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);

  async function submit(e:FormEvent) {
    e.preventDefault();
    if(loading)return;
    setError("");
    setLoading(true);
    try {
      const res=await fetch(`${API}/api/auth/login`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        credentials:"include",
        body:JSON.stringify({username:username.trim(),password})
      });
      const body=await res.json().catch(()=>null);
      if(!res.ok) throw new Error(body?.error?.message ?? "تعذر تسجيل الدخول");
      router.replace(body?.requiresSetup ? "/setup" : "/");
    } catch(err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-page" dir="rtl">
      <div className="auth-shell">
        <section className="auth-showcase" aria-label="نظام تذكار">
          <div className="auth-showcase-top">
            <div className="auth-logo-mark">ت</div>
            <div>
              <strong>تذكار</strong>
              <span>إدارة المصنع</span>
            </div>
          </div>

          <div className="auth-showcase-content">
            <span className="auth-kicker">نظام إدارة متكامل</span>
            <h2>كل عمليات المصنع<br/><em>في مكان واحد.</em></h2>
            <p>الإنتاج، الطلبات، المخزون، التسليمات والمالية — بمتابعة واضحة وسجل دقيق لكل حركة.</p>
            <div className="auth-feature-list">
              <div><b>01</b><span>متابعة الإنتاج والتكاليف</span></div>
              <div><b>02</b><span>حركة مخزون مرتبطة بالتكلفة</span></div>
              <div><b>03</b><span>مالية وتقارير لحظية</span></div>
            </div>
          </div>

          <div className="auth-showcase-footer">TEZKAR ERP <span>•</span> Factory Management</div>
        </section>

        <section className="auth-card" aria-labelledby="login-title">
          <div className="auth-mobile-brand">
            <div className="auth-logo-mark">ت</div>
            <div><strong>تذكار</strong><span>إدارة المصنع</span></div>
          </div>

          <div className="auth-heading">
            <span className="auth-small-label">مرحباً بعودتك</span>
            <h1 id="login-title">تسجيل الدخول</h1>
            <p>سجّل دخولك للوصول إلى لوحة إدارة المصنع.</p>
          </div>

          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field">
              <span>اسم المستخدم</span>
              <div className="auth-input-wrap">
                <span className="auth-input-icon" aria-hidden="true">⌁</span>
                <input
                  value={username}
                  onChange={e=>setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="اكتب اسم المستخدم"
                  autoFocus
                  required
                />
              </div>
            </label>

            <label className="auth-field">
              <span>كلمة المرور</span>
              <div className="auth-input-wrap">
                <span className="auth-input-icon" aria-hidden="true">⌑</span>
                <input
                  value={password}
                  onChange={e=>setPassword(e.target.value)}
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="اكتب كلمة المرور"
                  required
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  onClick={()=>setShowPassword(v=>!v)}
                  aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                >
                  {showPassword ? "إخفاء" : "إظهار"}
                </button>
              </div>
            </label>

            {error ? (
              <div className="auth-error" role="alert">
                <span className="auth-error-icon">!</span>
                <span>{error}</span>
              </div>
            ) : null}

            <button className="auth-submit" disabled={loading}>
              <span>{loading ? "جاري التحقق..." : "دخول إلى النظام"}</span>
              {!loading && <span className="auth-submit-arrow">←</span>}
            </button>
          </form>

          <div className="auth-security">
            <span className="auth-lock">●</span>
            <span>اتصال آمن — بيانات حسابك لا تظهر في الصفحة</span>
          </div>

          <div className="auth-note">
            <b>أول تشغيل؟</b>
            <span>استخدم حساب المدير المؤقت، وبعد الدخول سيطلب منك النظام إعداد حساب المدير الجديد.</span>
          </div>
        </section>
      </div>
    </main>
  );
}
