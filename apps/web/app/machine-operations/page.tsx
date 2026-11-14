"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { formatQuantity } from "../../lib/format";

type Machine = { id: string; code: string; name: string; machine_type?: string | null };
type Item = { id: string; code: string; name: string; full_name?: string; is_active?: boolean };
type CompatibleDesign = { design_version_id: string; design_code: string; design_name: string; version_no: number; material_type: string; material_thickness_mm: string | number | null; pieces_per_cycle: number; standard_cycle_seconds: string | number | null };
type Target = { id: string; machine_id: string; design_version_id: string | null; shift_id: string | null; period_type: "DAY" | "MONTH" | "SHIFT"; effective_from: string; effective_to: string; target_quantity: string | number; target_cycles: number | null; notes?: string | null; is_active: boolean; machine_code: string; machine_name: string; design_code?: string | null; design_name?: string | null; version_no?: number | null; shift_name?: string | null };
type MachineSession = { machine_id: string; machine_code: string; machine_name: string; machine_type?: string | null; session_id: string | null; session_status: string | null; started_at: string | null; ended_at: string | null; session_notes?: string | null; design_code?: string | null; design_name?: string | null; version_no?: number | null; material_type?: string | null; material_thickness_mm?: string | number | null; operator_name?: string | null; shift_name?: string | null; target_quantity?: string | number | null; target_cycles?: number | null; achieved_quantity: string | number; scrap_quantity: string | number; achieved_cycles: string | number; remaining_quantity: string | number | null; downtime_id: string | null; downtime_reason?: string | null; downtime_started_at?: string | null; last_session_started_at?: string | null; last_session_status?: string | null };

const localDateKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
const dateTime = (value?: string | null) => value ? new Date(value).toLocaleString("ar-EG") : "—";

export default function MachineOperationsPage() {
  const { has } = usePermissions();
  const [machines, setMachines] = useState<Machine[]>([]);
  const [employees, setEmployees] = useState<Item[]>([]);
  const [shifts, setShifts] = useState<Item[]>([]);
  const [targetCompatible, setTargetCompatible] = useState<CompatibleDesign[]>([]);
  const [compatible, setCompatible] = useState<CompatibleDesign[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [sessions, setSessions] = useState<MachineSession[]>([]);
  const [machineId, setMachineId] = useState("");
  const [designVersionId, setDesignVersionId] = useState("");
  const [operatorId, setOperatorId] = useState("");
  const [shiftId, setShiftId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [sessionNotes, setSessionNotes] = useState("");
  const [targetMachineId, setTargetMachineId] = useState("");
  const [targetDesignVersionId, setTargetDesignVersionId] = useState("");
  const [targetShiftId, setTargetShiftId] = useState("");
  const [targetPeriodType, setTargetPeriodType] = useState<"DAY" | "MONTH" | "SHIFT">("DAY");
  const [targetDate, setTargetDate] = useState(localDateKey());
  const [targetQuantity, setTargetQuantity] = useState("");
  const [targetCycles, setTargetCycles] = useState("");
  const [targetNotes, setTargetNotes] = useState("");
  const [downtimeTarget, setDowntimeTarget] = useState<MachineSession | null>(null);
  const [downtimeReason, setDowntimeReason] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState("");

  async function load() {
    try {
      const [m,e,s,t,live] = await Promise.all([
        api<{data:Machine[]}>("/api/machines"),
        api<{data:Item[]}>("/api/employees"),
        api<{data:Item[]}>("/api/shifts"),
        api<{data:Target[]}>("/api/laser-machine-targets"),
        api<{data:MachineSession[]}>("/api/laser-machine-sessions")
      ]);
      setMachines(m.data); setEmployees(e.data); setShifts(s.data); setTargets(t.data); setSessions(live.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل متابعة تشغيل الماكينات");
    }
  }

  useEffect(() => {
    void load();
    const interval = setInterval(() => { void load(); }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!machineId && machines[0]) { setMachineId(machines[0].id); setTargetMachineId(machines[0].id); }
  }, [machines, machineId]);

  useEffect(() => {
    let alive = true;
    setDesignVersionId(""); setTargetDesignVersionId("");
    if (!machineId) { setCompatible([]); return () => { alive = false; }; }
    api<{data:CompatibleDesign[]}>(`/api/machines/${machineId}/laser-designs`)
      .then(r => { if (alive) setCompatible(r.data); })
      .catch(e => { if (alive) { setCompatible([]); setError(e instanceof Error ? e.message : "تعذر تحميل التصميمات المتوافقة"); } });
    return () => { alive = false; };
  }, [machineId]);

  useEffect(() => {
    let alive = true;
    setTargetDesignVersionId("");
    if (!targetMachineId) { setTargetCompatible([]); return () => { alive = false; }; }
    api<{data:CompatibleDesign[]}>(`/api/machines/${targetMachineId}/laser-designs`)
      .then(r => { if (alive) setTargetCompatible(r.data); })
      .catch(() => { if (alive) setTargetCompatible([]); });
    return () => { alive = false; };
  }, [targetMachineId]);

  async function startSession(e: FormEvent) {
    e.preventDefault(); setSaving("start"); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-sessions", { method: "POST", body: JSON.stringify({
        machineId, designVersionId, operatorEmployeeId: operatorId || null,
        shiftId: shiftId || null, targetId: targetId || null, notes: sessionNotes.trim() || null
      }) });
      setNotice("تم بدء جلسة التشغيل اليدوية. الحالة تعكس آخر تسجيل في النظام وليست قراءة مباشرة من الماكينة.");
      setSessionNotes(""); setTargetId("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر بدء جلسة التشغيل"); }
    finally { setSaving(""); }
  }

  async function stopSession(session: MachineSession) {
    if (!session.session_id || !window.confirm("إنهاء جلسة تشغيل " + session.machine_name + "؟")) return;
    setSaving("stop:" + session.session_id); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-sessions/" + session.session_id + "/stop", { method: "POST", body: JSON.stringify({}) });
      setNotice("تم إنهاء جلسة التشغيل وحفظ وقت النهاية.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إنهاء جلسة التشغيل"); }
    finally { setSaving(""); }
  }

  async function startDowntime(e: FormEvent) {
    e.preventDefault();
    if (!downtimeTarget) return;
    setSaving("downtime"); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-downtime", { method: "POST", body: JSON.stringify({ machineId: downtimeTarget.machine_id, reason: downtimeReason.trim() }) });
      setNotice("تم تسجيل توقف الماكينة.");
      setDowntimeTarget(null); setDowntimeReason("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر تسجيل التوقف"); }
    finally { setSaving(""); }
  }

  async function endDowntime(session: MachineSession) {
    if (!session.downtime_id) return;
    setSaving("end-downtime:" + session.downtime_id); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-downtime/" + session.downtime_id + "/end", { method: "PATCH" });
      setNotice("تم إنهاء التوقف واستئناف تسجيل حالة التشغيل.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إنهاء التوقف"); }
    finally { setSaving(""); }
  }

  async function createTarget(e: FormEvent) {
    e.preventDefault(); setSaving("target"); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-targets", { method: "POST", body: JSON.stringify({
        machineId: targetMachineId, designVersionId: targetDesignVersionId || null,
        shiftId: targetPeriodType === "SHIFT" ? targetShiftId || null : null,
        periodType: targetPeriodType, date: targetDate, targetQuantity: Number(targetQuantity),
        targetCycles: targetCycles ? Number(targetCycles) : null, notes: targetNotes.trim() || null
      }) });
      setNotice("تم حفظ مستهدف الإنتاج. تغيير المستهدف لا يغيّر الفترات التاريخية.");
      setTargetQuantity(""); setTargetCycles(""); setTargetNotes("");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ مستهدف الإنتاج"); }
    finally { setSaving(""); }
  }

  async function deactivateTarget(target: Target) {
    if (!window.confirm("إيقاف مستهدف " + target.machine_name + "؟ سيظل محفوظًا في السجل.")) return;
    setSaving("target:" + target.id); setError(""); setNotice("");
    try {
      await api("/api/laser-machine-targets/" + target.id + "/deactivate", { method: "PATCH" });
      setNotice("تم إيقاف المستهدف مع الاحتفاظ بسجله.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر إيقاف المستهدف"); }
    finally { setSaving(""); }
  }

  const eligibleTargets = targets.filter(t => t.is_active && t.machine_id === machineId &&
    (!t.design_version_id || t.design_version_id === designVersionId) &&
    (!t.shift_id || t.shift_id === shiftId) && t.effective_from.slice(0,10) <= localDateKey() && t.effective_to.slice(0,10) >= localDateKey());
  const labelVersion = (v: {design_code:string;design_name:string;version_no:number;material_type:string}) => v.design_code + " — " + v.design_name + " · V" + v.version_no + " · " + v.material_type;

  return <div className="app-shell">
    <Sidebar active="/machine-operations" />
    <main className="main">
      <header className="topbar"><div><h1 className="page-title">متابعة تشغيل الماكينات</h1><p className="page-subtitle">الحالة مبنية على بدء التشغيل والتوقف اليدويين داخل النظام، ولا تمثل اتصالًا مباشرًا بوحدة تحكم الماكينة. تتحدث الشاشة تلقائيًا كل 30 ثانية.</p></div><button type="button" className="secondary-btn" onClick={() => void load()}>تحديث الآن</button></header>
      <section className="content">
        {error && <div className="alert error" role="alert">{error}</div>}
        {notice && <div className="alert success" role="status">{notice}</div>}

        {has("machine_production.sessions.manage") && <form className="card form-card" onSubmit={startSession}>
          <div className="card-header"><h2 className="card-title">بدء جلسة تشغيل</h2></div>
          <div className="form-grid">
            <label>الماكينة<select value={machineId} onChange={e => setMachineId(e.target.value)} required><option value="">اختر الماكينة</option>{machines.map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}</select></label>
            <label>التصميم المتوافق<select value={designVersionId} onChange={e => setDesignVersionId(e.target.value)} required><option value="">اختر إصدار التصميم</option>{compatible.map(v => <option key={v.design_version_id} value={v.design_version_id}>{v.design_code} — {v.design_name} · V{v.version_no} · {v.material_type}</option>)}</select><span className="form-hint">{compatible.length ? "تظهر الإصدارات النشطة والمتوافقة مع الماكينة المختارة فقط." : "لا توجد إصدارات متوافقة نشطة؛ راجع مكتبة تصميمات الليزر."}</span></label>
            <label>المشغل الأساسي<select value={operatorId} onChange={e => setOperatorId(e.target.value)}><option value="">غير محدد</option>{employees.filter(e => e.is_active !== false).map(e => <option key={e.id} value={e.id}>{e.full_name || e.name} ({e.code})</option>)}</select></label>
            <label>الوردية<select value={shiftId} onChange={e => setShiftId(e.target.value)}><option value="">غير محددة</option>{shifts.filter(s => s.is_active !== false).map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}</select></label>
            <label>المستهدف المطبق<select value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">بدون مستهدف</option>{eligibleTargets.map(t => <option key={t.id} value={t.id}>{t.period_type === "DAY" ? "يومي" : t.period_type === "MONTH" ? "شهري" : "وردية"} · {formatQuantity(t.target_quantity,0)} قطعة</option>)}</select></label>
            <label style={{gridColumn:"1 / -1"}}>ملاحظات بدء التشغيل<input value={sessionNotes} onChange={e => setSessionNotes(e.target.value)} maxLength={1000} /></label>
          </div>
          <div className="form-actions"><button className="primary-button" disabled={saving !== "" || !machineId || !designVersionId || !compatible.length}>{saving === "start" ? "جارٍ بدء التشغيل..." : "بدء التشغيل"}</button></div>
        </form>}

        <section className="card">
          <div className="card-header"><div><h2 className="card-title">حالة الماكينات</h2><p className="form-hint">عدد الماكينات النشطة: {sessions.length} · جلسات التشغيل المفتوحة: {sessions.filter(s => Boolean(s.session_id)).length}</p></div></div>
          <div className="table-wrap"><table><thead><tr><th>الماكينة</th><th>الحالة المسجلة</th><th>التصميم</th><th>المشغل / الوردية</th><th>بداية التشغيل</th><th>إنتاج جيد</th><th>الهالك</th><th>المتبقي من الهدف</th><th>التوقف / آخر تحديث</th><th>الإجراءات</th></tr></thead><tbody>
            {sessions.map(s => <tr key={s.machine_id}>
              <td>{s.machine_name} ({s.machine_code})</td>
              <td>{s.downtime_id ? "متوقفة مؤقتًا" : s.session_id ? "تعمل حسب آخر تسجيل" : "لا توجد جلسة تشغيل مفتوحة"}{s.downtime_reason ? <div className="form-hint">{s.downtime_reason}</div> : null}</td>
              <td>{s.design_code ? s.design_code + " — " + s.design_name + " · V" + s.version_no : "—"}</td>
              <td>{s.operator_name || "غير محدد"}{s.shift_name ? <div className="form-hint">{s.shift_name}</div> : null}</td>
              <td>{dateTime(s.started_at)}</td>
              <td>{formatQuantity(s.achieved_quantity,0)}</td>
              <td>{formatQuantity(s.scrap_quantity,0)}</td>
              <td>{s.remaining_quantity == null ? "بدون مستهدف" : formatQuantity(s.remaining_quantity,0)}</td>
              <td>{s.downtime_id ? "بدأ التوقف: " + dateTime(s.downtime_started_at) : s.last_session_started_at ? "آخر جلسة: " + dateTime(s.last_session_started_at) + " · " + (s.last_session_status === "STOPPED" ? "منتهية" : s.last_session_status || "") : "لم تسجل جلسة بعد"}</td>
              <td>{s.session_id && has("machine_production.sessions.manage") ? <div className="form-actions"><button type="button" className="secondary-btn" disabled={saving !== "" || Boolean(s.downtime_id)} onClick={() => {setDowntimeTarget(s);setDowntimeReason("")}}>تسجيل توقف</button>{s.downtime_id && has("machine_production.downtime.manage") ? <button type="button" className="secondary-btn" disabled={saving !== ""} onClick={() => void endDowntime(s)}>{saving === "end-downtime:" + s.downtime_id ? "جارٍ الإنهاء..." : "إنهاء التوقف"}</button> : null}<button type="button" className="danger-button" disabled={saving !== ""} onClick={() => void stopSession(s)}>{saving === "stop:" + s.session_id ? "جارٍ الإنهاء..." : "إنهاء التشغيل"}</button></div> : "—"}</td>
            </tr>)}
            {!sessions.length && <tr><td colSpan={10}>لا توجد ماكينات نشطة لعرضها.</td></tr>}
          </tbody></table></div>
        </section>

        {has("machine_production.targets.manage") && <form className="card form-card" onSubmit={createTarget}>
          <div className="card-header"><h2 className="card-title">إضافة مستهدف إنتاج</h2></div>
          <div className="form-grid">
            <label>الماكينة<select value={targetMachineId} onChange={e => {setTargetMachineId(e.target.value);setTargetDesignVersionId("")}} required><option value="">اختر الماكينة</option>{machines.map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}</select></label>
            <label>التصميم (اختياري)<select value={targetDesignVersionId} onChange={e => setTargetDesignVersionId(e.target.value)}><option value="">مستهدف لكل تصميمات الماكينة</option>{targetCompatible.map(v => <option key={v.design_version_id} value={v.design_version_id}>{labelVersion(v)}</option>)}</select><span className="form-hint">تظهر هنا تصميمات الماكينة المحددة في أعلى الصفحة.</span></label>
            <label>نوع المستهدف<select value={targetPeriodType} onChange={e => setTargetPeriodType(e.target.value as "DAY"|"MONTH"|"SHIFT")}><option value="DAY">يومي</option><option value="MONTH">شهري</option><option value="SHIFT">وردية</option></select></label>
            <label>التاريخ / الشهر<input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} required/><span className="form-hint">يبدأ المستهدف من التاريخ المختار وحتى نهاية الشهر؛ لتغيير المستهدف منتصف الشهر اختر تاريخ بداية التطبيق الجديد.</span></label>
            {targetPeriodType === "SHIFT" && <label>الوردية<select value={targetShiftId} onChange={e => setTargetShiftId(e.target.value)} required><option value="">اختر الوردية</option>{shifts.filter(s => s.is_active !== false).map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}</select></label>}
            <label>مستهدف الكمية الجيدة<input type="number" min="0.001" step="0.001" value={targetQuantity} onChange={e => setTargetQuantity(e.target.value)} required/></label>
            <label>مستهدف عدد الدورات (اختياري)<input type="number" min="1" step="1" value={targetCycles} onChange={e => setTargetCycles(e.target.value)}/></label>
            <label style={{gridColumn:"1 / -1"}}>ملاحظات<input value={targetNotes} onChange={e => setTargetNotes(e.target.value)} maxLength={1000}/></label>
          </div>
          <div className="form-actions"><button className="primary-button" disabled={saving !== "" || !targetMachineId}>{saving === "target" ? "جارٍ الحفظ..." : "حفظ المستهدف"}</button></div>
        </form>}

        <section className="card">
          <div className="card-header"><h2 className="card-title">سجل المستهدفات</h2></div>
          <div className="table-wrap"><table><thead><tr><th>الماكينة</th><th>التصميم</th><th>نوع المستهدف</th><th>الفترة</th><th>الكمية</th><th>الدورات</th><th>الوردية</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>
            {targets.map(t => <tr key={t.id}><td>{t.machine_name} ({t.machine_code})</td><td>{t.design_code ? t.design_code + " — " + t.design_name + " · V" + t.version_no : "كل التصميمات"}</td><td>{t.period_type === "DAY" ? "يومي" : t.period_type === "MONTH" ? "شهري" : "وردية"}</td><td>{String(t.effective_from).slice(0,10)} — {String(t.effective_to).slice(0,10)}</td><td>{formatQuantity(t.target_quantity,0)}</td><td>{t.target_cycles ?? "—"}</td><td>{t.shift_name || "—"}</td><td>{!t.is_active ? "متوقف" : String(t.effective_to).slice(0,10)<localDateKey() ? "فترة منتهية" : String(t.effective_from).slice(0,10)>localDateKey() ? "مستقبلي" : "مطبق الآن"}</td><td>{t.is_active && String(t.effective_to).slice(0,10)>=localDateKey() && has("machine_production.targets.manage") ? <button type="button" className="danger-button" disabled={saving !== ""} onClick={() => void deactivateTarget(t)}>{saving === "target:" + t.id ? "جارٍ الإيقاف..." : "إيقاف"}</button> : "—"}</td></tr>)}
            {!targets.length && <tr><td colSpan={9}>لم يتم تحديد مستهدفات بعد.</td></tr>}
          </tbody></table></div>
        </section>
      </section>
    </main>
    {downtimeTarget && <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="downtime-title">
      <h2 id="downtime-title" className="card-title">تسجيل توقف ماكينة</h2><p>{downtimeTarget.machine_name} ({downtimeTarget.machine_code})</p>
      <form onSubmit={startDowntime}><label>سبب التوقف<textarea value={downtimeReason} onChange={e => setDowntimeReason(e.target.value)} required minLength={2} maxLength={500} rows={3} placeholder="مثال: تغيير خامة، صيانة، عطل شفاط"/></label>
        <div className="form-actions"><button type="button" className="secondary-btn" disabled={saving === "downtime"} onClick={() => setDowntimeTarget(null)}>إلغاء</button><button className="primary-button" disabled={saving === "downtime" || downtimeReason.trim().length < 2}>{saving === "downtime" ? "جارٍ الحفظ..." : "تأكيد التوقف"}</button></div>
      </form>
    </section></div>}
  </div>;
}
