"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, usePermissions } from "../../../components/sidebar";

export default function DirectWorkerPaymentPage() {
  const router = useRouter();
  const { has, permissions } = usePermissions();
  const canPay = has("worker_payments.pay");

  useEffect(() => {
    if (permissions !== null && canPay) router.replace("/payments");
  }, [permissions, canPay, router]);

  return (
    <div className="app-shell">
      <Sidebar active="/payments" />
      <main className="main">
        <section className="content">
          {permissions === null ? (
            <div className="empty">جارٍ التحقق من الصلاحيات...</div>
          ) : canPay ? (
            <div className="empty">جارٍ نقلك إلى صفحة القبض والمدفوعات الموحدة...</div>
          ) : (
            <div className="alert error">ليس لديك صلاحية صرف مستحقات العمال.</div>
          )}
        </section>
      </main>
    </div>
  );
}
