"use client";

import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { usePermissions } from "../../../components/session-provider";
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
type OwnSlip = PayrollItem & { period_month:string; period_status:string; lines:AdjustmentLine[] };
type Calculation = { month?:string; capturedAt?:string|null; policy?:{workDaysPerMonth?:number;dailyWorkMinutes?:number;dayOffPayAmount?:number;overtimeMultiplier?:number}; minuteRate?:number; lateMinutes?:number; earlyMinutes?:number; paidPermissionMinutes?:number; unpaidPermissionMinutes?:number; absenceMinutes?:number; deductionMinutes?:number; overtimeMinutes?:number; dayOffWorkedMinutes?:number; deductionAmount?:number; overtimeBonus?:number; dayOffBonus?:number };
const money = (v: string | number) => formatMoney(v);
const labels: Record<string, string> = { DRAFT: "مسودة — غير معتمد", APPROVED: "معتمد", CLOSED: "مغلق" };
const statusLabels: Record<string, string> = { UNPAID: "لم يُصرف", PARTIAL: "صُرف جزئيًا", PAID: "مدفوع بالكامل", REVERSED: "تم عكس التسوية" };

export default function PayrollSlipPage() {
  const { permissions, has } = usePermissions();
  const [item, setItem] = useState<PayrollItem | null>(null);
  const [periodStatus, setPeriodStatus] = useState("");
  const [adjustments, setAdjustments] = useState<AdjustmentLine[]>([]);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [calculation, setCalculation] = useState<Calculation | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (permissions === null) return;
    const params = new URLSearchParams(window.location.search);
    const itemId = params.get("item");
    const selectedMonth = params.get("month") || new Date().toISOString().slice(0, 7);
    setMonth(selectedMonth);
    if (!itemId) { setError("رابط مفردات المرتب غير مكتمل."); setLoading(false); return; }
    let active = true;
    if (!has("payroll.view")) {
      // Employees open only their own approved slip, through the own-scoped endpoint.
      api<{ data: OwnSlip[] }>("/api/me/payslips")
        .then(result => {
          if (!active) return;
          const found = result.data.find(row => row.id === itemId);
          if (!found) { setError("لم يتم العثور على مفردات المرتب. تأكد من الرابط."); return; }
          setItem(found);
          setMonth(found.period_month.slice(0, 7));
          setPeriodStatus(found.period_status);
          setAdjustments(found.lines);
          api<{ data: { calculation: Calculation | null; capturedAt: string | null } }>("/api/me/payslips/" + encodeURIComponent(itemId) + "/calculation")
            .then(calc => { if (active) setCalculation(calc.data.calculation ? { ...calc.data.calculation, capturedAt: calc.data.capturedAt } : null); })
            .catch(() => {});
        })
        .catch(e => { if (active) setError(e instanceof Error ? e.message : "تعذر تحميل مفردات المرتب."); })
        .finally(() => { if (active) setLoading(false); });
      return () => { active = false; };
    }
    api<{ data: PayrollData }>("/api/payroll?month=" + encodeURIComponent(selectedMonth))
      .then(async result => {
        if (!active) return;
        const found = result.data.items.find(row => row.id === itemId);
        if (!found) { setError("لم يتم العثور على بند المرتب لهذا الشهر. تأكد من اعتماد المسير وصحة الرابط."); return; }
        setItem(found);
        setPeriodStatus(result.data.period?.status || "");
        try {
          const snapshot = await api<{data:{calculation:Calculation|null}}>("/api/payroll/items/"+encodeURIComponent(itemId)+"/attendance-snapshot");
          if (active) setCalculation(snapshot.data.calculation);
        } catch { /* older items may have no frozen calculation */ }
        try {
          const lines = await api<{data:AdjustmentLine[]}>("/api/payroll/items/"+encodeURIComponent(itemId)+"/adjustments");
          // Cancelled (VOIDED) lines stay in the audit trail but never print on the slip.
          if (active) setAdjustments(lines.data.filter(line => line.status !== "VOIDED"));
        } catch {
          if (active) setError("تعذر تحميل تفاصيل المكافآت والخصومات. أعد تحميل الصفحة.");
        }
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "تعذر تحميل مفردات المرتب."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [permissions]);

  if (loading) return <main className="slip-state" dir="rtl">جارٍ تحميل مفردات المرتب…</main>;
  if (error || !item) return <main className="slip-state" dir="rtl"><p>{error || "تعذر تحميل المستند."}</p><button onClick={() => window.close()}>إغلاق</button></main>;

  const approved = periodStatus === "APPROVED" || periodStatus === "CLOSED";
  const bonusLines = adjustments.filter(line => line.line_type === "BONUS");
  const deductionLines = adjustments.filter(line => line.line_type === "DEDUCTION");
  const totalEarnings = Number(item.base_salary) + bonusLines.reduce((sum,line)=>sum+Number(line.amount),0);
  const totalDeductions = deductionLines.reduce((sum,line)=>sum+Number(line.amount),0) + Number(item.advance_repayment_amount || 0);
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
          <img className="slip-logo" src="/tezkar-logo.png" alt="شعار تذكار" />
          <div className="brand-copy"><h1>تذكار <span>TEZKAR</span></h1><p>الإدارة المالية والشؤون الإدارية</p></div>
          <div className="slip-title"><h2>مفردات مرتب شهرية</h2><p className="month-pill">شهر {month}</p></div>
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

        <section className="summary-strip">
          <div className="summary-cell earn"><small>إجمالي الاستحقاقات</small><strong>{money(totalEarnings)} ج.م</strong></div>
          <div className="summary-cell deduct"><small>إجمالي الاستقطاعات</small><strong>{money(totalDeductions)} ج.م</strong></div>
          <div className="summary-cell net"><small>صافي المرتب المستحق</small><strong>{money(item.net_amount)} ج.م</strong></div>
        </section>

        <section className="slip-section">
          <h3>أولًا: الاستحقاقات</h3>
          <div className="table-card">
          <table><thead><tr><th>البيان</th><th>المبلغ (جنيه مصري)</th></tr></thead>
            <tbody>
              <tr><td>الراتب الأساسي</td><td>{money(item.base_salary)}</td></tr>
              {bonusLines.map(line=><tr key={line.id}><td>{line.description}{line.notes?<small className="line-note">{line.notes}</small>:null}</td><td>{money(line.amount)}</td></tr>)}
              {!bonusLines.length && <tr><td>لا توجد مكافآت مسجلة</td><td>{money(0)}</td></tr>}
              <tr className="subtotal"><td>إجمالي الاستحقاقات</td><td>{money(totalEarnings)}</td></tr>
            </tbody>
          </table>
          </div>
          <p className="slip-note">تفاصيل أنواع المكافآت تظهر في الملاحظات إذا كانت مسجلة. لا يُفترض توزيع مبلغ البونص على أنواع غير مسجلة بالنظام.</p>
        </section>

        <section className="slip-section">
          <h3>ثانيًا: الاستقطاعات</h3>
          <div className="table-card">
          <table><thead><tr><th>البيان</th><th>المبلغ (جنيه مصري)</th></tr></thead>
            <tbody>
              {deductionLines.map(line=><tr key={line.id}><td>{line.description}{line.notes?<small className="line-note">{line.notes}</small>:null}</td><td>{money(line.amount)}</td></tr>)}
              {!deductionLines.length && <tr><td>لا توجد خصومات مسجلة</td><td>{money(0)}</td></tr>}
              <tr><td>سداد السلف / أقساط السلف</td><td>{money(item.advance_repayment_amount || 0)}</td></tr>
              <tr className="subtotal"><td>إجمالي الاستقطاعات</td><td>{money(totalDeductions)}</td></tr>
            </tbody>
          </table>
          </div>
        </section>

        <section className="slip-section">
          <h3>ثالثًا: التسويات السابقة</h3>
          <div className="settlement-box">
            <div><span>تسويات أو دفعات تخص فترات سابقة</span><strong>تُعرض منفصلة عن صافي الشهر</strong></div>
            <p>لا يوجد في بيانات هذا المسير مبلغ تسوية سابق مستقل مرتبط ببند المرتب. لا تُخصم أي دفعة قديمة مرة أخرى؛ يجب ربطها بسجلها الأصلي أو تسجيلها كتسوية معتمدة مستقلة قبل إظهار مبلغ هنا.</p>
          </div>
        </section>

        {calculation && <section className="slip-section">
          <h3>كيف يُحسب مرتبك؟</h3>
          <div className="table-card">
          <table><tbody>
            <tr><td>الراتب الأساسي الشهري{calculation.policy?.workDaysPerMonth?<small className="line-note">{"على أساس "+calculation.policy.workDaysPerMonth+" يوم عمل في الشهر × "+(calculation.policy.dailyWorkMinutes??"—")+" دقيقة عمل في اليوم"}</small>:null}</td><td>{money(item.base_salary)}</td></tr>
            {calculation.minuteRate!=null && <tr><td>سعر الدقيقة المحتسبة<small className="line-note">الراتب الأساسي ÷ إجمالي دقائق العمل المقررة في الشهر</small></td><td>{Number(calculation.minuteRate).toLocaleString("ar-EG",{maximumFractionDigits:4})} ج.م</td></tr>}
            <tr><td>خصم الحضور (تأخير + انصراف مبكر + إذن غير مدفوع + غياب)<small className="line-note">{`تأخير ${calculation.lateMinutes??0} د · انصراف مبكر ${calculation.earlyMinutes??0} د · إذن غير مدفوع ${calculation.unpaidPermissionMinutes??0} د · غياب ${calculation.absenceMinutes??0} د`}</small></td><td>{money(calculation.deductionAmount??0)}</td></tr>
            <tr><td>مقابل الوقت الإضافي<small className="line-note">{`${calculation.overtimeMinutes??0} دقيقة × سعر الدقيقة × معامل ${calculation.policy?.overtimeMultiplier??"—"}`}</small></td><td>{money(calculation.overtimeBonus??0)}</td></tr>
            <tr><td>مقابل العمل في أيام الراحة والإجازات<small className="line-note">{`${calculation.dayOffWorkedMinutes??0} دقيقة عمل؛ أجر اليوم الكامل ${calculation.policy?.dayOffPayAmount??"—"} ج.م على أساس ${calculation.policy?.dailyWorkMinutes??"—"} دقيقة`}</small></td><td>{money(calculation.dayOffBonus??0)}</td></tr>
          </tbody></table>
          </div>
          <p className="slip-note">هذه الأرقام مجمدة وقت اعتماد المسير{calculation.capturedAt?" ("+new Date(calculation.capturedAt).toLocaleString("ar-EG")+")":""} ولا تتغير بأي تعديل لاحق في الحضور. تظهر قيمتها ضمن بنود الاستحقاقات والاستقطاعات أعلاه.</p>
        </section>}

        <section className="net-box">
          <div><span>صافي المرتب المستحق لهذا الشهر</span><strong>{money(item.net_amount)} ج.م</strong></div>
          <div className="net-sub"><span>تم صرفه</span><strong>{money(item.paid_amount)} ج.م</strong><span>المتبقي للصرف</span><strong>{money(item.remaining_amount)} ج.م</strong></div>
          <p>حالة الصرف: {item.status==="PAID"&&Number(item.net_amount)<=0.0001?"تمت التسوية دون صرف نقدي":statusLabels[item.status] || item.status}</p>
        </section>

        {item.notes && <section className="slip-section"><h3>ملاحظات الإدارة</h3><p className="notes-box">{item.notes}</p></section>}

        <footer className="slip-footer">
          <div className="sign-box"><strong>إقرار الموظف</strong><p>أقر باستلام نسخة من مفردات المرتب الموضحة أعلاه.</p><span className="sign-line">الاسم والتوقيع</span></div>
          <div className="sign-box"><strong>اعتماد الإدارة المالية</strong><p>مستند داخلي صادر من نظام تذكار.</p><span className="sign-line">التوقيع والختم</span></div>
        </footer>
        <div className="slip-bottom">شركة تذكار · مستند مالي داخلي · رقم المستند {documentNo}</div>
      </article>
      <style jsx global>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #e9eef4; color: #172b45; font-family: "IBM Plex Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif; }
        .slip-page { padding: 28px 20px 40px; min-height: 100vh; }
        .slip-toolbar { max-width: 880px; margin: 0 auto 16px; display: flex; justify-content: space-between; align-items: center; gap: 16px; color: #46566b; font-size: 14px; }
        .slip-toolbar button, .slip-state button { background: #174a7e; color: white; border: 0; border-radius: 8px; padding: 11px 20px; font-weight: 700; cursor: pointer; font-family: inherit; }
        .slip-toolbar button:disabled { opacity: .45; cursor: not-allowed; }
        .slip-warning { max-width: 880px; margin: 0 auto 12px; background: #fff4d7; border: 1px solid #e9c96d; padding: 12px 14px; border-radius: 8px; }
        .salary-slip { max-width: 880px; margin: 0 auto; background: white; padding: 40px 44px 30px; border: 1px solid #d7e0ea; border-radius: 12px; box-shadow: 0 10px 32px #193b5b14; }
        .slip-header { display: flex; align-items: center; gap: 18px; }
        .slip-logo { width: 78px; height: 78px; object-fit: contain; flex: 0 0 78px; }
        .brand-copy { flex: 1; min-width: 0; }
        .brand-copy h1 { margin: 0; font-size: 27px; font-weight: 700; color: #123f6b; }
        .brand-copy h1 span { font-size: 13px; font-weight: 600; letter-spacing: 2.5px; margin-right: 8px; color: #27866c; }
        .brand-copy p { margin: 6px 0 0; color: #55677c; font-size: 14px; }
        .slip-title { text-align: left; flex: 0 0 auto; }
        .slip-title h2 { margin: 0; color: #174a7e; font-size: 21px; font-weight: 700; }
        .slip-title p { margin: 6px 0 0; color: #55677c; font-size: 13.5px; }
        .month-pill { display: inline-block; background: #eef4fa; border: 1px solid #d4e2ef; color: #174a7e !important; font-weight: 600; border-radius: 999px; padding: 4px 14px; margin-top: 8px !important; }
        .slip-rule { height: 4px; margin: 20px 0 24px; border-radius: 2px; background: linear-gradient(90deg,#27866c 0 18%,#174a7e 18% 100%); }
        .employee-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); border: 1px solid #dbe4ee; border-radius: 10px; overflow: hidden; background: #fbfdfe; }
        .employee-grid div { padding: 13px 16px; border-left: 1px solid #e4eaf0; border-bottom: 1px solid #e4eaf0; min-width: 0; }
        .employee-grid small { display: block; color: #5f7186; margin-bottom: 6px; font-size: 12px; font-weight: 600; letter-spacing: .2px; }
        .employee-grid strong { display: block; font-size: 15px; color: #172b45; overflow-wrap: anywhere; }
        .summary-strip { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; margin-top: 18px; }
        .summary-cell { border: 1px solid #dbe4ee; border-radius: 10px; padding: 12px 16px; background: #fff; }
        .summary-cell small { display: block; color: #5f7186; font-size: 12.5px; font-weight: 600; margin-bottom: 5px; }
        .summary-cell strong { display: block; font-size: 19px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .summary-cell.earn strong { color: #1c6e4a; }
        .summary-cell.deduct strong { color: #b23c3c; }
        .summary-cell.net { background: #edf5fa; border-color: #c7d9e7; }
        .summary-cell.net strong { color: #174a7e; }
        .slip-section { margin-top: 24px; }
        .slip-section h3 { margin: 0 0 10px; font-size: 17px; font-weight: 700; color: #174a7e; border-right: 3px solid #27866c; padding-right: 10px; }
        .table-card { border: 1px solid #dbe4ee; border-radius: 10px; overflow: hidden; }
        .slip-section table { width: 100%; min-width: 0; border-collapse: collapse; font-size: 15px; }
        .slip-section th { text-align: right; background: #eaf1f8; color: #174a7e; font-weight: 700; font-size: 14px; }
        .slip-section td, .slip-section th { padding: 11px 14px; border: 1px solid #dbe4ee; border-top: 0; white-space: normal; }
        .slip-section tr td:first-child, .slip-section tr th:first-child { border-right: 0; }
        .slip-section td:last-child, .slip-section th:last-child { text-align: left; border-left: 0; width: 30%; font-weight: 600; color: #123f6b; }
        .slip-section tbody tr:nth-child(even) td { background: #f8fbfd; }
        .subtotal td { font-weight: 800 !important; background: #edf4fa !important; color: #174a7e !important; border-top: 2px solid #c7d9e7 !important; }
        .slip-note { margin: 8px 2px 0; color: #5d7080; font-size: 12.5px; line-height: 1.7; }
        .line-note { display: block; color: #5d7080; margin-top: 4px; font-size: 12px; font-weight: 400; line-height: 1.6; }
        .settlement-box { border: 1px solid #dbe4ee; border-radius: 10px; padding: 14px 16px; background: #fbfcfd; }
        .settlement-box div { display: flex; justify-content: space-between; gap: 12px; font-size: 14.5px; }
        .settlement-box p { margin: 10px 0 0; color: #55677c; font-size: 12.5px; line-height: 1.8; }
        .net-box { margin-top: 26px; padding: 20px 22px; background: #edf5fa; border: 1px solid #c7d9e7; border-right: 5px solid #174a7e; border-radius: 10px; }
        .net-box > div:first-child { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
        .net-box > div:first-child span { font-weight: 700; font-size: 16.5px; color: #123f6b; }
        .net-box > div:first-child strong { color: #174a7e; font-size: 27px; font-weight: 800; font-variant-numeric: tabular-nums; }
        .net-sub { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding-top: 13px; border-top: 1px solid #d2e0ea; font-size: 14px; color: #3d5064; }
        .net-sub strong { margin-left: 14px; font-variant-numeric: tabular-nums; color: #123f6b; }
        .net-box p { margin: 10px 0 0; color: #4d6175; font-size: 13px; }
        .notes-box { white-space: pre-wrap; border: 1px solid #e1e8ef; padding: 13px 15px; border-radius: 8px; font-size: 14px; line-height: 1.8; background: #fbfdfe; }
        .slip-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; }
        .sign-box { border: 1px dashed #c3cfdb; border-radius: 10px; padding: 14px 16px 18px; min-height: 110px; display: flex; flex-direction: column; }
        .sign-box strong { font-size: 15px; color: #123f6b; }
        .sign-box p { font-size: 12.5px; color: #55677c; line-height: 1.8; margin: 6px 0 0; }
        .sign-line { margin-top: auto; padding-top: 18px; font-size: 12.5px; color: #67788c; border-top: 0; position: relative; }
        .sign-line::after { content: ""; position: absolute; right: 0; top: 8px; width: 170px; border-top: 1.5px dotted #9fb0c2; }
        .slip-bottom { border-top: 1px solid #dbe4ee; margin-top: 24px; padding-top: 12px; text-align: center; color: #67788c; font-size: 12px; }
        .slip-state { padding: 40px; text-align: center; font-family: "IBM Plex Sans Arabic", Arial, Tahoma, sans-serif; }
        @media (max-width: 700px) { .slip-page { padding: 8px; } .salary-slip { padding: 20px 16px; } .employee-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } .summary-strip { grid-template-columns: 1fr; } .slip-header { flex-wrap: wrap; } .slip-title { width: 100%; text-align: right; } .slip-footer { gap: 15px; } .net-sub { flex-wrap: wrap; } }
        @page { size: A4; margin: 12mm; }
        @media print {
          @page { size: A4; margin: 10mm; }
          body { background: white; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
          .slip-page { padding: 0; min-height: 0; }
          .no-print { display: none !important; }
          .salary-slip { max-width: 186mm; width: 186mm; margin: 0 auto; border: 0; border-radius: 0; box-shadow: none; padding: 0; overflow: hidden; }
          .slip-section, .net-box, .employee-grid, .summary-strip, .slip-footer { break-inside: avoid; }
          .slip-logo { width: 50px; height: 50px; flex-basis: 50px; }
          .slip-header { gap: 12px; }
          .brand-copy p { margin-top: 2px; }
          .slip-rule { margin: 6px 0 8px; }
          .month-pill { margin-top: 4px !important; padding: 2px 12px; }
          .employee-grid div { padding: 5px 12px; }
          .employee-grid small { margin-bottom: 2px; }
          .summary-strip { margin-top: 10px; gap: 10px; }
          .summary-cell { padding: 5px 12px; }
          .summary-cell small { margin-bottom: 2px; }
          .slip-section { margin-top: 6px; }
          .slip-section h3 { margin-bottom: 5px; }
          .slip-section td, .slip-section th { padding: 6px 12px; }
          .slip-note { margin-top: 4px; line-height: 1.5; }
          .line-note { margin-top: 2px; line-height: 1.5; }
          .settlement-box { padding: 8px 14px; }
          .settlement-box p { margin-top: 6px; line-height: 1.55; }
          .net-box { margin-top: 8px; padding: 8px 16px; }
          .net-sub { margin-top: 6px; padding-top: 6px; }
          .net-box p { margin-top: 4px; }
          .slip-footer { margin-top: 6px; gap: 16px; }
          .sign-box { padding: 6px 14px 8px; min-height: 0; }
          .sign-box p { line-height: 1.5; margin-top: 4px; }
          .sign-line { padding-top: 4px; }
          .brand-copy h1 { font-size: 22px; }
          .slip-title h2 { font-size: 19px; }
          .slip-bottom { margin-top: 4px; padding-top: 4px; }
        }
      `}</style>
    </main>
  );
}
