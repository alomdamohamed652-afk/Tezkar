"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Sidebar, usePermissions } from "../../../components/sidebar";
import { SearchableSelect } from "../../../components/searchable-select";

type Punch = {
  id: string; punchAt: string; originalPunchAt: string; originalStatus: string; effectiveStatus: string;
  verifyMethod: string | null; suspicious: boolean; reviewStatus: string;
  correctionDecision: string | null; correctionNote: string | null; isNearDuplicate: boolean;
};
type CorrectionSuggestion = { id: string; punchAt: string; originalStatus: string; suggestedStatus: string; reason: string };
type DayRow = {
  date: string; employeeId: string; employeeCode: string; employeeName: string;
  scheduledStart: string | null; scheduledEnd: string | null; isDayOff: boolean;
  firstIn: string | null; lastOut: string | null; workedHours: number; lateMinutes: number; earlyMinutes: number;
  overtimeMinutes: number; status: string; needsReview: boolean; manualOverride?: boolean; manualNote?: string | null;
  punchTimeline: Punch[]; correctionSuggestions: CorrectionSuggestion[]; duplicatePunchCount: number; suspiciousCount: number;
};
type EmployeeInfo = { id: string; code: string; name: string };
type Policy = { employee_id: string; work_days_per_month: number; daily_work_minutes: number; day_off_pay_amount: string | number; overtime_multiplier: string | number; allowed_leave_days_per_month?: number | string | null };

const punchLabels: Record<string, string> = { IN: "دخول", OUT: "خروج", OVERTIME_IN: "دخول إضافي", OVERTIME_OUT: "خروج إضافي", UNKNOWN: "غير معروف" };
const reviewLabels: Record<string, string> = { PENDING: "بانتظار المراجعة", AUTO_ACCEPTED: "مقبولة تلقائيًا", APPROVED: "معتمدة", REJECTED: "مرفوضة" };
const statusLabels: Record<string, string> = { PRESENT: "حاضر", ABSENT: "غياب غير مؤكد", MISSING_PUNCH: "بصمة ناقصة", DAY_OFF: "إجازة / راحة", DAY_OFF_WITH_PUNCH: "حركة في الإجازة", NOT_STARTED: "لم يبدأ اليوم", NO_SCHEDULE: "بدون جدول", NO_SCHEDULE_WITH_PUNCH: "حركة بدون جدول" };

type CellKind = "ok" | "review" | "missing" | "absent" | "off" | "offpunch" | "nosched" | "noschedpunch" | "future";
const cellMeta: Record<CellKind, { mark: string; label: string }> = {
  ok: { mark: "✓", label: "بصمات سليمة" },
  review: { mark: "!", label: "تحتاج مراجعة" },
  missing: { mark: "ن", label: "بصمة ناقصة" },
  absent: { mark: "غ؟", label: "غياب غير مؤكد (بصمات ناقصة)" },
  off: { mark: "ر", label: "إجازة / راحة" },
  offpunch: { mark: "ر+", label: "حركة في الإجازة" },
  nosched: { mark: "—", label: "بدون جدول" },
  noschedpunch: { mark: "؟", label: "حركة بدون جدول" },
  future: { mark: "·", label: "لم يبدأ اليوم" }
};

function classify(row: DayRow): CellKind {
  if (row.status === "NOT_STARTED") return "future";
  if (row.status === "DAY_OFF") return "off";
  if (row.status === "DAY_OFF_WITH_PUNCH") return "offpunch";
  if (row.status === "NO_SCHEDULE") return "nosched";
  if (row.status === "NO_SCHEDULE_WITH_PUNCH") return "noschedpunch";
  if (row.status === "ABSENT") return "absent";
  if (row.status === "MISSING_PUNCH") return "missing";
  if (row.needsReview) return "review";
  return "ok";
}

const fmtTime = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }) : "—";

export default function AttendanceMonthlyPage() {
  const { has } = usePermissions();
  const [month, setMonth] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(new Date()));
  const [rows, setRows] = useState<DayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("ALL");
  const [selected, setSelected] = useState<DayRow | null>(null);
  const [showLeaves, setShowLeaves] = useState(false);
  const [policies, setPolicies] = useState<Record<string, Policy>>({});
  const [hoursDraft, setHoursDraft] = useState<Record<string, string>>({});
  const [leaveDraft, setLeaveDraft] = useState<Record<string, string>>({});
  const [savingHours, setSavingHours] = useState("");
  const canViewPolicy = has("payroll.view"), canEditPolicy = has("payroll.manage");

  const daysInMonth = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    return y && m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 30;
  }, [month]);

  async function load() {
    setLoading(true); setError(""); setNotice(""); setSelected(null);
    const from = month + "-01";
    const to = month + "-" + String(daysInMonth).padStart(2, "0");
    try {
      const result = await api<{ data: DayRow[] }>("/api/attendance/report?from=" + from + "&to=" + to);
      setRows(result.data);
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر تحميل سجلات الشهر."); setRows([]); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [month, daysInMonth]);

  const employees = useMemo(() => {
    const map = new Map<string, EmployeeInfo>();
    for (const r of rows) if (!map.has(r.employeeId)) map.set(r.employeeId, { id: r.employeeId, code: r.employeeCode, name: r.employeeName });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [rows]);

  useEffect(() => {
    if (!canViewPolicy || !employees.length) return;
    let active = true;
    (async () => {
      const next: Record<string, Policy> = {};
      for (const emp of employees) {
        try {
          const r = await api<{ data: Policy }>("/api/payroll/employees/" + encodeURIComponent(emp.id) + "/attendance-policy");
          next[emp.id] = r.data;
        } catch { /* يظل الحقل غير متاح لهذا الموظف */ }
      }
      if (active) {
        setPolicies(next);
        setHoursDraft(Object.fromEntries(Object.entries(next).map(([id, p]) => [id, String(p.daily_work_minutes / 60)])));
        setLeaveDraft(Object.fromEntries(Object.entries(next).map(([id, p]) => [id, p.allowed_leave_days_per_month === null || p.allowed_leave_days_per_month === undefined ? "" : String(p.allowed_leave_days_per_month)])));
      }
    })();
    return () => { active = false; };
  }, [employees, canViewPolicy]);

  const byEmployeeDay = useMemo(() => {
    const map = new Map<string, DayRow>();
    for (const r of rows) map.set(r.employeeId + "|" + r.date, r);
    return map;
  }, [rows]);

  const visibleEmployees = employeeFilter === "ALL" ? employees : employees.filter(e => e.id === employeeFilter);

  const leaveCounts = useMemo(() => {
    const map = new Map<string, { off: number; offpunch: number }>();
    for (const r of rows) {
      const kind = classify(r);
      if (kind !== "off" && kind !== "offpunch") continue;
      const entry = map.get(r.employeeId) ?? { off: 0, offpunch: 0 };
      if (kind === "off") entry.off++; else entry.offpunch++;
      map.set(r.employeeId, entry);
    }
    return map;
  }, [rows]);

  const monthSummary = useMemo(() => {
    const counts: Record<CellKind, number> = { ok: 0, review: 0, missing: 0, absent: 0, off: 0, offpunch: 0, nosched: 0, noschedpunch: 0, future: 0 };
    for (const r of rows) if (employeeFilter === "ALL" || r.employeeId === employeeFilter) counts[classify(r)]++;
    return counts;
  }, [rows, employeeFilter]);

  async function saveHours(emp: EmployeeInfo) {
    const hours = Number(hoursDraft[emp.id]);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) { setError("عدد الساعات اليومية يجب أن يكون بين ٠ و ٢٤."); return; }
    const current = policies[emp.id];
    if (!current) return;
    const supportsLeave = "allowed_leave_days_per_month" in current;
    let leaveDays: number | null = null;
    if (supportsLeave) {
      const raw = (leaveDraft[emp.id] ?? "").trim();
      if (raw === "") leaveDays = null;
      else {
        leaveDays = Number(raw);
        if (!Number.isFinite(leaveDays) || leaveDays < 0 || leaveDays > 31) { setError("أيام الإجازة المسموحة يجب أن تكون بين ٠ و ٣١."); return; }
      }
    }
    setSavingHours(emp.id); setError(""); setNotice("");
    try {
      await api("/api/payroll/employees/" + encodeURIComponent(emp.id) + "/attendance-policy", {
        method: "PUT",
        body: JSON.stringify({
          workDaysPerMonth: current.work_days_per_month,
          dailyWorkMinutes: Math.round(hours * 60),
          dayOffPayAmount: Number(current.day_off_pay_amount),
          overtimeMultiplier: Number(current.overtime_multiplier),
          ...(supportsLeave ? { allowedLeaveDaysPerMonth: leaveDays } : {})
        })
      });
      setPolicies(old => ({ ...old, [emp.id]: { ...current, daily_work_minutes: Math.round(hours * 60), ...(supportsLeave ? { allowed_leave_days_per_month: leaveDays } : {}) } }));
      setNotice("تم حفظ إعدادات " + emp.name + ". ساعات العمل تُستخدم عند اعتماد أي مسير لم يُعتمد بعد؛ المعتمد لا يتغير.");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذر حفظ الإعدادات."); }
    finally { setSavingHours(""); }
  }

  const punchGroups = useMemo(() => {
    if (!selected) return null;
    const timeline = selected.punchTimeline ?? [];
    const flagged = timeline.filter(p => p.suspicious || p.isNearDuplicate || p.reviewStatus === "PENDING");
    const rejected = timeline.filter(p => p.reviewStatus === "REJECTED" && !flagged.includes(p));
    const good = timeline.filter(p => !flagged.includes(p) && !rejected.includes(p));
    return { good, flagged, rejected };
  }, [selected]);

  return (
    <div className="app-shell"><Sidebar active="/attendance/monthly" /><main className="main">
      <header className="topbar"><div><h1 className="page-title">سجلات حضور الشهر</h1><p className="page-subtitle">كل أيام الشهر لكل موظف في شاشة واحدة. اضغط أي يوم لترى بصماته: السليمة، والمشكوك فيها، والتي تحتاج تصحيحًا. شبكة الشهر للعرض فقط؛ إعدادات الساعات والإجازات في الأسفل قابلة للتعديل لمن لديه صلاحية إدارة الرواتب.</p></div></header>
      <section className="content">
        <section className="card form-card"><div className="card-header"><h2 className="card-title">اختيار الشهر</h2></div>
          <div className="form-grid">
            <label>الشهر<input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
            <label>الموظف<SearchableSelect value={employeeFilter} onChange={setEmployeeFilter} options={[{ value: "ALL", label: "كل الموظفين" }, ...employees.map(e => ({ value: e.id, label: e.name, meta: e.code }))]} /></label>
          </div>
          {error && <div className="alert">{error}</div>}
          {notice && <div className="success-box">{notice}</div>}
          <div className="attendance-legend" style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "12px 0 4px" }}>
            {(Object.keys(cellMeta) as CellKind[]).map(k => <span key={k} className={"month-cell month-cell-" + k} style={{ position: "static", width: "auto", padding: "4px 10px" }}>{cellMeta[k].mark} {cellMeta[k].label}</span>)}
            <span className="form-hint" style={{ alignSelf: "center" }}>علامة * تعني تعديلًا يدويًا موثقًا.</span>
          </div>
        </section>

        <section className="card"><div className="card-header"><div><h2 className="card-title">شبكة الشهر ({daysInMonth} يومًا)</h2>{rows.length > 0 && <span className="form-hint">سليم {monthSummary.ok} · مراجعة {monthSummary.review} · ناقصة {monthSummary.missing} · غياب غير مؤكد {monthSummary.absent}</span>}</div><span className="status muted">عرض فقط، لا يغيّر أي سجل أو مرتب</span></div>
          {loading ? <div className="empty">جارٍ تحميل سجلات الشهر...</div> : !rows.length ? <div className="empty">لا توجد سجلات لهذا الشهر.</div> : (
            <div className="table-wrap"><table className="month-grid"><thead><tr><th className="month-emp-col">الموظف</th>{Array.from({ length: daysInMonth }, (_, i) => <th key={i + 1}>{i + 1}</th>)}</tr></thead>
              <tbody>{visibleEmployees.map(emp => (
                <tr key={emp.id}><td className="month-emp-col"><strong>{emp.name}</strong><small style={{ display: "block" }}>{emp.code}</small></td>
                  {Array.from({ length: daysInMonth }, (_, i) => {
                    const date = month + "-" + String(i + 1).padStart(2, "0");
                    const row = byEmployeeDay.get(emp.id + "|" + date);
                    if (!row) return <td key={date} />;
                    const kind = classify(row);
                    return <td key={date}><button type="button" className={"month-cell month-cell-" + kind} title={cellMeta[kind].label + (row.manualOverride ? " · تعديل يدوي" : "")} onClick={() => setSelected(row)}>{cellMeta[kind].mark}{row.manualOverride ? "*" : ""}</button></td>;
                  })}
                </tr>))}
              </tbody></table></div>
          )}
        </section>

        <section className="card"><div className="card-header"><div><h2 className="card-title">أيام الراحة والإجازة في الشهر</h2><p className="form-hint">أيام الراحة الأسبوعية وأيام الإجازة المسجلة كاستثناء في الشهر المعروض، وأيام الراحة التي سُجلت فيها حركة. هذا عرض للجدول فقط، وليس رصيد إجازات ولا خصمًا منه.</p></div><button className="secondary-btn" onClick={() => setShowLeaves(v => !v)}>{showLeaves ? "إخفاء" : "عرض أيام الراحة والإجازة"}</button></div>
          {showLeaves && (!rows.length ? <div className="empty">حمّل شهرًا أولًا لعرض أيام الراحة والإجازة.</div> : (
            <div className="table-wrap"><table><thead><tr><th>الموظف</th><th>الكود</th><th>أيام الراحة / الإجازة</th><th>أيام بها حركة في الإجازة</th></tr></thead><tbody>
              {visibleEmployees.map(emp => {
                const counts = leaveCounts.get(emp.id) ?? { off: 0, offpunch: 0 };
                return <tr key={emp.id}><td>{emp.name}</td><td className="mono">{emp.code}</td><td>{counts.off.toLocaleString("ar-EG")} يوم</td><td>{counts.offpunch ? counts.offpunch.toLocaleString("ar-EG") + " يوم" : "—"}</td></tr>;
              })}
            </tbody></table></div>
          ))}
        </section>

        <section className="card"><div className="card-header"><div><h2 className="card-title">ساعات العمل وأيام الإجازة المسموحة لكل موظف</h2><p className="form-hint">ساعات العمل اليومية تُقرأ لحظة اعتماد المسير: أي مسير لم يُعتمد بعد، بما فيه المسودات المحفوظة، يُحتسب بالقيمة الجديدة عند اعتماده؛ المعتمد لا يتغير. أيام الإجازة المسموحة رصيد شهري للمتابعة فقط حاليًا ولا تدخل في الاحتساب.</p></div><span className="status pending">قابلة للتعديل · تؤثر عند الاعتماد</span></div>
          {!canViewPolicy ? <div className="empty">عرض الإعدادات يتطلب صلاحية عرض الرواتب.</div> : !employees.length ? <div className="empty">حمّل شهرًا أولًا لعرض الموظفين.</div> : (
            <div className="settings-list">
              {visibleEmployees.map(emp => {
                const policy = policies[emp.id];
                const supportsLeave = policy ? "allowed_leave_days_per_month" in policy : false;
                return <div key={emp.id} className="settings-row">
                  <div className="settings-who"><strong>{emp.name}</strong><small className="mono" style={{ display: "block" }}>{emp.code}</small></div>
                  <label className="settings-field"><span>ساعات العمل اليومية</span>{policy ? <input type="number" min={1} max={24} step={0.25} style={{ width: 90 }} value={hoursDraft[emp.id] ?? ""} disabled={!canEditPolicy} onChange={e => setHoursDraft(old => ({ ...old, [emp.id]: e.target.value }))} /> : <span>—</span>}</label>
                  {supportsLeave && <label className="settings-field"><span>أيام الإجازة المسموحة شهريًا</span><input type="number" min={0} max={31} step={0.5} style={{ width: 90 }} placeholder="غير محدد" value={leaveDraft[emp.id] ?? ""} disabled={!canEditPolicy} onChange={e => setLeaveDraft(old => ({ ...old, [emp.id]: e.target.value }))} /></label>}
                  {canEditPolicy && policy && <button className="secondary-btn" disabled={savingHours === emp.id} onClick={() => void saveHours(emp)}>{savingHours === emp.id ? "جارٍ الحفظ..." : "حفظ"}</button>}
                </div>;
              })}
            </div>
          )}
        </section>
      </section>

      {selected && punchGroups && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}><div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="card-header"><div><h2 className="card-title">{selected.employeeName} · {selected.date}</h2><div className="form-hint">{selected.status === "ABSENT" && selected.manualOverride ? "غياب موثق بتسوية يدوية" : statusLabels[selected.status] ?? selected.status}{selected.manualOverride && selected.status !== "ABSENT" ? " · تعديل يدوي موثق" : ""}{selected.manualNote ? " · " + selected.manualNote : ""}</div></div><button className="secondary-btn" onClick={() => setSelected(null)}>إغلاق</button></div>
          <div className="stats" style={{ padding: "0 18px" }}>
            <div className="card stat"><div className="stat-label">الوردية</div><div className="stat-value" style={{ fontSize: 15 }}>{selected.scheduledStart?.slice(0, 5) ?? "—"} - {selected.scheduledEnd?.slice(0, 5) ?? "—"}</div></div>
            <div className="card stat"><div className="stat-label">الحضور</div><div className="stat-value" style={{ fontSize: 15 }}>{fmtTime(selected.firstIn)}</div></div>
            <div className="card stat"><div className="stat-label">الانصراف</div><div className="stat-value" style={{ fontSize: 15 }}>{fmtTime(selected.lastOut)}</div></div>
            <div className="card stat"><div className="stat-label">ساعات العمل</div><div className="stat-value" style={{ fontSize: 15 }}>{Number(selected.workedHours ?? 0).toLocaleString("ar-EG", { maximumFractionDigits: 2 })} ساعة</div></div>
            <div className="card stat"><div className="stat-label">تأخير / مبكر</div><div className="stat-value" style={{ fontSize: 15 }}>{selected.lateMinutes} / {selected.earlyMinutes} د</div></div>
          </div>
          <div style={{ padding: "12px 18px 18px", display: "grid", gap: 14 }}>
            {selected.status === "ABSENT" && (selected.manualOverride
              ? <div className="month-note">سُوّي هذا اليوم يدويًا كغياب موثق بقرار مسؤول.</div>
              : <div className="alert"><strong>غياب غير مؤكد:</strong> هذا اليوم مجدول ولا توجد له أي بصمة مسجلة. قد يكون السبب عطل تسجيل أو مشكلة نقل بيانات من الجهاز، وليس بالضرورة غيابًا فعليًا. عند اعتماد المسير يُخصم عن هذا اليوم يوم كامل ما لم تتم مراجعته وتسويته.</div>)}
            {(() => { const s = selected.scheduledStart, e2 = selected.scheduledEnd; if (!s || !e2) return null; const [sh, sm] = s.split(":").map(Number); const [eh, em] = e2.split(":").map(Number); return eh * 60 + em <= sh * 60 + sm ? <div className="month-note">وردية تمتد بعد منتصف الليل؛ بصمة الخروج التي بعد منتصف الليل تُنسب لهذا اليوم ضمن مهلة سماح الخروج المضبوطة.</div> : null; })()}
            <section><h3 className="card-title" style={{ fontSize: 14, margin: "0 0 8px" }}>البصمات المظبوطة ({punchGroups.good.length})</h3>
              {!punchGroups.good.length ? <div className="empty">لا توجد بصمات مظبوطة.</div> : punchGroups.good.map((p, i) => <div key={p.id} className="month-punch-row"><strong>{i + 1}.</strong><span>{fmtTime(p.punchAt)}</span><span className="status success">{punchLabels[p.effectiveStatus] ?? p.effectiveStatus}</span><small>{reviewLabels[p.reviewStatus] ?? p.reviewStatus}</small>{p.correctionDecision === "APPLIED" && <small>· بعد تصحيح معتمد</small>}</div>)}
            </section>
            <section><h3 className="card-title" style={{ fontSize: 14, margin: "0 0 8px" }}>البصمات المشكوك فيها ({punchGroups.flagged.length})</h3>
              {!punchGroups.flagged.length ? <div className="empty">لا توجد بصمات مشكوك فيها.</div> : punchGroups.flagged.map((p, i) => <div key={p.id} className="month-punch-row"><strong>{i + 1}.</strong><span>{fmtTime(p.punchAt)}</span><span className="status warning">{punchLabels[p.effectiveStatus] ?? p.effectiveStatus}</span><small>{p.suspicious ? "مشتبه فيها" : p.isNearDuplicate ? "مكررة قريبة" : "بانتظار المراجعة"}</small>{p.originalStatus !== p.effectiveStatus && <small>· الأصل: {punchLabels[p.originalStatus] ?? p.originalStatus}</small>}</div>)}
            </section>
            <section><h3 className="card-title" style={{ fontSize: 14, margin: "0 0 8px" }}>مشاكل تحتاج تصحيحًا</h3>
              {selected.status === "MISSING_PUNCH" && <div className="alert">بصمة ناقصة: لا يوجد زوج دخول/خروج مكتمل لهذا اليوم.</div>}
              {(selected.duplicatePunchCount ?? 0) > 0 && <div className="alert">{selected.duplicatePunchCount} بصمة مكررة في هذا اليوم تحتاج مراجعة.</div>}
              {punchGroups.rejected.map((p, i) => <div key={p.id} className="month-punch-row"><strong>{i + 1}.</strong><span>{fmtTime(p.punchAt)}</span><span className="status danger">مرفوضة</span><small>{punchLabels[p.effectiveStatus] ?? p.effectiveStatus}</small></div>)}
              {(selected.correctionSuggestions ?? []).map(s => <div key={s.id} className="month-punch-row"><span>{fmtTime(s.punchAt)}</span><span className="status warning">تصحيح مقترح</span><small>{punchLabels[s.originalStatus] ?? s.originalStatus} ← المقترح {punchLabels[s.suggestedStatus] ?? s.suggestedStatus} — {s.reason}</small></div>)}
              {selected.status !== "MISSING_PUNCH" && !(selected.duplicatePunchCount ?? 0) && !punchGroups.rejected.length && !(selected.correctionSuggestions ?? []).length && <div className="empty">لا توجد مشاكل تحتاج تصحيحًا في هذا اليوم.</div>}
            </section>
            {!selected.punchTimeline?.length && selected.status !== "ABSENT" && <div className="month-note warn">لا توجد بصمات مسجلة في هذا اليوم. غياب البصمة لا يعني بالضرورة غيابًا فعليًا. راجع سبب العطل قبل الاعتماد.</div>}
            <p className="form-hint" style={{ margin: 0 }}>تصحيح البصمات والتسوية اليدوية واعتماد التصحيحات يتم من شاشة «الحضور والبصمة»؛ هذه الشاشة للمراجعة فقط.</p>
          </div>
        </div></div>
      )}
      <style jsx global>{`
        .month-grid { min-width: 100%; border-collapse: separate; border-spacing: 2px; }
        .month-grid th { font-size: 11px; color: var(--muted); padding: 4px 2px; min-width: 30px; text-align: center; }
        .month-grid td { padding: 0; text-align: center; }
        .month-emp-col { min-width: 160px; text-align: right !important; padding: 6px 10px !important; position: sticky; right: 0; background: var(--surface); z-index: 1; }
        .month-cell { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; border: 1px solid transparent; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; padding: 0; }
        .month-cell-ok { background: #e8f7ef; color: #1c6e4a; border-color: #bfe5d0; }
        .month-cell-review { background: #fff3e0; color: #b45309; border-color: #f2d3a7; }
        .month-cell-missing { background: #fef9c3; color: #a16207; border-color: #ecdf9a; }
        .month-cell-absent { background: #fdecec; color: #b23c3c; border-color: #f2c4c4; }
        .month-cell-off { background: #eef2f7; color: #64748b; border-color: #dbe3ec; }
        .month-cell-offpunch { background: #e0f2fe; color: #0369a1; border-color: #bae0f5; }
        .month-cell-nosched { background: #f4f5f7; color: #94a3b8; border-color: #e2e8f0; }
        .month-cell-noschedpunch { background: #f3e8ff; color: #7c3aed; border-color: #e1cffb; }
        .month-cell-future { background: transparent; color: #c2ccd8; border-color: transparent; cursor: default; }
        .month-cell:not(.month-cell-future):hover { filter: brightness(.95); }
        .month-punch-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
        .month-punch-row small { color: var(--muted); }
        .month-note { padding: 11px 13px; border: 1px solid #bae0f5; border-radius: 10px; background: #e0f2fe; color: #075985; font-size: 12px; font-weight: 600; line-height: 1.7; }
        .month-note.warn { border-color: #f2d3a7; background: #fff3e0; color: #b45309; }
        .settings-list { display: grid; }
        .settings-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--border); }
        .settings-row:last-child { border-bottom: 0; }
        .settings-who { flex: 1 1 170px; min-width: 140px; }
        .settings-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
        @media (max-width: 700px) { .month-emp-col { min-width: 110px; } .month-cell { width: 24px; height: 24px; font-size: 11px; } .settings-row { gap: 10px; } .settings-who { flex: 1 1 100%; } }
      `}</style>
    </main></div>
  );
}
