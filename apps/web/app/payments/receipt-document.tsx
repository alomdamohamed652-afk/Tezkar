"use client";

import { formatMoney } from "../../lib/format";
import type { SettlementReceipt } from "./settlement-receipt";

export type ReceiptVariant = "a4" | "thermal";

const fmtDate = (value: string) => new Date(value).toLocaleDateString("ar-EG");

/** Printable settlement invoice. "a4" is the formal full-page invoice, "thermal" is the narrow 80mm printer receipt. */
export function ReceiptDocument({ receipt, variant, methodLabel }: { receipt: SettlementReceipt; variant: ReceiptVariant; methodLabel?: string }) {
  if (variant === "thermal") {
    return (
      <div className="receipt-doc receipt-thermal" dir="rtl">
        <div className="rt-center rt-title">تذكار</div>
        <div className="rt-center">إيصال تسوية مستحقات</div>
        <div className="rt-line" />
        <div>رقم: {receipt.payment.code}</div>
        <div>التاريخ: {fmtDate(receipt.payment.paidAt)}</div>
        <div>العامل: {receipt.employee.name} ({receipt.employee.code})</div>
        <div>الدفع: {methodLabel || receipt.payment.method}</div>
        <div className="rt-line" />
        {receipt.orders.map((order) => (
          <div key={order.orderId ?? "none"} className="rt-block">
            <div className="rt-bold">{order.orderCode ? `${order.orderCode} - ${order.orderName ?? ""}` : "إنتاج غير مرتبط بطلبية"}</div>
            {order.lines.map((line) => (
              <div key={line.productionId} className="rt-row">
                <span>{line.productionCode}{line.stageName ? ` / ${line.stageName}` : ""}</span>
                <span>{formatMoney(line.amount)}</span>
              </div>
            ))}
            <div className="rt-row rt-bold"><span>إجمالي الطلبية</span><span>{formatMoney(order.total)}</span></div>
          </div>
        ))}
        {receipt.unallocatedAmount > 0.009 && <div className="rt-row"><span>حساب عام / فروق</span><span>{formatMoney(receipt.unallocatedAmount)}</span></div>}
        <div className="rt-line" />
        <div className="rt-row rt-bold rt-total"><span>الإجمالي</span><span>{formatMoney(receipt.payment.amount)} ج.م</span></div>
        <div className="rt-line" />
        <div className="rt-center">توقيع المستلم: ____________</div>
      </div>
    );
  }
  return (
    <div className="receipt-doc receipt-a4" dir="rtl">
      <header className="ra-head">
        <div>
          <h1>تذكار</h1>
          <div className="ra-sub">فاتورة تسوية مستحقات عامل</div>
        </div>
        <table className="ra-meta">
          <tbody>
            <tr><th>رقم الفاتورة</th><td>{receipt.payment.code}</td></tr>
            <tr><th>تاريخ التسوية</th><td>{fmtDate(receipt.payment.paidAt)}</td></tr>
            <tr><th>طريقة الصرف</th><td>{methodLabel || receipt.payment.method}</td></tr>
          </tbody>
        </table>
      </header>
      <section className="ra-party">
        <strong>العامل:</strong> {receipt.employee.name} <span>({receipt.employee.code})</span>
      </section>
      {receipt.orders.length === 0 && <p>لم تُوزّع هذه التسوية على سجلات إنتاج؛ المبلغ مسجل على حساب العامل العام.</p>}
      {receipt.orders.map((order) => (
        <section key={order.orderId ?? "none"} className="ra-order">
          <h2>{order.orderCode ? `${order.orderCode} — ${order.orderName ?? ""}` : "إنتاج غير مرتبط بطلبية"}</h2>
          <table className="ra-table">
            <thead><tr><th>كود الإنتاج</th><th>التاريخ</th><th>المرحلة</th><th>الكمية</th><th>المبلغ (ج.م)</th></tr></thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.productionId}>
                  <td>{line.productionCode}</td>
                  <td>{line.workDate}</td>
                  <td>{line.stageName ? `${line.stageSequence ? line.stageSequence + ". " : ""}${line.stageName}` : "—"}</td>
                  <td>{line.quantity ?? "—"}</td>
                  <td>{formatMoney(line.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th colSpan={4}>إجمالي الطلبية</th><th>{formatMoney(order.total)}</th></tr></tfoot>
          </table>
        </section>
      ))}
      {receipt.unallocatedAmount > 0.009 && <p>مبلغ غير موزع على إنتاج (حساب عام / فروق): {formatMoney(receipt.unallocatedAmount)} ج.م</p>}
      <div className="ra-total">إجمالي التسوية: {formatMoney(receipt.payment.amount)} ج.م</div>
      <footer className="ra-sign"><div>توقيع المستلم: ______________________</div><div>توقيع المحاسب: ______________________</div></footer>
    </div>
  );
}

/** Prints one variant of the receipt through a portal-free approach: the caller renders the document under .receipt-print-root. */
export function printReceipt(variant: ReceiptVariant) {
  const style = document.createElement("style");
  style.id = "receipt-page-style";
  style.textContent = variant === "thermal" ? "@page{size:80mm auto;margin:3mm}" : "@page{size:A4;margin:14mm}";
  document.head.appendChild(style);
  document.body.classList.add("printing-receipt");
  const cleanup = () => {
    document.body.classList.remove("printing-receipt");
    style.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}
