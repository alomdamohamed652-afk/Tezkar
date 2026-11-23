"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api";
import { API_BASE } from "../../lib/api-base";
import { formatMoney } from "../../lib/format";
import { ReceiptDocument, printReceipt, type ReceiptVariant } from "./receipt-document";

export function whatsappNumber(raw: string | null | undefined): string | null {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = "20" + digits.slice(1);
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export type SettlementReceipt = {
  payment: { id: string; code: string; method: string; paidAt: string; notes: string | null; amount: number };
  employee: { id: string; code: string; name: string; phone?: string | null };
  orders: Array<{
    orderId: string | null;
    orderCode: string | null;
    orderName: string | null;
    total: number;
    lines: Array<{
      productionId: string;
      productionCode: string;
      workDate: string;
      quantity: number | null;
      stageSequence: number | null;
      stageName: string | null;
      amount: number;
    }>;
  }>;
  allocatedTotal: number;
  unallocatedAmount: number;
};

export function SettlementReceiptDialog({ receipt, methodLabel, onClose }: { receipt: SettlementReceipt; methodLabel?: string; onClose: () => void }) {
  const [variant, setVariant] = useState<ReceiptVariant>("a4");
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState("");
  const phone = whatsappNumber(receipt.employee.phone);
  function print(next: ReceiptVariant) {
    setVariant(next);
    // Let React render the chosen layout into the print root before the browser print dialog opens.
    setTimeout(() => printReceipt(next), 50);
  }
  async function downloadPdf() {
    setShareError("");
    try {
      const res = await fetch(API_BASE + "/api/worker-payments/" + encodeURIComponent(receipt.payment.id) + "/settlement-receipt/pdf", { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error("تعذر إنشاء ملف PDF");
      const disposition = res.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const fileName = encoded ? decodeURIComponent(encoded) : "invoice.pdf";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setShareError(e instanceof Error ? e.message : "تعذر تحميل ملف PDF");
    }
  }
  async function sendWhatsapp() {
    if (!phone) return;
    setSharing(true);
    setShareError("");
    const tab = window.open("", "_blank");
    try {
      const r = await api<{ data: { token: string } }>("/api/worker-payments/" + encodeURIComponent(receipt.payment.id) + "/settlement-receipt/share", { method: "POST" });
      const link = window.location.origin + "/r/" + r.data.token;
      const pdfLink = window.location.origin + "/api/public/settlement-receipts/" + r.data.token + "/pdf";
      const text = `فاتورة تسوية ${receipt.payment.code} للعامل ${receipt.employee.name}\nإجمالي: ${formatMoney(receipt.payment.amount)} ج.م\nملف الفاتورة PDF: ${pdfLink}\nعرض الفاتورة: ${link}`;
      const url = "https://wa.me/" + phone + "?text=" + encodeURIComponent(text);
      if (tab) tab.location.href = url; else window.location.href = url;
    } catch (e) {
      tab?.close();
      setShareError(e instanceof Error ? e.message : "تعذر إنشاء رابط الفاتورة");
    } finally {
      setSharing(false);
    }
  }
  return (<>
    {typeof document !== "undefined" && createPortal(<div className="receipt-print-root"><ReceiptDocument receipt={receipt} variant={variant} methodLabel={methodLabel} /></div>, document.body)}
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="فاتورة التسوية" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ padding: 18 }}>
        <h2 style={{ marginTop: 0 }}>فاتورة تسوية {receipt.payment.code}</h2>
        <div className="detail-grid" style={{ margin: "12px 0" }}>
          <div><b>العامل</b><span>{receipt.employee.name} · {receipt.employee.code}</span></div>
          <div><b>إجمالي التسوية</b><span>{formatMoney(receipt.payment.amount)} ج.م</span></div>
          <div><b>طريقة الصرف / التاريخ</b><span>{methodLabel || receipt.payment.method} · {new Date(receipt.payment.paidAt).toLocaleDateString("ar-EG")}</span></div>
        </div>
        {receipt.orders.length === 0 && (
          <div className="empty">لم تُوزّع هذه التسوية على سجلات إنتاج. المبلغ كله مسجل على حساب العامل العام.</div>
        )}
        {receipt.orders.map((order) => (
          <section key={order.orderId ?? "none"} className="card" style={{ marginBottom: 12 }}>
            <div className="card-header">
              <h3 className="card-title">{order.orderCode ? `${order.orderCode} — ${order.orderName ?? ""}` : "إنتاج غير مرتبط بطلبية"}</h3>
              <strong>إجمالي الطلبية في هذه التسوية: {formatMoney(order.total)} ج.م</strong>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>كود الإنتاج</th><th>التاريخ</th><th>المرحلة</th><th>الكمية</th><th>المبلغ في هذه التسوية</th></tr></thead>
                <tbody>
                  {order.lines.map((line) => (
                    <tr key={line.productionId}>
                      <td className="mono">{line.productionCode}</td>
                      <td>{line.workDate}</td>
                      <td>{line.stageName ? `${line.stageSequence ?? ""}${line.stageSequence ? ". " : ""}${line.stageName}` : "—"}</td>
                      <td>{line.quantity ?? "—"}</td>
                      <td className="money">{formatMoney(line.amount)}</td>
                    </tr>
                  ))}
                  <tr><th colSpan={4}>إجمالي الطلبية</th><th className="money">{formatMoney(order.total)}</th></tr>
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {receipt.unallocatedAmount > 0.009 && (
          <p className="form-hint">مبلغ غير موزع على إنتاج (حساب عام / فروق): {formatMoney(receipt.unallocatedAmount)} ج.م</p>
        )}
        <p><strong>إجمالي ما وُزّع على الإنتاج: {formatMoney(receipt.allocatedTotal)} ج.م</strong></p>
        {shareError && <div className="alert error">{shareError}</div>}
        <div className="modal-actions" style={{ padding: 0, gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="primary-button" onClick={() => void downloadPdf()}>تحميل فاتورة PDF</button>
          <button type="button" className="secondary-btn" onClick={() => print("a4")}>طباعة فاتورة رسمية A4</button>
          <button type="button" className="secondary-btn" onClick={() => print("thermal")}>إيصال طابعة صغيرة</button>
          {phone
            ? <button type="button" className="secondary-btn" disabled={sharing} onClick={() => void sendWhatsapp()}>{sharing ? "جارٍ التجهيز..." : "إرسال الرابط على واتساب"}</button>
            : <span className="form-hint">لا يوجد رقم هاتف مسجل للعامل لإرسال الفاتورة على واتساب.</span>}
          <button type="button" className="secondary-btn" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  </>);
}
