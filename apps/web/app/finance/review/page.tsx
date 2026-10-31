"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";
import { Sidebar, usePermissions } from "../../../components/sidebar";
import { SearchableSelect } from "../../../components/searchable-select";
import { formatMoney } from "../../../lib/format";

type Payment = {
  payment_id: string;
  gross_amount: number;
  expected_production_amount: number;
  created_at: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  order_id: string | null;
  order_stage_id: string | null;
  order_code: string | null;
  order_name: string | null;
  order_stage_name?: string | null;
  production_allocated: number;
  production_allocation_count: number;
};
type Order = { id: string; code: string; order_name: string; status: string };
type Stage = { id: string; sequence_no: number; stage_name: string; status: string };
type FinancialIntegrity = {
  checkedAt: string;
  counts: {
    missingPayrollExpenses: number;
    missingAdjustmentLedgerEntries: number;
    cashPaymentsMissingCustodyOut: number;
    payrollPaymentMismatches: number;
    expensesMissingCustodyLink: number;
  };
  issues: {
    missingPayrollExpenses: Array<{ payroll_item_id: string; full_name: string; period_month: string; net_amount: number | string; expense_amount: number | string | null; category: string | null }>;
    missingAdjustmentLedgerEntries: Array<{ adjustment_line_id: string; full_name: string; period_month: string; line_type: string; description: string; amount: number | string }>;
    cashPaymentsMissingCustodyOut: Array<{ payment_id: string; full_name: string; period_month: string; payment_date: string; amount: number | string; reference: string | null }>;
    payrollPaymentMismatches: Array<{ payroll_item_id: string; full_name: string; period_month: string; status: string; net_amount: number | string; paid_amount: number | string }>;
    expensesMissingCustodyLink: Array<{ expense_id: string; description: string; amount: number | string; expense_date: string; employee_name: string | null }>;
  };
};

const money = (v: number) => formatMoney(Number(v || 0));

export default function FinanceExceptionsPage() {
  const { has } = usePermissions();
  const allowed = has("worker_payments.pay");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [stageId, setStageId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconciliationSkipped, setReconciliationSkipped] = useState<Array<{paymentId:string;employeeName:string;amount:number;reason:string}>>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canViewIntegrity = has("finance.expenses.view");
  const [integrity, setIntegrity] = useState<FinancialIntegrity | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [integrityError, setIntegrityError] = useState("");

  const selected = useMemo(() => payments.find(p => p.payment_id === selectedId) ?? null, [payments, selectedId]);
  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("ar-EG");
    if (!q) return payments;
    return payments.filter(p => [p.employee_name, p.employee_code, p.order_name ?? "", p.order_code ?? "", p.payment_id]
      .join(" ").toLocaleLowerCase("ar-EG").includes(q));
  }, [payments, search]);
  const totalUnallocated = useMemo(() => payments.reduce((s, p) => s + Math.max(0, Number(p.expected_production_amount ?? p.gross_amount) - Number(p.production_allocated)), 0), [payments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, o] = await Promise.all([
        api<{ data: Payment[] }>("/api/worker-payments/historical-unallocated"),
        api<{ data: Order[] }>("/api/worker-payments/historical-allocation-orders")
      ]);
      setPayments(p.data);
      setOrders(o.data.filter(x => x.status !== "CANCELLED"));
      setSelectedId(current => p.data.some(x => x.payment_id === current) ? current : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل الحالات المالية");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) void load(); else setLoading(false); }, [allowed, load]);
  const loadIntegrity = useCallback(async () => {
    if (!canViewIntegrity) return;
    setIntegrityLoading(true);
    setIntegrityError("");
    try {
      const result = await api<{ data: FinancialIntegrity }>("/api/accounting/reconciliation/overview");
      setIntegrity(result.data);
    } catch (e) {
      setIntegrityError(e instanceof Error ? e.message : "تعذر فحص الترابط المالي");
    } finally {
      setIntegrityLoading(false);
    }
  }, [canViewIntegrity]);

  useEffect(() => { if (canViewIntegrity) void loadIntegrity(); }, [canViewIntegrity, loadIntegrity]);

  const integrityGroups = useMemo(() => {
    if (!integrity) return [];
    const issues = integrity.issues;
    return [
      { title: "مسيرات بلا قيد مصروف مطابق", items: issues.missingPayrollExpenses.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · صافي ${money(Number(x.net_amount))} ج.م`) },
      { title: "تعديلات رواتب بلا قيد في دفتر المستحقات", items: issues.missingAdjustmentLedgerEntries.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · ${x.description} · ${money(Number(x.amount))} ج.م`) },
      { title: "مدفوعات نقدية بلا حركة عهدة مقابلة", items: issues.cashPaymentsMissingCustodyOut.map(x => `${x.full_name} · ${x.payment_date.slice(0, 10)} · ${money(Number(x.amount))} ج.م`) },
      { title: "عدم تطابق حالة الراتب مع المدفوع", items: issues.payrollPaymentMismatches.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · الحالة ${x.status} · المدفوع ${money(Number(x.paid_amount))} من ${money(Number(x.net_amount))} ج.م`) },
      { title: "مصروفات مرتبطة بعهدة دون حركة مطابقة", items: issues.expensesMissingCustodyLink.map(x => `${x.employee_name || "موظف غير محدد"} · ${x.expense_date.slice(0, 10)} · ${x.description} · ${money(Number(x.amount))} ج.م`) }
    ];
  }, [integrity]);

  async function reconcileHistorical() {
    if (reconciling) return;
    setReconciling(true);
    setError("");
    setSuccess("");
    try {
      const result = await api<{data:{reconciledCount:number;skippedCount:number;unresolvedCount:number;unresolvedAmount:number;skipped:Array<{paymentId:string;employeeName:string;amount:number;reason:string}>}}>
        ("/api/worker-payments/reconcile-historical-allocations", {method:"POST",body:JSON.stringify({})});
      const summary = result.data;
      setReconciliationSkipped(summary.skipped ?? []);
      setSuccess(
        `تم ربط ${summary.reconciledCount} دفعة قديمة بسجلات الإنتاج المؤكدة، من غير إنشاء أي دفعة أو حركة عهدة جديدة. ` +
        `دفعات قديمة ما زالت بلا توزيع إنتاج مؤكد: ${summary.unresolvedCount} بإجمالي ${money(summary.unresolvedAmount)}. ` +
        (summary.skippedCount ? `تم تجاوز ${summary.skippedCount} حالة غير مؤكدة؛ راجع القائمة لتوزيعها يدويًا.` : "")
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذرت مزامنة الدفعات التاريخية");
    } finally {
      setReconciling(false);
    }
  }

  useEffect(() => {
    if (!orderId) { setStages([]); setStageId(""); return; }
    let active = true;
    api<{ data: Stage[] }>("/api/worker-payments/historical-allocation-stages?orderId=" + encodeURIComponent(orderId))
      .then(r => { if (active) setStages(r.data); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "تعذر تحميل مراحل الطلبية"); });
    return () => { active = false; };
  }, [orderId]);

  function choosePayment(id: string) {
    setSelectedId(id);
    const p = payments.find(x => x.payment_id === id);
    setOrderId(p?.order_id ?? "");
    setStageId(p?.order_stage_id ?? "");
    setError("");
    setSuccess("");
  }

  async function allocate() {
    if (!selected) return;
    if (!orderId) { setError("اختار الطلبية اللي تخصها الدفعة."); return; }
    if (selected.order_id && orderId !== selected.order_id) { setError("الدفعة مرتبطة بطلبية محددة بالفعل؛ لازم تفضل على نفس الطلبية."); return; }
    const effectiveStageId = selected.order_stage_id ?? stageId;
    setSaving(true); setError(""); setSuccess("");
    try {
      await api("/api/worker-payments/" + encodeURIComponent(selected.payment_id) + "/allocate-historical", {
        method: "POST",
        body: JSON.stringify({ orderId, ...(effectiveStageId ? { orderStageId: effectiveStageId } : {}) })
      });
      setSuccess("تم ربط الدفعة القديمة بالطلبية والمرحلة المحددتين. لم يتم إنشاء دفعة نقدية جديدة.");
      setSelectedId(""); setOrderId(""); setStageId(""); setStages([]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر توزيع الدفعة؛ لم يتم اعتماد التغيير.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="app-shell">
    <Sidebar active="/finance/review" />
    <main className="main">
      <header className="topbar">
        <div><h1 className="page-title">مراجعة الحالات المالية</h1><p className="page-subtitle">هذه الشاشة مخصصة لربط الدفعات القديمة بسجلات الإنتاج والطلبيات فقط. لا تنشئ صرفًا جديدًا، ولا تغيّر رصيد العهدة أو خصومات المرتب. تسجيل صرف العامل من صفحة القبض، الخصم اليدوي من مسير المرتبات، والمصروفات أو الإهلاك من المالية. تتم مراجعة جزء الإنتاج فقط، دون البونص أو التسويات الإضافية داخل الدفعة.</p></div>
        <div className="form-actions">
          <Link className="secondary-btn" href="/payments">القبض ومستحقات العمال</Link>
          {has("payroll.view") && <Link className="secondary-btn" href="/payroll">المرتبات والخصومات</Link>}
          {(has("finance.expenses.view") || has("finance.expenses.create")) && <Link className="secondary-btn" href="/accounting">المصروفات والمالية</Link>}
          <Link className="secondary-btn" href="/custody">العهدة النقدية</Link><Link className="secondary-btn" href="/custody/assets">العهد العينية وتسويتها</Link>
        </div>
      </header>
      <section className="content">
        {error && <div role="alert" className="alert error">{error}</div>}
        {success && <div role="status" className="success-box">{success}</div>}
        {canViewIntegrity && <section className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">مركز سلامة الترابط المالي</h2>
              <p className="form-hint">فحص للقيود والرواتب وحركات العهدة. الفحص للقراءة فقط ولا يعدّل أي رصيد أو سجل تلقائيًا.</p>
              {integrity && <p className="form-hint">آخر فحص: {new Date(integrity.checkedAt).toLocaleString("ar-EG")}</p>}
            </div>
            <button type="button" className="secondary-btn" onClick={() => void loadIntegrity()} disabled={integrityLoading}>
              {integrityLoading ? "جارٍ الفحص…" : "إعادة فحص الترابط"}
            </button>
          </div>
          <div className="card-body">
            {integrityError && <div role="alert" className="alert error">{integrityError}</div>}
            {integrityLoading && !integrity && <p className="form-hint">جارٍ فحص العلاقات المالية بين الأنظمة…</p>}
            {integrity && <>
              <div className="stats">
                <article className="card stat"><div className="stat-label">إجمالي الحالات المكتشفة</div><div className="stat-value">{Object.values(integrity.counts).reduce((sum, count) => sum + count, 0)}</div></article>
                <article className="card stat"><div className="stat-label">أنواع الفحص</div><div className="stat-value">{integrityGroups.length}</div></article>
              </div>
              <div className="production-grid">
                {integrityGroups.map(group => <section className="card" key={group.title}>
                  <div className="card-header"><h3 className="card-title">{group.title}</h3><span className={group.items.length ? "status warning" : "status success"}>{group.items.length}</span></div>
                  <div className="card-body">
                    {!group.items.length ? <p className="form-hint">لا توجد حالات مكتشفة.</p> : <>
                      <ul>{group.items.slice(0, 8).map((item, index) => <li key={index}>{item}</li>)}</ul>
                      {group.items.length > 8 && <p className="form-hint">تم عرض أول 8 حالات من أصل {group.items.length}.</p>}
                    </>}
                  </div>
                </section>)}
              </div>
            </>}
          </div>
        </section>}
        {reconciliationSkipped.length > 0 && <section className="card">
          <div className="card-header"><div><h2 className="card-title">حالات تم تجاوزها وتحتاج مراجعة</h2><p className="form-hint">لم يتم تغيير توزيع هذه الدفعات لأن بياناتها لا تتطابق بشكل آمن.</p></div></div>
          <div className="card-body"><div className="table-wrap"><table><thead><tr><th>العامل</th><th>المبلغ</th><th>سبب المراجعة</th><th>رقم الدفعة</th></tr></thead><tbody>
            {reconciliationSkipped.map(item => <tr key={item.paymentId}><td>{item.employeeName}</td><td>{money(item.amount)}</td><td>{item.reason}</td><td><code>{item.paymentId}</code></td></tr>)}
          </tbody></table></div></div>
        </section>}
        {!allowed && <section className="card"><h2 className="card-title">لا توجد صلاحية</h2><p>تحتاج إلى صلاحية صرف مستحقات العاملين لمراجعة الدفعات التاريخية.</p></section>}
        {allowed && <>
          <div className="stats">
            <article className="card stat"><div className="stat-label">حالات تحتاج مراجعة</div><div className="stat-value">{payments.length}</div><div className="stat-note">دفعات تاريخية غير موزعة بالكامل</div></article>
            <article className="card stat warning"><div className="stat-label">إجمالي المبالغ المتبقية</div><div className="stat-value">{money(totalUnallocated)}</div><div className="stat-note">الجزء المتوقع من مستحقات الإنتاج فقط</div></article>
          </div>
          <section className="card">
            <div className="card-header"><div><h2 className="card-title">قائمة الحالات</h2><p className="form-hint">اختار الحالة لمراجعة تفاصيلها. الحالات المرتبطة محاسبيًا بطلبية أو مرحلة لا يمكن تغيير ربطها المخالف.</p></div><div className="form-actions"><button type="button" className="primary-button" onClick={() => void reconcileHistorical()} disabled={reconciling || loading}>{reconciling ? "جارٍ مزامنة الدفعات…" : "مزامنة المدفوعات القديمة المؤكدة"}</button><button type="button" className="secondary-btn" onClick={() => void load()} disabled={loading || reconciling}>{loading ? "جارٍ التحديث…" : "تحديث القائمة"}</button></div></div>
            <div className="card-body">
              <input aria-label="بحث في الحالات المالية" value={search} onChange={e => setSearch(e.target.value)} placeholder="ابحث باسم العامل أو كوده أو الطلبية…" />
              {loading ? <p className="form-hint">جارٍ تحميل الحالات…</p> : filtered.length === 0 ? <p className="form-hint">مفيش حالات مطابقة للبحث. لو ظهرت رسالة عن دفعة تاريخية خارج القائمة، حدّث البيانات وتأكد من صلاحيات الحساب.</p> :
                <div className="table-wrap"><table><thead><tr><th>العامل</th><th>تاريخ الدفعة</th><th>إجمالي الدفعة</th><th>حصة الإنتاج المتوقعة</th><th>الموزع على الإنتاج</th><th>الطلبية المرتبطة حاليًا</th><th>الإجراء</th></tr></thead><tbody>
                  {filtered.map(p => <tr key={p.payment_id}><td>{p.employee_name}<div className="form-hint">{p.employee_code}</div></td><td>{new Date(p.created_at).toLocaleDateString("ar-EG")}</td><td>{money(Number(p.gross_amount))}</td><td>{money(Number(p.expected_production_amount ?? p.gross_amount))}</td><td>{money(Number(p.production_allocated))}</td><td>{p.order_name ? <>{p.order_name}<div className="form-hint">{p.order_code}</div></> : "غير محددة"}</td><td><button type="button" className="secondary-btn" onClick={() => choosePayment(p.payment_id)}>{selectedId === p.payment_id ? "محدد للمراجعة" : "مراجعة وتوزيع"}</button></td></tr>)}
                </tbody></table></div>}
            </div>
          </section>
          {selected && <section className="card">
            <div className="card-header"><div><h2 className="card-title">مراجعة دفعة {selected.employee_name}</h2><p className="form-hint">إجمالي الدفعة: {money(Number(selected.gross_amount))} · حصة الإنتاج المتوقعة: {money(Number(selected.expected_production_amount ?? selected.gross_amount))} · الموزع حاليًا: {money(Number(selected.production_allocated))} · عدد قيود الإنتاج: {selected.production_allocation_count}</p></div><button type="button" className="secondary-btn" onClick={() => choosePayment("")}>إلغاء التحديد</button></div>
            <div className="card-body"><div className="production-grid">
              <label>الطلبية<SearchableSelect value={orderId} onChange={value => { setOrderId(value); setStageId(""); }} options={orders.map(o => ({value:o.id,label:o.order_name,meta:o.code}))} disabled={Boolean(selected.order_id)} placeholder="اختار الطلبية" searchPlaceholder="ابحث باسم الطلبية أو كودها" /></label>
              <label>المرحلة{selected.order_stage_id ? <input readOnly value={selected.order_stage_name || ("مرحلة مرتبطة بالقيد الأصلي · "+selected.order_stage_id)} /> : " (اختياري)"}{selected.order_stage_id ? null : <SearchableSelect value={stageId} onChange={setStageId} options={stages.map(s => ({value:s.id,label:s.stage_name,meta:"مرحلة " + s.sequence_no}))} disabled={!orderId || stages.length===0} placeholder={!orderId ? "اختار الطلبية أولًا" : stages.length ? "اختار مرحلة لو مطلوبة" : "لا توجد مراحل متاحة"} searchPlaceholder="ابحث في مراحل الطلبية" />}</label>
            </div>
            {selected.order_id && <p className="form-hint">تنبيه: الدفعة مرتبطة بالفعل بطلبية في القيد المحاسبي؛ لازم تفضل على نفس الطلبية.</p>}
            {selected.order_stage_id && <p className="form-hint">تنبيه: الدفعة مرتبطة بمرحلة في القيد المحاسبي؛ لازم تفضل على نفس المرحلة.</p>}
            <div className="form-actions"><button type="button" className="primary-button" onClick={() => void allocate()} disabled={saving || !orderId}>{saving ? "جارٍ الحفظ…" : "تأكيد توزيع الدفعة"}</button></div>
            </div>
          </section>}
        </>}
      </section>
    </main>
  </div>;
}
