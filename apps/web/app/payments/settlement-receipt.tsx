"use client";

import { formatMoney } from "../../lib/format";

export type SettlementReceipt = {
  payment: { id: string; code: string; method: string; paidAt: string; notes: string | null; amount: number };
  employee: { id: string; code: string; name: string };
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
  return (
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
        <div className="modal-actions" style={{ padding: 0 }}>
          <button type="button" className="primary-button" onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}
