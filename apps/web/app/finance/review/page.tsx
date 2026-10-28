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
  production_allocated: number;
  production_allocation_count: number;
};
type Order = { id: string; code: string; order_name: string; status: string };
type Stage = { id: string; sequence_no: number; stage_name: string; status: string };

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
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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
        api<{ data: Order[] }>("/api/orders")
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
    if (selected.order_stage_id && stageId !== selected.order_stage_id) {
      setError("الدفعة مرتبطة بمرحلة محددة بالفعل؛ لازم تختار نفس المرحلة.");
      return;
    }
    setSaving(true); setError(""); setSuccess("");
    try {
      await api("/api/worker-payments/" + encodeURIComponent(selected.payment_id) + "/allocate-historical", {
        method: "POST",
        body: JSON.stringify({ orderId, ...(stageId ? { orderStageId: stageId } : {}) })
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
        <div><h1 className="page-title">مراجعة الحالات المالية</h1><p className="page-subtitle">مركز واحد لمراجعة توزيع الدفعات التاريخية وربطها بالإنتاج والطلبيات. إجمالي المراجعة يحسب جزء الإنتاج فقط، لا أي بونص أو تسوية إضافية داخل الدفعة.</p></div>
        <div className="form-actions">
          <Link className="secondary-btn" href="/payments">القبض ومستحقات العمال</Link>
          <Link className="secondary-btn" href="/finance/worker-settlements">تسويات العهدة</Link>
          <Link className="secondary-btn" href="/custody">حركة العهدة</Link>
        </div>
      </header>
      <section className="content">
        {error && <div role="alert" className="alert error">{error}</div>}
        {success && <div role="status" className="success-box">{success}</div>}
        {!allowed && <section className="card"><h2 className="card-title">لا توجد صلاحية</h2><p>تحتاج إلى صلاحية صرف مستحقات العاملين لمراجعة الدفعات التاريخية.</p></section>}
        {allowed && <>
          <div className="stats">
            <article className="card stat"><div className="stat-label">حالات تحتاج مراجعة</div><div className="stat-value">{payments.length}</div><div className="stat-note">دفعات تاريخية غير موزعة بالكامل</div></article>
            <article className="card stat warning"><div className="stat-label">إجمالي المبالغ المتبقية</div><div className="stat-value">{money(totalUnallocated)}</div><div className="stat-note">الجزء المتوقع من مستحقات الإنتاج فقط</div></article>
          </div>
          <section className="card">
            <div className="card-header"><div><h2 className="card-title">قائمة الحالات</h2><p className="form-hint">اختار الحالة لمراجعة تفاصيلها. الحالات المرتبطة محاسبيًا بطلبية أو مرحلة لا يمكن تغيير ربطها المخالف.</p></div><button type="button" className="secondary-btn" onClick={() => void load()} disabled={loading}>{loading ? "جارٍ التحديث…" : "تحديث القائمة"}</button></div>
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
              <label>الطلبية<SearchableSelect value={orderId} onChange={value => { setOrderId(value); setStageId(""); }} options={orders.map(o => ({value:o.id,label:o.order_name,meta:o.code}))} placeholder="اختار الطلبية" searchPlaceholder="ابحث باسم الطلبية أو كودها" /></label>
              <label>المرحلة (اختياري)<SearchableSelect value={stageId} onChange={setStageId} options={stages.map(s => ({value:s.id,label:s.stage_name,meta:"مرحلة " + s.sequence_no}))} disabled={!orderId || stages.length===0 || Boolean(selected.order_stage_id)} placeholder={!orderId ? "اختار الطلبية أولًا" : selected.order_stage_id ? "المرحلة محددة من القيد الأصلي" : stages.length ? "اختار مرحلة لو مطلوبة" : "لا توجد مراحل متاحة"} searchPlaceholder="ابحث في مراحل الطلبية" /></label>
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
