"use client";

import type { SettlementReceipt } from "./settlement-receipt";
import { stageTotals } from "../../lib/stage-totals.mjs";

export type ReceiptVariant = "a4" | "thermal";

// The receipt uses one digit style everywhere: Western digits, like the payment/production codes it prints.
// Numbers and dates are wrapped in <bdi> so the RTL layout can never flip their order.
const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "2-digit", year: "numeric" });
const fmtNum = (value: number) => numberFmt.format(value);
const fmtDate = (value: string) => dateFmt.format(new Date(value));
const fmtWorkDate = (value: string) => {
  const parts = value.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : value;
};

/** Printable settlement invoice. "a4" is the formal full-page invoice, "thermal" is the narrow 80mm printer receipt. */
export function ReceiptDocument({ receipt, variant, methodLabel }: { receipt: SettlementReceipt; variant: ReceiptVariant; methodLabel?: string }) {
  if (variant === "thermal") {
    return (
      <div className="receipt-doc receipt-thermal" dir="rtl">
        <div className="rt-center rt-title">تذكار</div>
        <div className="rt-center">إيصال تسوية مستحقات</div>
        <div className="rt-line" />
        <div>رقم: <bdi>{receipt.payment.code}</bdi></div>
        <div>التاريخ: <bdi>{fmtDate(receipt.payment.paidAt)}</bdi></div>
        <div>العامل: {receipt.employee.name} (<bdi>{receipt.employee.code}</bdi>)</div>
        <div>الدفع: {methodLabel || receipt.payment.method}</div>
        <div className="rt-line" />
        {receipt.orders.map((order) => (
          <div key={order.orderId ?? "none"} className="rt-block">
            <div className="rt-bold">{order.orderCode ? <><bdi>{order.orderCode}</bdi> - {order.orderName ?? ""}</> : "إنتاج غير مرتبط بطلبية"}</div>
            {order.lines.map((line) => (
              <div key={line.productionId} className="rt-row">
                <span><bdi>{line.productionCode}</bdi>{line.stageName ? ` / ${line.stageName}` : ""}</span>
                <span><bdi>{fmtNum(line.amount)}</bdi></span>
              </div>
            ))}
            <div className="rt-row rt-bold"><span>إجمالي الطلبية</span><span><bdi>{fmtNum(order.total)}</bdi></span></div>
          </div>
        ))}
        {receipt.orders.length > 0 && <>
          <div className="rt-line" />
          <div className="rt-bold">إجمالي كل مرحلة</div>
          {receipt.orders.map((order) => (
            <div key={"st-" + (order.orderId ?? "none")} className="rt-block">
              <div>{order.orderCode ? <bdi>{order.orderCode}</bdi> : "إنتاج غير مرتبط بطلبية"}</div>
              {stageTotals(order.lines).map((st) => <div key={st.key} className="rt-row"><span>{st.label}</span><span><bdi>{fmtNum(st.total)}</bdi></span></div>)}
            </div>
          ))}
        </>}
        {receipt.unallocatedAmount > 0.009 && <div className="rt-row"><span>حساب عام / فروق</span><span><bdi>{fmtNum(receipt.unallocatedAmount)}</bdi></span></div>}
        <div className="rt-line" />
        <div className="rt-row rt-bold rt-total"><span>الإجمالي</span><span><bdi>{fmtNum(receipt.payment.amount)}</bdi> ج.م</span></div>
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
            <tr><th>رقم الفاتورة</th><td><bdi>{receipt.payment.code}</bdi></td></tr>
            <tr><th>تاريخ التسوية</th><td><bdi>{fmtDate(receipt.payment.paidAt)}</bdi></td></tr>
            <tr><th>طريقة الصرف</th><td>{methodLabel || receipt.payment.method}</td></tr>
          </tbody>
        </table>
      </header>
      <section className="ra-party">
        <strong>العامل:</strong> {receipt.employee.name} <span>(<bdi>{receipt.employee.code}</bdi>)</span>
      </section>
      {receipt.orders.length === 0 && <p>لم تُوزّع هذه التسوية على سجلات إنتاج؛ المبلغ مسجل على حساب العامل العام.</p>}
      {receipt.orders.map((order) => (
        <section key={order.orderId ?? "none"} className="ra-order">
          <h2>{order.orderCode ? <><bdi>{order.orderCode}</bdi> — {order.orderName ?? ""}</> : "إنتاج غير مرتبط بطلبية"}</h2>
          <table className="ra-table">
            <thead><tr><th>كود الإنتاج</th><th>التاريخ</th><th>المرحلة</th><th>الكمية</th><th>المبلغ (ج.م)</th></tr></thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.productionId}>
                  <td><bdi>{line.productionCode}</bdi></td>
                  <td><bdi>{fmtWorkDate(line.workDate)}</bdi></td>
                  <td>{line.stageName ? `${line.stageSequence ? line.stageSequence + ". " : ""}${line.stageName}` : "—"}</td>
                  <td>{line.quantity == null ? "—" : <bdi>{fmtNum(line.quantity)}</bdi>}</td>
                  <td><bdi>{fmtNum(line.amount)}</bdi></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th colSpan={4}>إجمالي الطلبية</th><th><bdi>{fmtNum(order.total)}</bdi></th></tr></tfoot>
          </table>
        </section>
      ))}
      {receipt.orders.length > 0 && (
        <section className="ra-order">
          <h2>إجمالي كل مرحلة</h2>
          {receipt.orders.map((order) => (
            <table key={"st-" + (order.orderId ?? "none")} className="ra-table">
              <thead><tr><th colSpan={2}>{order.orderCode ? <><bdi>{order.orderCode}</bdi> — {order.orderName ?? ""}</> : "إنتاج غير مرتبط بطلبية"}</th></tr></thead>
              <tbody>{stageTotals(order.lines).map((st) => <tr key={st.key}><td>{st.label}</td><td><bdi>{fmtNum(st.total)}</bdi></td></tr>)}</tbody>
              <tfoot><tr><th>إجمالي الطلبية</th><th><bdi>{fmtNum(order.total)}</bdi></th></tr></tfoot>
            </table>
          ))}
        </section>
      )}
      {receipt.unallocatedAmount > 0.009 && <p>مبلغ غير موزع على إنتاج (حساب عام / فروق): <bdi>{fmtNum(receipt.unallocatedAmount)}</bdi> ج.م</p>}
      <div className="ra-total">إجمالي التسوية: <bdi>{fmtNum(receipt.payment.amount)}</bdi> ج.م</div>
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
