"use client";

import { use, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { API_BASE } from "../../../lib/api-base";
import { ReceiptDocument, printReceipt, type ReceiptVariant } from "../../payments/receipt-document";
import type { SettlementReceipt } from "../../payments/settlement-receipt";

const methodLabels: Record<string, string> = { CASH: "نقدي", VODAFONE_CASH: "فودافون كاش", INSTAPAY: "إنستاباي", BANK: "تحويل بنكي" };

/** Public, login-free view of a shared settlement invoice. Access is granted only by the signed token in the URL. */
export default function SharedReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [receipt, setReceipt] = useState<SettlementReceipt | null>(null);
  const [error, setError] = useState("");
  const [variant, setVariant] = useState<ReceiptVariant>("a4");

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE}/api/public/settlement-receipts/${encodeURIComponent(token)}`, { cache: "no-store", referrerPolicy: "no-referrer" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? "رابط الفاتورة غير صالح أو منتهي");
        if (active) setReceipt(body.data);
      })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "تعذر تحميل الفاتورة"); });
    return () => { active = false; };
  }, [token]);

  function print(next: ReceiptVariant) {
    setVariant(next);
    setTimeout(() => printReceipt(next), 50);
  }

  if (error) return <main dir="rtl" style={{ padding: 32 }}><div className="alert error">{error}</div></main>;
  if (!receipt) return <main dir="rtl" style={{ padding: 32 }}>جارٍ تحميل الفاتورة...</main>;
  return (
    <main dir="rtl" className="shared-receipt-page">
      <div className="shared-receipt-toolbar">
        <a className="primary-button" href={`${API_BASE}/api/public/settlement-receipts/${encodeURIComponent(token)}/pdf`} download>تحميل الفاتورة PDF</a>
        <button type="button" className="secondary-btn" onClick={() => print("a4")}>طباعة A4</button>
        <button type="button" className="secondary-btn" onClick={() => print("thermal")}>إيصال طابعة صغيرة</button>
      </div>
      <div className="receipt-preview">
        <ReceiptDocument receipt={receipt} variant={variant} methodLabel={methodLabels[receipt.payment.method]} />
      </div>
      {createPortal(<div className="receipt-print-root"><ReceiptDocument receipt={receipt} variant={variant} methodLabel={methodLabels[receipt.payment.method]} /></div>, document.body)}
    </main>
  );
}
