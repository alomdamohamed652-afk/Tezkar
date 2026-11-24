"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";

const DISMISS_KEY = "tezkar_email_prompt_dismissed";

export function EmailPrompt() {
  const router = useRouter();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    let active = true;
    api<{ data: { email: string | null; email_verified_at: string | null } }>("/api/account/profile")
      .then(r => { if (active && !r.data.email) setShow(true); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  if (!show) return null;
  function dismiss() {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setShow(false);
  }
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="email-prompt-title">
      <h2 id="email-prompt-title">أضف بريدك الإلكتروني</h2>
      <p>سجّل بريدك الإلكتروني مرة واحدة لتقدر تستعيد كلمة المرور بنفسك في أي وقت بكود يوصلك على بريدك، بدون انتظار مراجعة الإدارة.</p>
      <div className="form-actions">
        <button className="secondary-button" type="button" onClick={dismiss}>لاحقًا</button>
        <button className="primary-button" type="button" onClick={() => router.push("/account")}>إضافة البريد</button>
      </div>
    </section>
  </div>;
}
