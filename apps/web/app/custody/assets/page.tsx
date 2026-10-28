"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "../../../lib/api";
import { Sidebar, usePermissions } from "../../../components/sidebar";
import { SearchableSelect } from "../../../components/searchable-select";
import { formatMoney, formatQuantity } from "../../../lib/format";

type Employee = { id: string; code: string; full_name: string };
type Custody = { id: string; code: string; employee_id: string; employee_name: string; employee_code: string; custody_type: string; description: string; quantity: number; unit_value: number; total_value: number; due_date: string | null; status: string; returned_quantity: number; lost_quantity: number; remaining_quantity: number; transfer_count: number; notes: string | null };
type Settlement = { id: string; returned_quantity: number; lost_quantity: number; damage_value: number; shortage_value: number; status: string; notes: string | null; settled_at: string; settled_by_username: string | null };
const num = (v: string) => Number(v.replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[٬،]/g, "").replace(/٫/g, ".") || 0);
const labels: Record<string, string> = { ACTIVE: "مفتوحة", PARTIAL_RETURNED: "مرتجع جزئي", RETURNED: "تم الإرجاع", PARTIAL: "تسوية جزئية", FULL: "تمت التسوية", DAMAGED: "تلف", LOST: "فقد", CANCELLED: "ملغاة" };

export default function AssetCustodyPage() {
  const { has, permissions } = usePermissions();
  const [items, setItems] = useState<Custody[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [selected, setSelected] = useState<Custody | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [custodyType, setCustodyType] = useState("أداة تشغيل");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitValue, setUnitValue] = useState("0");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [returned, setReturned] = useState("");
  const [lost, setLost] = useState("0");
  const [damage, setDamage] = useState("0");
  const [shortage, setShortage] = useState("0");
  const [settlementNotes, setSettlementNotes] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [transferNotes, setTransferNotes] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("OPEN");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const canView = has("custody.view") || has("custody.view_own");
  const canCreate = has("custody.create");
  const canSettle = has("custody.settle");
  const canTransfer = has("custody.transfer");

  const load = useCallback(async () => {
    if (!canView) { setLoading(false); return; }
    setLoading(true); setError("");
    try { setItems((await api<{data: Custody[]}>("/api/custodies")).data); }
    catch (e) { setError(e instanceof Error ? e.message : "تعذر تحميل العهد العينية"); }
    finally { setLoading(false); }
  }, [canView]);

  useEffect(() => { if (permissions !== null) void load(); }, [permissions, load]);
  useEffect(() => {
    if (!permissions?.some(p => ["custody.create", "custody.create_own", "custody.view", "custody.view_own", "custody.transfer"].includes(p))) return;
    let active = true;
    api<{data: Employee[]}>("/api/custodies/eligible-employees").then(r => {
      if (active) { setEmployees(r.data); setEmployeeId(v => v && r.data.some(x => x.id === v) ? v : (r.data[0]?.id || "")); }
    }).catch(e => { if (active) setError(e instanceof Error ? e.message : "تعذر تحميل الموظفين"); });
    return () => { active = false; };
  }, [permissions]);

  async function openDetails(item: Custody) {
    setSelected(item); setReturned(String(item.remaining_quantity)); setLost("0"); setDamage("0"); setShortage("0"); setSettlementNotes(""); setTransferTo(""); setTransferNotes(""); setError(""); setMessage("");
    try { setSettlements((await api<{data: Settlement[]}>("/api/custodies/" + encodeURIComponent(item.id) + "/settlements")).data); }
    catch (e) { setSettlements([]); setError(e instanceof Error ? e.message : "تعذر تحميل سجل التسويات"); }
  }

  async function createCustody(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError(""); setMessage("");
    try {
      await api("/api/custodies", { method: "POST", body: JSON.stringify({ employeeId, custodyType: custodyType.trim(), description: description.trim(), quantity: num(quantity), unitValue: num(unitValue), dueDate: dueDate || null, notes: notes.trim() || null }) });
      setDescription(""); setQuantity("1"); setUnitValue("0"); setDueDate(""); setNotes("");
      setMessage("تم تسجيل العهدة العينية وربطها بالموظف."); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر تسجيل العهدة"); }
    finally { setSaving(false); }
  }

  async function settleCustody(e: FormEvent) {
    e.preventDefault(); if (!selected) return;
    setSaving(true); setError(""); setMessage("");
    try {
      await api("/api/custodies/" + encodeURIComponent(selected.id) + "/settlements", { method: "POST", body: JSON.stringify({ returnedQuantity: num(returned), lostQuantity: num(lost), damageValue: num(damage), shortageValue: num(shortage), notes: settlementNotes.trim() || null }) });
      setMessage("تم حفظ التسوية. قيمة التلف والعجز لا تخصم تلقائيًا من مرتب العامل ولا تغيّر رصيد العهدة النقدية.");
      await load();
      const refreshed = (await api<{data: Custody[]}>("/api/custodies")).data.find(x => x.id === selected.id);
      if (refreshed) await openDetails(refreshed); else setSelected(null);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ التسوية"); }
    finally { setSaving(false); }
  }

  async function transferCustody(e: FormEvent) {
    e.preventDefault(); if (!selected) return;
    setSaving(true); setError(""); setMessage("");
    try {
      await api("/api/custodies/" + encodeURIComponent(selected.id) + "/transfer", { method: "POST", body: JSON.stringify({ toEmployeeId: transferTo, notes: transferNotes.trim() || null }) });
      setMessage("تم تحويل العهدة وتسجيل الحركة في سجل التدقيق."); await load();
      const refreshed = (await api<{data: Custody[]}>("/api/custodies")).data.find(x => x.id === selected.id);
      if (refreshed) await openDetails(refreshed); else setSelected(null);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر تحويل العهدة"); }
    finally { setSaving(false); }
  }

  const filtered = items.filter(x => {
    const q = search.trim().toLocaleLowerCase("ar-EG");
    const match = !q || [x.code, x.employee_name, x.employee_code, x.description, x.custody_type].join(" ").toLocaleLowerCase("ar-EG").includes(q);
    const open = ["ACTIVE", "PARTIAL_RETURNED"].includes(x.status) && Number(x.remaining_quantity) > 0;
    return match && (filter === "ALL" || (filter === "OPEN" ? open : !open));
  });
  const openCount = items.filter(x => ["ACTIVE", "PARTIAL_RETURNED"].includes(x.status) && Number(x.remaining_quantity) > 0).length;
  const remainingValue = items.reduce((sum, x) => sum + Math.max(0, Number(x.remaining_quantity)) * Number(x.unit_value || 0), 0);

  return <div className="app-shell"><Sidebar active="/custody/assets"/><main className="main">
    <header className="topbar"><div><h1 className="page-title">العهد العينية وتسويتها</h1><p className="page-subtitle">تسجيل الأدوات والمعدات المسلّمة للعامل ومتابعة المرتجع والفقد والتلف والتحويلات. هذه الشاشة منفصلة عن رصيد العهدة النقدية وعن مستحقات العامل.</p></div>
      <div className="form-actions"><Link className="secondary-btn" href="/custody">العهدة النقدية</Link><Link className="secondary-btn" href="/payments">القبض ومستحقات العمال</Link><Link className="secondary-btn" href="/finance/review">مراجعة الحالات المالية</Link><Link className="secondary-btn" href="/accounting">المالية</Link></div>
    </header>
    <section className="content">
      {error && <div role="alert" className="alert error">{error}</div>}{message && <div role="status" className="success-box">{message}</div>}
      {!canView && <section className="card"><h2 className="card-title">لا توجد صلاحية</h2><p>تحتاج إلى صلاحية عرض العهد العينية.</p></section>}
      {canView && <>
        <div className="stats"><article className="card stat"><div className="stat-label">عهد مفتوحة</div><div className="stat-value">{formatQuantity(openCount, 0)}</div></article><article className="card stat"><div className="stat-label">القيمة التقديرية للمتبقي</div><div className="stat-value">{formatMoney(remainingValue)}</div><div className="stat-note">قيمة مرجعية وليست خصمًا ماليًا</div></article></div>
        {canCreate && <section className="card"><div className="card-header"><div><h2 className="card-title">تسجيل عهدة عينية جديدة</h2><p className="form-hint">لكل عهدة كود مستقل وسجل تسويات؛ لا ينشأ قيد نقدي أو خصم راتب تلقائيًا.</p></div></div>
          <form className="form-grid" onSubmit={createCustody} style={{padding:16}}>
            <label>الموظف<SearchableSelect value={employeeId} onChange={setEmployeeId} options={employees.map(x => ({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف"/></label>
            <label>نوع العهدة<input value={custodyType} onChange={e => setCustodyType(e.target.value)} required minLength={2} maxLength={80}/></label>
            <label style={{gridColumn:"1/-1"}}>وصف العهدة<input value={description} onChange={e => setDescription(e.target.value)} placeholder="مثال: جهاز قياس، عدة صيانة، أداة تشغيل" required minLength={2} maxLength={500}/></label>
            <label>الكمية<input type="number" min="0.001" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} required/></label><label>قيمة الوحدة التقديرية (ج.م)<input type="number" min="0" step="0.01" value={unitValue} onChange={e => setUnitValue(e.target.value)} required/></label><label>موعد الاستحقاق<input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}/></label>
            <label style={{gridColumn:"1/-1"}}>ملاحظات<input value={notes} onChange={e => setNotes(e.target.value)}/></label><div className="form-actions"><button className="primary-button" disabled={saving || !employeeId || !description.trim() || num(quantity) <= 0 || num(unitValue) < 0}>{saving ? "جارٍ الحفظ…" : "تسجيل العهدة"}</button></div>
          </form></section>}
        <section className="card"><div className="card-header"><div><h2 className="card-title">سجل العهد العينية</h2><p className="form-hint">اختار أي عهدة لعرض سجل المرتجعات والتسويات والتحويلات.</p></div><button type="button" className="secondary-btn" onClick={() => void load()} disabled={loading}>{loading ? "جارٍ التحديث…" : "تحديث"}</button></div>
          <div className="form-grid" style={{padding:"0 16px 16px"}}><label>بحث<input value={search} onChange={e => setSearch(e.target.value)} placeholder="كود العهدة، الموظف، الوصف…"/></label><label>الحالة<select value={filter} onChange={e => setFilter(e.target.value)}><option value="OPEN">العهد المفتوحة فقط</option><option value="CLOSED">المغلقة أو المسوّاة</option><option value="ALL">كل العهد</option></select></label></div>
          {loading ? <p className="form-hint" style={{padding:16}}>جارٍ تحميل العهد…</p> : <div className="table-wrap"><table><thead><tr><th>الكود</th><th>الموظف</th><th>العهدة</th><th>الكمية الأصلية</th><th>مرتجع</th><th>مفقود</th><th>متبقي</th><th>القيمة التقديرية</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>
            {filtered.map(x => <tr key={x.id}><td className="mono">{x.code}</td><td>{x.employee_name}<div className="form-hint">{x.employee_code}</div></td><td>{x.description}<div className="form-hint">{x.custody_type}</div></td><td>{formatQuantity(Number(x.quantity))}</td><td>{formatQuantity(Number(x.returned_quantity))}</td><td>{formatQuantity(Number(x.lost_quantity))}</td><td>{formatQuantity(Number(x.remaining_quantity))}</td><td>{formatMoney(Math.max(0, Number(x.remaining_quantity)) * Number(x.unit_value || 0))}</td><td>{labels[x.status] || x.status}</td><td><button type="button" className="secondary-btn" onClick={() => void openDetails(x)}>التفاصيل والتسوية</button></td></tr>)}
            {!filtered.length && <tr><td colSpan={10}>لا توجد عهد مطابقة للبحث.</td></tr>}
          </tbody></table></div>}
        </section>
        {selected && <section className="card"><div className="card-header"><div><h2 className="card-title">تفاصيل العهدة: {selected.code}</h2><p className="form-hint">{selected.description} — المسؤول الحالي: {selected.employee_name} — المتبقي: {formatQuantity(Number(selected.remaining_quantity))}</p></div><button type="button" className="secondary-btn" onClick={() => setSelected(null)}>إغلاق التفاصيل</button></div>
          <div className="card-body">
            {canSettle && Number(selected.remaining_quantity) > 0 && !["RETURNED", "CANCELLED", "DAMAGED", "LOST"].includes(selected.status) && <form className="form-grid" onSubmit={settleCustody}><h3 className="card-title" style={{gridColumn:"1/-1"}}>تسوية / مرتجع</h3>
              <label>كمية مرتجعة<input type="number" min="0" step="any" value={returned} onChange={e => setReturned(e.target.value)} required/></label><label>كمية مفقودة<input type="number" min="0" step="any" value={lost} onChange={e => setLost(e.target.value)} required/></label><label>قيمة التلف (ج.م)<input type="number" min="0" step="0.01" value={damage} onChange={e => setDamage(e.target.value)} required/></label><label>قيمة العجز (ج.م)<input type="number" min="0" step="0.01" value={shortage} onChange={e => setShortage(e.target.value)} required/></label><label style={{gridColumn:"1/-1"}}>ملاحظات التسوية<input value={settlementNotes} onChange={e => setSettlementNotes(e.target.value)}/></label>
              <div className="form-actions"><button className="primary-button" disabled={saving || num(returned) < 0 || num(lost) < 0 || num(returned) + num(lost) <= 0 || num(returned) + num(lost) > Number(selected.remaining_quantity) + 1e-9}>{saving ? "جارٍ الحفظ…" : "حفظ التسوية"}</button></div><p className="form-hint" style={{gridColumn:"1/-1"}}>لازم تسجل كمية مرتجعة أو مفقودة. لو تقرر خصم قيمة من العامل، سجّل الخصم بشكل مستقل من مسير المرتبات بعد المراجعة.</p>
            </form>}
            {canTransfer && Number(selected.remaining_quantity) > 0 && <form className="form-grid" onSubmit={transferCustody} style={{borderTop:"1px solid var(--border)",paddingTop:16,marginTop:16}}><h3 className="card-title" style={{gridColumn:"1/-1"}}>تحويل العهدة لموظف آخر</h3>
              <label>الموظف المستلم<SearchableSelect value={transferTo} onChange={setTransferTo} options={employees.filter(x => x.id !== selected.employee_id).map(x => ({value:x.id,label:x.full_name,meta:x.code}))} placeholder="اختر الموظف المستلم"/></label><label>ملاحظات<input value={transferNotes} onChange={e => setTransferNotes(e.target.value)}/></label><div className="form-actions"><button className="secondary-btn" disabled={saving || !transferTo || transferTo === selected.employee_id}>{saving ? "جارٍ التحويل…" : "تحويل العهدة"}</button></div>
            </form>}
            <h3 className="card-title" style={{marginTop:20}}>سجل التسويات</h3><div className="table-wrap"><table><thead><tr><th>التاريخ</th><th>مرتجع</th><th>مفقود</th><th>قيمة التلف</th><th>قيمة العجز</th><th>الحالة</th><th>سجل بواسطة</th><th>ملاحظات</th></tr></thead><tbody>
              {settlements.map(x => <tr key={x.id}><td>{new Date(x.settled_at).toLocaleString("ar-EG")}</td><td>{formatQuantity(Number(x.returned_quantity))}</td><td>{formatQuantity(Number(x.lost_quantity))}</td><td>{formatMoney(Number(x.damage_value))}</td><td>{formatMoney(Number(x.shortage_value))}</td><td>{labels[x.status] || x.status}</td><td>{x.settled_by_username || "—"}</td><td>{x.notes || "—"}</td></tr>)}
              {!settlements.length && <tr><td colSpan={8}>لا توجد تسويات مسجلة.</td></tr>}
            </tbody></table></div>
          </div></section>}
      </>}
    </section>
  </main></div>;
}
