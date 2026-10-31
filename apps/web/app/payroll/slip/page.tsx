"use client";

import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { formatMoney } from "../../../lib/format";

type PayrollItem = {
  id: string; employee_id: string; employee_code: string; employee_name: string;
  department_name: string | null; base_salary: string | number; bonus_amount: string | number;
  deduction_amount: string | number; advance_repayment_amount?: string | number;
  net_amount: string | number; paid_amount: string | number; remaining_amount: string | number;
  status: string; notes: string | null;
};
type PayrollData = { period: { id: string; period_month: string; status: string } | null; items: PayrollItem[] };
type AdjustmentLine = { id:string; line_type:"BONUS"|"DEDUCTION"; description:string; amount:string|number; notes:string|null; status?:"ACTIVE"|"VOIDED" };
type AttendanceSnapshotDay = { workedMinutes?:number; overtimeMinutes?:number; lateMinutes?:number; earlyMinutes?:number; status?:string; needsReview?:boolean; scheduledStart?:string|null; scheduledEnd?:string|null };
const money = (v: string | number) => formatMoney(v);
const labels: Record<string, string> = { DRAFT: "مسودة — غير معتمد", APPROVED: "معتمد", CLOSED: "مغلق" };
const statusLabels: Record<string, string> = { UNPAID: "لم يُصرف", PARTIAL: "صُرف جزئيًا", PAID: "مدفوع بالكامل" };

export default function PayrollSlipPage() {
  const [item, setItem] = useState<PayrollItem | null>(null);
  const [periodStatus, setPeriodStatus] = useState("");
  const [adjustments, setAdjustments] = useState<AdjustmentLine[]>([]);
  const [attendanceDays, setAttendanceDays] = useState<AttendanceSnapshotDay[]>([]);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const itemId = params.get("item");
    const selectedMonth = params.get("month") || new Date().toISOString().slice(0, 7);
    setMonth(selectedMonth);
    if (!itemId) { setError("رابط مفردات المرتب غير مكتمل."); setLoading(false); return; }
    let active = true;
    api<{ data: PayrollData }>("/api/payroll?month=" + encodeURIComponent(selectedMonth))
      .then(async result => {
        if (!active) return;
        const found = result.data.items.find(row => row.id === itemId);
        if (!found) { setError("لم يتم العثور على بند المرتب لهذا الشهر. تأكد من اعتماد المسير وصحة الرابط."); return; }
        setItem(found);
        setPeriodStatus(result.data.period?.status || "");
        try {
          const [lines,attendance] = await Promise.all([
            api<{data:AdjustmentLine[]}>("/api/payroll/items/"+encodeURIComponent(itemId)+"/adjustments"),
            api<{data:Array<{snapshotData:AttendanceSnapshotDay}>}>("/api/payroll/items/"+encodeURIComponent(itemId)+"/attendance-snapshot")
          ]);
          if (active) {
            setAdjustments(lines.data.filter(line=>line.status!=="VOIDED"));
            setAttendanceDays(attendance.data.map(row=>row.snapshotData));
          }
        } catch {
          if (active) setError("تعذر تحميل تفاصيل المكافآت والخصومات والحضور. أعد تحميل الصفحة.");
        }
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "تعذر تحميل مفردات المرتب."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  if (loading) return <main className="slip-state" dir="rtl">جارٍ تحميل مفردات المرتب…</main>;
  if (error || !item) return <main className="slip-state" dir="rtl"><p>{error || "تعذر تحميل المستند."}</p><button onClick={() => window.close()}>إغلاق</button></main>;

  const approved = periodStatus === "APPROVED" || periodStatus === "CLOSED";
  const bonusLines = adjustments.filter(line => line.line_type === "BONUS");
  const deductionLines = adjustments.filter(line => line.line_type === "DEDUCTION");
  const totalEarnings = Number(item.base_salary) + bonusLines.reduce((sum,line)=>sum+Number(line.amount),0);
  const totalDeductions = deductionLines.reduce((sum,line)=>sum+Number(line.amount),0) + Number(item.advance_repayment_amount || 0);
  const totalWorkedMinutes = attendanceDays.reduce((sum,day)=>sum+Number(day.workedMinutes??0),0);
  const totalOvertimeMinutes = attendanceDays.reduce((sum,day)=>sum+Number(day.overtimeMinutes??0),0);
  const totalLateMinutes = attendanceDays.reduce((sum,day)=>sum+Number(day.lateMinutes??0),0);
  const totalEarlyMinutes = attendanceDays.reduce((sum,day)=>sum+Number(day.earlyMinutes??0),0);
  const absentDays = attendanceDays.filter(day=>day.status==="ABSENT").length;
  const reviewDays = attendanceDays.filter(day=>day.needsReview||day.status==="MISSING_PUNCH").length;
  const documentNo = "SAL-" + month.replace("-", "") + "-" + item.id.slice(0, 8).toUpperCase();

  return (
    <main className="slip-page" dir="rtl" lang="ar">
      <div className="slip-toolbar no-print">
        <span>معاينة مفردات المرتب · يمكنك اختيار «حفظ بتنسيق PDF» من نافذة الطباعة.</span>
        <button onClick={() => window.print()} disabled={!approved}>طباعة / حفظ PDF</button>
      </div>
      {!approved && <div className="slip-warning no-print">هذا المسير غير معتمد. الطباعة الرسمية متاحة بعد الاعتماد فقط.</div>}
      <article className="salary-slip">
        <header className="slip-header">
          <div className="brand-mark">T</div>
          <div className="brand-copy"><h1>تذكار <span>TEZKAR</span></h1><p>الإدارة المالية والشؤون الإدارية</p></div>
          <div className="slip-title"><h2>مفردات مرتب شهرية</h2><p>شهر {month}</p></div>
        </header>
        <div className="slip-rule" />
        <section className="employee-grid">
          <div><small>اسم الموظف</small><strong>{item.employee_name}</strong></div>
          <div><small>الكود الوظيفي</small><strong>{item.employee_code || "—"}</strong></div>
          <div><small>القسم</small><strong>{item.department_name || "—"}</strong></div>
          <div><small>رقم المستند</small><strong>{documentNo}</strong></div>
          <div><small>تاريخ الإصدار</small><strong>{new Date().toLocaleDateString("ar-EG")}</strong></div>
          <div><small>حالة المسير</small><strong>{labels[periodStatus] || periodStatus}</strong></div>
        </section>

        <section className="slip-section">
          <h3>أولًا: الاستحقاقات</h3>
          <table><thead><tr><th>البيان</th><th>المبلغ (جنيه مصري)</th></tr></thead>
            <tbody>
              <tr><td>الراتب الأساسي</td><td>{money(item.base_salary)}</td></tr>
              {bonusLines.map(line=><tr key={line.id}><td>{line.description}{line.notes?<small className="line-note">{line.notes}</small>:null}</td><td>{money(line.amount)}</td></tr>)}
              {!bonusLines.length && <tr><td>لا توجد مكافآت مسجلة</td><td>{money(0)}</td></tr>}
              <tr className="subtotal"><td>إجمالي الاستحقاقات</td><td>{money(totalEarnings)}</td></tr>
            </tbody>
          </table>
          <p className="slip-note">تفاصيل أنواع المكافآت تظهر في الملاحظات إذا كانت مسجلة. لا يُفترض توزيع مبلغ البونص على أنواع غير مسجلة بالنظام.</p>
        </section>

        <section className="slip-section">
          <h3>ثانيًا: الاستقطاعات</h3>
          <table><thead><tr><th>البيان</th><th>المبلغ (جنيه مصري)</th></tr></thead>
            <tbody>
              {deductionLines.map(line=><tr key={line.id}><td>{line.description}{line.notes?<small className="line-note">{line.notes}</small>:null}</td><td>{money(line.amount)}</td></tr>)}
              {!deductionLines.length && <tr><td>لا توجد خصومات مسجلة</td><td>{money(0)}</td></tr>}
              <tr><td>سداد السلف / أقساط السلف</td><td>{money(item.advance_repayment_amount || 0)}</td></tr>
              <tr className="subtotal"><td>إجمالي الاستقطاعات</td><td>{money(totalDeductions)}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="slip-section">
          <h3>ثالثًا: الوقت والحضور</h3>
          <table><thead><tr><th>البيان</th><th>الإجمالي</th></tr></thead><tbody>
            <tr><td>إجمالي ساعات العمل المسجلة</td><td>{(totalWorkedMinutes/60).toFixed(2)} ساعة</td></tr>
            <tr><td>ساعات العمل الإضافي</td><td>{(totalOvertimeMinutes/60).toFixed(2)} ساعة</td></tr>
            <tr><td>أيام الغياب</td><td>{absentDays} يوم</td></tr>
            <tr><td>دقائق التأخير بعد السماح</td><td>{totalLateMinutes} دقيقة</td></tr>
            <tr><td>دقائق الانصراف المبكر بعد السماح</td><td>{totalEarlyMinutes} دقيقة</td></tr>
            <tr><td>أيام تحتاج مراجعة ولا يطبق عليها خصم تلقائي</td><td>{reviewDays} يوم</td></tr>
          </tbody></table>
        </section>

        <section className="slip-section">
          <h3>رابعًا: التسويات السابقة</h3>
          <div className="settlement-box">
            <div><span>تسويات أو دفعات تخص فترات سابقة</span><strong>تُعرض منفصلة عن صافي الشهر</strong></div>
            <p>لا يوجد في بيانات هذا المسير مبلغ تسوية سابق مستقل مرتبط ببند المرتب. لا تُخصم أي دفعة قديمة مرة أخرى؛ يجب ربطها بسجلها الأصلي أو تسجيلها كتسوية معتمدة مستقلة قبل إظهار مبلغ هنا.</p>
          </div>
        </section>

        <section className="net-box">
          <div><span>صافي المرتب المستحق لهذا الشهر</span><strong>{money(item.net_amount)} ج.م</strong></div>
          <div className="net-sub"><span>تم صرفه</span><strong>{money(item.paid_amount)} ج.م</strong><span>المتبقي للصرف</span><strong>{money(item.remaining_amount)} ج.م</strong></div>
          <p>حالة الصرف: {statusLabels[item.status] || item.status}</p>
        </section>

        {item.notes && <section className="slip-section"><h3>ملاحظات الإدارة</h3><p className="notes-box">{item.notes}</p></section>}

        <footer className="slip-footer">
          <div><strong>إقرار الموظف</strong><p>أقر باستلام نسخة من مفردات المرتب الموضحة أعلاه.</p><span>الاسم والتوقيع: __________________</span></div>
          <div><strong>اعتماد الإدارة المالية</strong><p>مستند داخلي صادر من نظام تذكار.</p><span>التوقيع والختم: __________________</span></div>
        </footer>
        <div className="slip-bottom">شركة تذكار · مستند مالي داخلي · رقم المستند {documentNo}</div>
      </article>
      <style jsx global>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #eef2f6; color: #172b45; font-family: Arial, Tahoma, sans-serif; }
        .slip-page { padding: 24px; min-height: 100vh; }
        .slip-toolbar { max-width: 900px; margin: 0 auto 16px; display: flex; justify-content: space-between; align-items: center; gap: 16px; color: #46566b; font-size: 14px; }
        .slip-toolbar button, .slip-state button { background: #174a7e; color: white; border: 0; border-radius: 7px; padding: 11px 18px; font-weight: 700; cursor: pointer; }
        .slip-toolbar button:disabled { opacity: .45; cursor: not-allowed; }
        .slip-warning { max-width: 900px; margin: 0 auto 12px; background: #fff4d7; border: 1px solid #e9c96d; padding: 12px; border-radius: 8px; }
        .salary-slip { max-width: 900px; margin: 0 auto; background: white; padding: 34px 38px; border: 1px solid #dce3eb; box-shadow: 0 8px 28px #193b5b12; }
        .slip-header { display: flex; align-items: center; gap: 14px; }
        .brand-mark { width: 54px; height: 54px; border-radius: 10px; display: grid; place-items: center; color: white; background: #174a7e; font-size: 31px; font-weight: 800; }
        .brand-copy { flex: 1; }
        .brand-copy h1 { margin: 0; font-size: 25px; color: #123f6b; }
        .brand-copy h1 span { font-size: 13px; letter-spacing: 2px; margin-right: 7px; color: #27866c; }
        .brand-copy p, .slip-title p { margin: 6px 0 0; color: #65758a; font-size: 12px; }
        .slip-title { text-align: left; }
        .slip-title h2 { margin: 0; color: #174a7e; font-size: 21px; }
        .slip-rule { height: 4px; margin: 22px 0; background: linear-gradient(90deg,#27866c 0 18%,#174a7e 18% 100%); }
        .employee-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); border: 1px solid #dce5ee; border-radius: 8px; overflow: hidden; }
        .employee-grid div { padding: 12px 14px; border-left: 1px solid #e4eaf0; border-bottom: 1px solid #e4eaf0; min-width: 0; }
        .employee-grid small { display: block; color: #6b7b8d; margin-bottom: 7px; font-size: 11px; }
        .employee-grid strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
        .slip-section { margin-top: 23px; }
        .slip-section h3 { margin: 0 0 10px; font-size: 15px; color: #174a7e; border-right: 3px solid #27866c; padding-right: 9px; }
        .slip-section table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .slip-section th { text-align: right; background: #f0f5f9; color: #26425f; font-weight: 700; }
        .slip-section td, .slip-section th { padding: 10px 12px; border: 1px solid #dce5ee; }
        .slip-section td:last-child, .slip-section th:last-child { text-align: left; width: 34%; font-variant-numeric: tabular-nums; }
        .subtotal td { font-weight: 800; background: #f7fafc; }
        .slip-note { margin: 7px 0 0; color: #718096; font-size: 11px; }\n        .line-note { display:block; color:#718096; margin-top:4px; font-size:10px; }
        .settlement-box { border: 1px solid #dce5ee; border-radius: 7px; padding: 13px; background: #fbfcfd; }
        .settlement-box div { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
        .settlement-box p { margin: 10px 0 0; color: #65758a; font-size: 11px; line-height: 1.7; }
        .net-box { margin-top: 24px; padding: 18px; background: #edf5fa; border: 1px solid #c7d9e7; border-right: 5px solid #174a7e; border-radius: 8px; }
        .net-box > div:first-child { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
        .net-box > div:first-child span { font-weight: 700; }
        .net-box > div:first-child strong { color: #174a7e; font-size: 25px; }
        .net-sub { display: flex; align-items: center; gap: 9px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #d2e0ea; font-size: 12px; }
        .net-sub strong { margin-left: 12px; }
        .net-box p { margin: 9px 0 0; color: #5d7184; font-size: 11px; }
        .notes-box { white-space: pre-wrap; border: 1px solid #e1e8ef; padding: 12px; border-radius: 6px; font-size: 12px; line-height: 1.7; }
        .slip-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; margin-top: 34px; }
        .slip-footer > div { min-height: 95px; }
        .slip-footer strong { font-size: 13px; }
        .slip-footer p, .slip-footer span { font-size: 11px; color: #65758a; line-height: 1.8; }
        .slip-bottom { border-top: 1px solid #dce5ee; margin-top: 22px; padding-top: 10px; text-align: center; color: #8190a1; font-size: 10px; }
        .slip-state { padding: 40px; text-align: center; font-family: Arial,Tahoma,sans-serif; }
        @media (max-width: 700px) { .slip-page { padding: 8px; } .salary-slip { padding: 18px 14px; } .employee-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .slip-header { flex-wrap: wrap; } .slip-title { width: 100%; text-align: right; } .slip-footer { gap: 15px; } .net-sub { flex-wrap: wrap; } }
        @page { size: A4; margin: 12mm; }
        @media print {
          body { background: white; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          .slip-page { padding: 0; min-height: 0; }
          .no-print { display: none !important; }
          .salary-slip { max-width: none; border: 0; box-shadow: none; padding: 0; }
          .slip-section, .net-box, .employee-grid, .slip-footer { break-inside: avoid; }
        }
      `}</style>
    </main>
  );
}
