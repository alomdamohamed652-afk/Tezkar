"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { Sidebar, usePermissions } from "../../components/sidebar";
import { formatMoney } from "../../lib/format";

type Line = { id: string; line_type: "BONUS" | "DEDUCTION"; description: string; amount: string | number; notes: string | null };
type Slip = {
  id: string; period_month: string; base_salary: string | number; advance_repayment_amount: string | number | null;
  net_amount: string | number; paid_amount: string | number; remaining_amount: number; lines: Line[];
};
type Day = {
  date: string; status: string; isDayOff: boolean; scheduledStart: string | null; scheduledEnd: string | null;
  firstIn: string | null; lastOut: string | null; workedMinutes: number; lateMinutes: number; earlyMinutes: number;
  overtimeMinutes: number; permissionMinutes: number; outsideSchedule?: boolean;
};
type Punch = { punch_at: string; status: string; verify_method: string };
type Weekly = { weekday: number; starts_at: string | null; ends_at: string | null; is_day_off: boolean };
type Exception = { start_date: string; end_date: string; starts_at: string | null; ends_at: string | null; is_day_off: boolean; note: string | null };
type PermissionRow = { id: string; permission_date: string; starts_at: string; ends_at: string; duration_minutes: number; permission_type: "PAID" | "UNPAID" | null; reason: string; status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED"; review_note: string | null };

const dayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const statusName: Record<string, string> = {
  PRESENT: "حضور", ABSENT: "غياب", MISSING_PUNCH: "بصمة ناقصة", DAY_OFF: "راحة", DAY_OFF_WITH_PUNCH: "حضور في يوم راحة",
  NOT_STARTED: "لم يبدأ بعد", NO_SCHEDULE: "بدون جدول", NO_SCHEDULE_WITH_PUNCH: "حضور بدون جدول"
};
const statusClass = (s: string) => s === "PRESENT" || s === "DAY_OFF_WITH_PUNCH" ? "status-ok" : s === "ABSENT" ? "status-bad" : s === "MISSING_PUNCH" ? "status-warn" : "";
const punchName: Record<string, string> = { IN: "دخول", OUT: "خروج", OVERTIME_IN: "دخول إضافي", OVERTIME_OUT: "خروج إضافي", UNKNOWN: "بصمة" };
const requestStatus: Record<string, string> = { PENDING: "بانتظار المراجعة", APPROVED: "تمت الموافقة", REJECTED: "مرفوض", CANCELLED: "ملغي" };

function cairoToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return get("year") + "-" + get("month") + "-" + get("day");
}
function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: month + "-01", to: month + "-" + String(last).padStart(2, "0") };
}
function timeOf(value: string | null) {
  if (!value) return "—";
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(value)) return value.slice(11, 16) || "—";
  return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
}
function dateTimeOf(value: string) {
  return new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
const hm = (minutes: number) => minutes <= 0 ? "—" : Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0");
const dayOf = (date: string) => dayNames[new Date(date + "T00:00:00Z").getUTCDay()];
const t5 = (v: string | null) => (v ? v.slice(0, 5) : "—");

type Tab = "salary" | "attendance" | "permissions" | "schedule";

export default function MePage() {
  const { has, session } = usePermissions();
  const canSalary = has("payroll.view_own"), canAttendance = has("attendance.view_own"), canPermissions = has("attendance.permission.view_own");
  const tabs = useMemo(() => [
    canSalary && { id: "salary" as Tab, label: "مرتبي" },
    canAttendance && { id: "attendance" as Tab, label: "حضوري وبصماتي" },
    canPermissions && { id: "permissions" as Tab, label: "أذوناتي" },
    canAttendance && { id: "schedule" as Tab, label: "مواعيدي وإجازاتي" }
  ].filter(Boolean) as { id: Tab; label: string }[], [canSalary, canAttendance, canPermissions]);
  const [tab, setTab] = useState<Tab | null>(null);
  const active = tab ?? tabs[0]?.id ?? null;
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    if (wanted && tabs.some(t => t.id === wanted)) setTab(wanted as Tab);
  }, [tabs]);
  const [error, setError] = useState("");

  return <div className="app-shell"><Sidebar active="/me" /><main className="main">
    <header className="topbar"><div><h1 className="page-title">أنا</h1><p className="page-subtitle">{session?.fullName ? session.fullName + " · " : ""}بياناتك أنت فقط: مرتبك وحضورك وبصماتك وأذوناتك</p></div></header>
    <section className="content">
      {error && <div className="alert error">{error}</div>}
      {tabs.length === 0 && <div className="card"><p>لا توجد بيانات متاحة لحسابك. اطلب من الإدارة ربط حسابك بملف موظف وإعطاءه دور «موظف».</p></div>}
      {tabs.length > 0 && <div className="me-tabs" role="tablist">
        {tabs.map(t => <button key={t.id} role="tab" aria-selected={active === t.id} className={active === t.id ? "primary-button" : "secondary-btn"} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>}
      {active === "salary" && <SalaryTab onError={setError} />}
      {active === "attendance" && <AttendanceTab onError={setError} />}
      {active === "permissions" && <PermissionsTab onError={setError} />}
      {active === "schedule" && <ScheduleTab onError={setError} />}
    </section>
    <style jsx global>{`
      .me-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
      .me-big{font-size:28px;font-weight:800;margin:4px 0}
      .me-hint{color:#64748b;font-size:13px;margin:4px 0 0}
      .status-ok{color:#166534;font-weight:700}.status-bad{color:#b91c1c;font-weight:700}.status-warn{color:#b45309;font-weight:700}
      .me-line{display:flex;justify-content:space-between;gap:12px;padding:10px 20px;border-bottom:1px solid #e2e8f0}
      .me-line:last-child{border-bottom:0}
      .me-total{font-weight:800}
    `}</style>
  </main></div>;
}

function SalaryTab({ onError }: { onError: (m: string) => void }) {
  const [slips, setSlips] = useState<Slip[] | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ data: Slip[] }>("/api/me/payslips").then(r => { if (alive) setSlips(r.data); }).catch(e => { if (alive) onError(e instanceof Error ? e.message : "تعذر تحميل المرتب"); });
    return () => { alive = false; };
  }, [onError]);
  if (!slips) return <div className="card">جارٍ التحميل…</div>;
  if (!slips.length) return <div className="card"><p>لا يوجد مرتب معتمد حتى الآن. يظهر مرتب الشهر هنا بعد اعتماده من الإدارة.</p></div>;
  const latest = slips[0]!;
  return <>
    <article className="card stat accent">
      <div className="stat-label">آخر مرتب معتمد · شهر {latest.period_month.slice(0, 7)}</div>
      <div className="me-big">{formatMoney(latest.net_amount)} ج.م</div>
      <p className="me-hint">تم صرف {formatMoney(latest.paid_amount)} · المتبقي {formatMoney(latest.remaining_amount)}</p>
    </article>
    {slips.map(s => {
      const bonuses = s.lines.filter(l => l.line_type === "BONUS"), deductions = s.lines.filter(l => l.line_type === "DEDUCTION");
      return <section className="card" key={s.id}>
        <div className="card-header"><h2 className="card-title">شهر {s.period_month.slice(0, 7)}</h2>
          <button className="secondary-btn" onClick={() => window.open("/payroll/slip?month=" + encodeURIComponent(s.period_month.slice(0, 7)) + "&item=" + encodeURIComponent(s.id), "_blank", "noopener,noreferrer")}>مفردات المرتب (طباعة)</button></div>
        <div className="me-line"><span>الراتب الأساسي</span><strong>{formatMoney(s.base_salary)}</strong></div>
        {bonuses.map(l => <div className="me-line" key={l.id}><span>+ {l.description}</span><strong>{formatMoney(l.amount)}</strong></div>)}
        {deductions.map(l => <div className="me-line" key={l.id}><span>− {l.description}</span><strong>{formatMoney(l.amount)}</strong></div>)}
        {Number(s.advance_repayment_amount || 0) > 0 && <div className="me-line"><span>− سداد سلفة</span><strong>{formatMoney(s.advance_repayment_amount)}</strong></div>}
        <div className="me-line me-total"><span>الصافي المستحق</span><strong>{formatMoney(s.net_amount)}</strong></div>
      </section>;
    })}
  </>;
}

function AttendanceTab({ onError }: { onError: (m: string) => void }) {
  const [month, setMonth] = useState(cairoToday().slice(0, 7));
  const [days, setDays] = useState<Day[] | null>(null);
  const [punches, setPunches] = useState<Punch[]>([]);
  useEffect(() => {
    let alive = true;
    setDays(null);
    const { from, to } = monthRange(month);
    api<{ data: { days: Day[]; punches: Punch[] } }>("/api/me/attendance?from=" + from + "&to=" + to)
      .then(r => { if (alive) { setDays(r.data.days); setPunches(r.data.punches); } })
      .catch(e => { if (alive) onError(e instanceof Error ? e.message : "تعذر تحميل الحضور"); });
    return () => { alive = false; };
  }, [month, onError]);
  const totals = useMemo(() => (days ?? []).reduce((a, d) => ({
    present: a.present + (d.status === "PRESENT" || d.status === "DAY_OFF_WITH_PUNCH" ? 1 : 0),
    absent: a.absent + (d.status === "ABSENT" ? 1 : 0),
    late: a.late + d.lateMinutes, overtime: a.overtime + d.overtimeMinutes
  }), { present: 0, absent: 0, late: 0, overtime: 0 }), [days]);
  return <>
    <section className="card"><label>الشهر <input type="month" value={month} max={cairoToday().slice(0, 7)} onChange={e => e.target.value && setMonth(e.target.value)} /></label></section>
    {!days ? <div className="card">جارٍ التحميل…</div> : <>
      <div className="stats-grid">
        <article className="card stat"><div className="stat-label">أيام الحضور</div><div className="stat-value">{totals.present}</div></article>
        <article className="card stat"><div className="stat-label">أيام الغياب</div><div className="stat-value">{totals.absent}</div></article>
        <article className="card stat"><div className="stat-label">دقائق التأخير</div><div className="stat-value">{totals.late}</div></article>
        <article className="card stat"><div className="stat-label">الإضافي (ساعة:دقيقة)</div><div className="stat-value">{totals.overtime > 0 ? hm(totals.overtime) : "—"}</div></article>
      </div>
      <section className="card"><div className="card-header"><h2 className="card-title">أيامي</h2></div><div className="table-wrap"><table>
        <thead><tr><th>التاريخ</th><th>اليوم</th><th>الحالة</th><th>دخول</th><th>خروج</th><th>ساعات الشغل</th><th>تأخير (د)</th></tr></thead>
        <tbody>{days.map(d => <tr key={d.date}>
          <td>{d.date}</td><td>{dayOf(d.date)}</td><td className={statusClass(d.status)}>{statusName[d.status] ?? d.status}{d.outsideSchedule ? <small className="me-hint"> · خارج الميعاد</small> : null}</td>
          <td dir="ltr" style={{textAlign:"right"}}>{timeOf(d.firstIn)}</td><td dir="ltr" style={{textAlign:"right"}}>{timeOf(d.lastOut)}</td><td dir="ltr" style={{textAlign:"right"}}>{hm(d.workedMinutes)}</td><td>{d.lateMinutes || "—"}</td>
        </tr>)}</tbody></table></div></section>
      <section className="card"><div className="card-header"><h2 className="card-title">بصماتي</h2></div><div className="table-wrap"><table>
        <thead><tr><th>الوقت</th><th>النوع</th></tr></thead>
        <tbody>{punches.map((p, i) => <tr key={i}><td>{dateTimeOf(p.punch_at)}</td><td>{punchName[p.status] ?? p.status}</td></tr>)}
          {!punches.length && <tr><td colSpan={2}>لا توجد بصمات في هذا الشهر</td></tr>}</tbody></table></div></section>
    </>}
  </>;
}

function PermissionsTab({ onError }: { onError: (m: string) => void }) {
  const canRequest = usePermissions().has("attendance.permission.request");
  const [rows, setRows] = useState<PermissionRow[] | null>(null);
  const [date, setDate] = useState(cairoToday()), [startsAt, setStartsAt] = useState("10:00"), [endsAt, setEndsAt] = useState("11:00"), [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false), [done, setDone] = useState("");
  const load = useCallback(() => api<{ data: PermissionRow[] }>("/api/attendance/permissions/my").then(r => setRows(r.data)).catch(e => onError(e instanceof Error ? e.message : "تعذر تحميل الأذونات")), [onError]);
  useEffect(() => { void load(); }, [load]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setDone(""); onError("");
    try {
      await api("/api/attendance/permissions", { method: "POST", body: JSON.stringify({ date, startsAt, endsAt, reason }) });
      setReason(""); setDone("تم إرسال الطلب وينتظر مراجعة الإدارة"); await load();
    } catch (err) { onError(err instanceof Error ? err.message : "تعذر إرسال الطلب"); } finally { setSaving(false); }
  }
  async function cancel(id: string) {
    try { await api("/api/attendance/permissions/" + encodeURIComponent(id) + "/cancel", { method: "POST" }); await load(); }
    catch (err) { onError(err instanceof Error ? err.message : "تعذر إلغاء الطلب"); }
  }
  return <>
    {canRequest && <form className="card form-card" onSubmit={submit}>
      <div className="card-header"><h2 className="card-title">طلب إذن جديد</h2></div>
      <div className="form-grid">
        <label>التاريخ<input type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
        <label>من<input type="time" required value={startsAt} onChange={e => setStartsAt(e.target.value)} /></label>
        <label>إلى<input type="time" required value={endsAt} onChange={e => setEndsAt(e.target.value)} /></label>
        <label>السبب<input required minLength={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      </div>
      <p className="me-hint">الإدارة تحدد بعد المراجعة هل الإذن بمرتب أو بدون. لو الإذن يمتد بعد منتصف الليل حدد وقت النهاية في اليوم التالي (مثال: من 23:30 إلى 00:30).</p>
      {done && <p className="status-ok">{done}</p>}
      <div className="form-actions"><button className="primary-button" disabled={saving}>{saving ? "جارٍ الإرسال..." : "إرسال الطلب"}</button></div>
    </form>}
    <section className="card"><div className="card-header"><h2 className="card-title">أذوناتي</h2></div><div className="table-wrap"><table>
      <thead><tr><th>التاريخ</th><th>من</th><th>إلى</th><th>السبب</th><th>الحالة</th><th>النوع</th><th /></tr></thead>
      <tbody>{(rows ?? []).map(r => <tr key={r.id}>
        <td>{r.permission_date.slice(0, 10)}</td><td dir="ltr" style={{textAlign:"right"}}>{t5(r.starts_at)}</td><td dir="ltr" style={{textAlign:"right"}}>{t5(r.ends_at)}{t5(r.ends_at)<=t5(r.starts_at)?" +١":""}</td><td>{r.reason}</td>
        <td>{requestStatus[r.status] ?? r.status}{r.review_note ? <small className="me-hint"> · {r.review_note}</small> : null}</td>
        <td>{r.permission_type === "PAID" ? "بمرتب" : r.permission_type === "UNPAID" ? "بدون مرتب" : "—"}</td>
        <td>{r.status === "PENDING" && canRequest && <button className="secondary-btn" onClick={() => cancel(r.id)}>إلغاء</button>}</td>
      </tr>)}
        {rows && !rows.length && <tr><td colSpan={7}>لا توجد أذونات</td></tr>}</tbody></table></div></section>
  </>;
}

function ScheduleTab({ onError }: { onError: (m: string) => void }) {
  const [data, setData] = useState<{ weekly: Weekly[]; exceptions: Exception[] } | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ data: { weekly: Weekly[]; exceptions: Exception[] } }>("/api/me/schedule").then(r => { if (alive) setData(r.data); }).catch(e => { if (alive) onError(e instanceof Error ? e.message : "تعذر تحميل المواعيد"); });
    return () => { alive = false; };
  }, [onError]);
  if (!data) return <div className="card">جارٍ التحميل…</div>;
  const byDay = new Map(data.weekly.map(w => [w.weekday, w]));
  return <>
    <section className="card"><div className="card-header"><h2 className="card-title">مواعيد الأسبوع</h2></div><div className="table-wrap"><table>
      <thead><tr><th>اليوم</th><th>الموعد</th></tr></thead>
      <tbody>{dayNames.map((n, i) => { const w = byDay.get(i); return <tr key={i}><td>{n}</td><td>{!w ? "غير محدد" : w.is_day_off ? "راحة" : t5(w.starts_at) + " – " + t5(w.ends_at)}</td></tr>; })}</tbody></table></div></section>
    <section className="card"><div className="card-header"><h2 className="card-title">إجازات وتعديلات بتاريخ محدد</h2></div><div className="table-wrap"><table>
      <thead><tr><th>من</th><th>إلى</th><th>النوع</th><th>ملاحظة</th></tr></thead>
      <tbody>{data.exceptions.map((x, i) => <tr key={i}><td>{x.start_date}</td><td>{x.end_date}</td><td>{x.is_day_off ? "راحة / إجازة" : t5(x.starts_at) + " – " + t5(x.ends_at)}</td><td>{x.note || "—"}</td></tr>)}
        {!data.exceptions.length && <tr><td colSpan={4}>لا توجد إجازات أو تعديلات مسجلة</td></tr>}</tbody></table></div></section>
  </>;
}
