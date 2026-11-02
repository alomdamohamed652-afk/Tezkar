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
type AllocationDiagnostic = {
  payment: { gross_amount: number; employee_name: string; order_code: string | null; order_name: string | null };
  summary: { paymentAmount: number; legacyAmount: number; orderAmount: number; settlementAmount: number; legacyCount: number; orderCount: number; settlementCount: number; invalidCount: number; overAllocated: boolean; duplicateProductionIds: string[] };
  allocations: Array<{ source: string; production_entry_id: string | null; amount: number | string; production_code: string | null; production_employee_name: string | null; production_order_name: string | null; production_stage_name: string | null; production_status: string | null; validation: string }>;
};
type Order = { id: string; code: string; order_name: string; status: string };
type Stage = { id: string; sequence_no: number; stage_name: string; status: string };
type HistoricalProduction = {
  production_entry_id:string;production_code:string;employee_id:string;employee_code:string;employee_name:string;
  work_date:string;order_code:string|null;order_name:string|null;stage_name:string|null;
  earned_amount:number|string;actual_paid_amount:number|string;historical_paid_amount:number|string;remaining_amount:number|string;overpaid_amount:number|string;
  mark_id:string|null;mark_status:"PAID_PREVIOUSLY"|"NEEDS_REVIEW"|null;mark_notes:string|null;payment_date:string|null;
  ambiguous_payment_evidence:boolean;classification:"PAID_CONFIRMED"|"PAID_HISTORICALLY"|"NEEDS_REVIEW"|"UNPAID";
};
type FinancialIntegrity = {
  checkedAt: string;
  counts: {
    missingPayrollExpenses: number;
    missingAdjustmentLedgerEntries: number;
    cashPaymentsMissingCustodyOut: number;
    payrollPaymentMismatches: number;
    advanceDeductionMismatches: number;
    paidPayrollMissingAdvanceRepayments: number;
    expensesMissingCustodyLink: number;
  };
  issues: {
    missingPayrollExpenses: Array<{ payroll_item_id: string; full_name: string; period_month: string; net_amount: number | string; expense_amount: number | string | null; category: string | null }>;
    missingAdjustmentLedgerEntries: Array<{ adjustment_line_id: string; full_name: string; period_month: string; line_type: string; description: string; amount: number | string }>;
    cashPaymentsMissingCustodyOut: Array<{ payment_id: string; full_name: string; period_month: string; payment_date: string; amount: number | string; reference: string | null; custody_out_count: number; custody_out_amount: number | string; custody_offset_count: number; custody_offset_amount: number | string }>;
    payrollPaymentMismatches: Array<{ payroll_item_id: string; full_name: string; period_month: string; status: string; net_amount: number | string; paid_amount: number | string }>;
    advanceDeductionMismatches: Array<{ payroll_item_id: string; full_name: string; period_month: string; advance_repayment_amount: number | string; allocated_amount: number | string }>;
    paidPayrollMissingAdvanceRepayments: Array<{ payroll_item_id: string; full_name: string; period_month: string; advance_id: string; advance_code: string; amount: number | string }>;
    expensesMissingCustodyLink: Array<{ expense_id: string; description: string; amount: number | string; expense_date: string; employee_name: string | null; custody_movement_count: number; custody_amount: number | string }>;
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
  const [diagnostics, setDiagnostics] = useState<AllocationDiagnostic | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState("");
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
  const [historicalProduction,setHistoricalProduction]=useState<HistoricalProduction[]>([]);
  const [historicalLoading,setHistoricalLoading]=useState(false);
  const [historicalSavingId,setHistoricalSavingId]=useState("");
  const [historicalSearch,setHistoricalSearch]=useState("");
  const [selectedHistoricalIds,setSelectedHistoricalIds]=useState<string[]>([]);
  const [bulkHistoricalSaving,setBulkHistoricalSaving]=useState(false);

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

  const loadHistoricalProduction=useCallback(async()=>{
    setHistoricalLoading(true);
    try{
      const result=await api<{data:HistoricalProduction[]}>("/api/worker-payments/historical-production-settlements");
      setHistoricalProduction(result.data);
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحميل تسويات مستحقات الإنتاج التاريخية");}
    finally{setHistoricalLoading(false);}
  },[]);
  useEffect(() => { if (allowed) { void load(); void loadHistoricalProduction(); } else setLoading(false); }, [allowed, load, loadHistoricalProduction]);
  const historicalEmployeeSummary=useMemo(()=>{
    const grouped=new Map<string,{employeeId:string;employeeCode:string;employeeName:string;production:number;actualPaid:number;historicalPaid:number;unresolvedPaidAmount:number;remaining:number;unresolvedAmount:number;overpaidAmount:number;unresolvedCount:number;productionCount:number}>();
    for(const row of historicalProduction){
      const current=grouped.get(row.employee_id)??{employeeId:row.employee_id,employeeCode:row.employee_code,employeeName:row.employee_name,production:0,actualPaid:0,historicalPaid:0,unresolvedPaidAmount:0,remaining:0,unresolvedAmount:0,overpaidAmount:0,unresolvedCount:0,productionCount:0};
      current.production+=Number(row.earned_amount||0);
      current.overpaidAmount+=Number(row.overpaid_amount||0);
      if(row.classification==="NEEDS_REVIEW"){
        current.unresolvedPaidAmount+=Number(row.actual_paid_amount||0)+Number(row.historical_paid_amount||0);
        current.unresolvedAmount+=Number(row.remaining_amount||0);
        current.unresolvedCount+=1;
      }else{
        current.actualPaid+=Number(row.actual_paid_amount||0);
        current.historicalPaid+=Number(row.historical_paid_amount||0);
        current.remaining+=Number(row.remaining_amount||0);
      }
      current.productionCount+=1;
      grouped.set(row.employee_id,current);
    }
    return [...grouped.values()].sort((a,b)=>a.employeeName.localeCompare(b.employeeName,"ar-EG"));
  },[historicalProduction]);
  const filteredHistoricalProduction=useMemo(()=>{
    const q=historicalSearch.trim().toLocaleLowerCase("ar-EG");
    const rows=historicalProduction.filter(x=>Number(x.remaining_amount)>0.009||x.classification==="NEEDS_REVIEW");
    if(!q)return rows;
    return rows.filter(x=>[x.production_code,x.employee_name,x.employee_code,x.order_name??"",x.order_code??"",x.stage_name??""].join(" ").toLocaleLowerCase("ar-EG").includes(q));
  },[historicalProduction,historicalSearch]);
  const selectableHistoricalRows=useMemo(()=>filteredHistoricalProduction.filter(row=>row.classification==="UNPAID"),[filteredHistoricalProduction]);
  const allVisibleHistoricalSelected=selectableHistoricalRows.length>0&&selectableHistoricalRows.every(row=>selectedHistoricalIds.includes(row.production_entry_id));
  function toggleHistoricalSelection(id:string,checked:boolean){
    setSelectedHistoricalIds(current=>checked?[...new Set([...current,id])]:current.filter(value=>value!==id));
  }
  async function bulkMarkHistoricalPaid(){
    const rows=historicalProduction.filter(row=>selectedHistoricalIds.includes(row.production_entry_id)&&row.classification==="UNPAID");
    if(!rows.length)return;
    const note=window.prompt("اكتب بيان التسوية الجماعية، مع التأكيد أن السجلات المحددة تم سدادها بالفعل:", "تمت مراجعة السجلات والتأكد من سدادها سابقًا");
    if(!note||note.trim().length<2)return;
    const paymentDate=window.prompt("تاريخ السداد السابق (YYYY-MM-DD) — اتركه فارغًا لو غير معروف:","");
    if(paymentDate?.trim()&&!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate.trim())){setError("صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD.");return;}
    if(!window.confirm("تأكيد إثبات السداد التاريخي لعدد "+rows.length+" سجل؟ لن يتم إنشاء قبض نقدي أو حركة عهدة."))return;
    setBulkHistoricalSaving(true);setError("");setSuccess("");
    let completed=0;const failed:Array<{code:string;message:string}>=[];
    try{
      for(const row of rows){
        try{
          await api("/api/worker-payments/historical-production-settlements/"+encodeURIComponent(row.production_entry_id),{
            method:"PATCH",body:JSON.stringify({status:"PAID_PREVIOUSLY",notes:note.trim(),paymentDate:paymentDate?.trim()||null})
          });
          completed++;
        }catch(e){failed.push({code:row.production_code,message:e instanceof Error?e.message:"تعذر تحديث السجل"});}
      }
      setSelectedHistoricalIds([]);
      setSuccess("تم إثبات السداد لـ "+completed+" سجل من أصل "+rows.length+"."+(failed.length?" تعذر تحديث "+failed.length+" سجل؛ لم يتم تجاوزها.":""));
      if(failed.length)setError(failed.slice(0,10).map(item=>item.code+": "+item.message).join(" | "));
      await loadHistoricalProduction();
    }finally{setBulkHistoricalSaving(false);}
  }
  async function updateHistoricalProduction(row:HistoricalProduction,status:"PAID_PREVIOUSLY"|"NEEDS_REVIEW"){
    const note=window.prompt(status==="PAID_PREVIOUSLY"?"اكتب بيانًا يوضح أن مستحق الإنتاج تم دفعه قبل استخدام النظام:":"اكتب سبب إعادة الحالة للمراجعة:",status==="PAID_PREVIOUSLY"?"تم السداد قبل تشغيل النظام":"إعادة للمراجعة");
    if(!note||note.trim().length<2)return;
    const paymentDate=status==="PAID_PREVIOUSLY"?window.prompt("تاريخ السداد السابق (YYYY-MM-DD) — اتركه فارغًا لو غير معروف:",""):null;
    setHistoricalSavingId(row.production_entry_id);setError("");setSuccess("");
    try{
      await api("/api/worker-payments/historical-production-settlements/"+encodeURIComponent(row.production_entry_id),{
        method:"PATCH",body:JSON.stringify({status,notes:note.trim(),paymentDate:paymentDate?.trim()||null})
      });
      setSuccess(status==="PAID_PREVIOUSLY"?"تم إثبات السداد التاريخي. تم تحديث المتبقي من مستحقات الإنتاج فقط، دون إنشاء حركة مالية أو تعديل رصيد العامل.":"تمت إعادة السجل إلى المراجعة؛ لن يُخصم من مستحقات الإنتاج كتسوية تاريخية.");
      await loadHistoricalProduction();
    }catch(e){setError(e instanceof Error?e.message:"تعذر تحديث حالة التسوية التاريخية");}
    finally{setHistoricalSavingId("");}
  }
  useEffect(() => {
    if (!selectedId) { setDiagnostics(null); setDiagnosticsError(""); return; }
    let active = true;
    setDiagnosticsLoading(true);
    setDiagnosticsError("");
    api<{ data: AllocationDiagnostic }>("/api/worker-payments/" + encodeURIComponent(selectedId) + "/historical-allocation-diagnostics")
      .then(result => { if (active) setDiagnostics(result.data); })
      .catch(e => { if (active) setDiagnosticsError(e instanceof Error ? e.message : "تعذر تحميل تفاصيل التوزيع القديم"); })
      .finally(() => { if (active) setDiagnosticsLoading(false); });
    return () => { active = false; };
  }, [selectedId]);
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
      { title: "قيود تعديلات الرواتب غير المطابقة", items: issues.missingAdjustmentLedgerEntries.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · ${x.description} · ${money(Number(x.amount))} ج.م`) },
      { title: "مدفوعات نقدية وحركات عهدة غير متطابقة", items: issues.cashPaymentsMissingCustodyOut.map(x => `${x.full_name} · ${x.payment_date.slice(0, 10)} · ${money(Number(x.amount))} ج.م · حركات العهدة: ${x.custody_out_count}`) },
      { title: "عدم تطابق حالة الراتب مع المدفوع", items: issues.payrollPaymentMismatches.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · الحالة ${x.status} · المدفوع ${money(Number(x.paid_amount))} من ${money(Number(x.net_amount))} ج.م`) },
      { title: "إجمالي خصومات السلف لا يطابق المسير", items: issues.advanceDeductionMismatches.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · المسجل ${money(Number(x.advance_repayment_amount))} · تفاصيل الأقساط ${money(Number(x.allocated_amount))} ج.م`) },
      { title: "رواتب مدفوعة دون تسجيل سداد السلفة", items: issues.paidPayrollMissingAdvanceRepayments.map(x => `${x.full_name} · ${x.period_month.slice(0, 7)} · ${x.advance_code} · ${money(Number(x.amount))} ج.م`) },
      { title: "مصروفات وحركات عهدة غير متطابقة", items: issues.expensesMissingCustodyLink.map(x => `${x.employee_name || "موظف غير محدد"} · ${x.expense_date.slice(0, 10)} · ${x.description} · ${money(Number(x.amount))} ج.م · حركات العهدة: ${x.custody_movement_count}`) }
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
        {allowed && <section className="card">
          <div className="card-header"><div><h2 className="card-title">تسوية مستحقات الإنتاج التاريخية</h2><p className="form-hint">إثبات إداري لسداد قديم فقط؛ لا ينشئ قبضًا أو مصروفًا ولا يغيّر دفتر العامل أو السلف أو العهدة.</p></div><button type="button" className="secondary-btn" onClick={()=>void loadHistoricalProduction()} disabled={historicalLoading}>{historicalLoading?"جارٍ الفحص…":"إعادة الفحص"}</button></div>
          <div className="card-body">
            <input value={historicalSearch} onChange={e=>setHistoricalSearch(e.target.value)} placeholder="ابحث بكود الإنتاج أو العامل أو الطلبية…" />
            {historicalLoading&&<p className="form-hint">جارٍ فحص سجلات الإنتاج وحركات الدفع المرتبطة…</p>}
            <h3 className="card-title" style={{marginTop:16}}>ملخص حساب كل عامل</h3>
            <p className="form-hint">الإجمالي محسوب من سجلات الإنتاج المعتمدة. كل دفعة تُحسب مرة واحدة حتى لو ظهرت في أكثر من مصدر توزيع. الحالات غير المحسومة لا تُحسب مدفوعة ولا تُخصم من المتبقي إلا بعد مراجعتها.</p>
            <div className="table-wrap"><table><thead><tr><th>العامل</th><th>إجمالي الإنتاج</th><th>إجمالي المدفوع</th><th>المتبقي</th><th>حالات غير محسومة</th></tr></thead><tbody>
              {historicalEmployeeSummary.map(row=><tr key={row.employeeId}><td>{row.employeeName}<div className="form-hint">{row.employeeCode} · {row.productionCount} سجل إنتاج</div></td><td>{money(row.production)}</td><td>{money(row.actualPaid+row.historicalPaid)}</td><td>{money(row.remaining)}</td><td>{row.unresolvedCount? <span className="status warning">{row.unresolvedCount} سجل</span> : <span className="status success">لا يوجد</span>}</td></tr>)}
              {!historicalEmployeeSummary.length&&<tr><td colSpan={5}>لا توجد سجلات إنتاج معتمدة.</td></tr>}
            </tbody></table></div>
            <h3 className="card-title" style={{marginTop:20}}>تفاصيل سجلات الإنتاج</h3>
            <div className="form-actions" style={{marginBottom:12}}>
              <button type="button" className="secondary-btn" onClick={()=>setSelectedHistoricalIds(allVisibleHistoricalSelected?[]:selectableHistoricalRows.map(row=>row.production_entry_id))} disabled={!selectableHistoricalRows.length||bulkHistoricalSaving}>{allVisibleHistoricalSelected?"إلغاء تحديد الظاهر":"تحديد كل المستحقات الظاهرة"}</button>
              <span className="form-hint">المحدد: {selectedHistoricalIds.length} سجل</span>
              <button type="button" className="primary-button" onClick={()=>void bulkMarkHistoricalPaid()} disabled={!selectedHistoricalIds.length||bulkHistoricalSaving}>{bulkHistoricalSaving?"جارٍ تنفيذ التسوية…":"إثبات سداد المحدد ("+selectedHistoricalIds.length+")"}</button>
            </div>
            <div className="table-wrap"><table><thead><tr><th><input type="checkbox" aria-label="تحديد كل السجلات المستحقة الظاهرة" checked={allVisibleHistoricalSelected} onChange={e=>setSelectedHistoricalIds(e.target.checked?selectableHistoricalRows.map(row=>row.production_entry_id):[])} disabled={!selectableHistoricalRows.length||bulkHistoricalSaving}/></th><th>سجل الإنتاج</th><th>العامل</th><th>الطلبية / المرحلة</th><th>إجمالي الإنتاج</th><th>إجمالي المدفوع</th><th>المتبقي</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>
              {filteredHistoricalProduction.map(row=><tr key={row.production_entry_id}>
                <td>{row.classification==="UNPAID"?<input type="checkbox" aria-label={"تحديد "+row.production_code} checked={selectedHistoricalIds.includes(row.production_entry_id)} onChange={e=>toggleHistoricalSelection(row.production_entry_id,e.target.checked)} disabled={bulkHistoricalSaving}/>:<span className="form-hint">—</span>}</td>
                <td><strong>{row.production_code}</strong><div className="form-hint">{String(row.work_date).slice(0,10)}</div></td>
                <td>{row.employee_name}<div className="form-hint">{row.employee_code}</div></td>
                <td>{row.order_name||"بدون طلبية"}<div className="form-hint">{row.stage_name||"—"}</div></td>
                <td>{money(Number(row.earned_amount))}</td><td>{money(Number(row.actual_paid_amount)+Number(row.historical_paid_amount))}</td><td>{money(Number(row.remaining_amount))}</td>
                <td><span className={row.classification==="PAID_CONFIRMED"||row.classification==="PAID_HISTORICALLY"?"status success":"status warning"}>{row.classification==="PAID_CONFIRMED"||row.classification==="PAID_HISTORICALLY"?"مدفوع":row.classification==="NEEDS_REVIEW"?"غير محسوم — دفعة محتملة":"مستحق"}</span></td>
                <td>{row.classification==="UNPAID"?<button type="button" className="primary-button" disabled={historicalSavingId===row.production_entry_id} onClick={()=>void updateHistoricalProduction(row,"PAID_PREVIOUSLY")}>{historicalSavingId===row.production_entry_id?"جارٍ الحفظ…":"تسجيل أنه مدفوع"}</button>:row.classification==="PAID_HISTORICALLY"?<button type="button" className="secondary-btn" disabled={historicalSavingId===row.production_entry_id} onClick={()=>void updateHistoricalProduction(row,"NEEDS_REVIEW")}>إلغاء الإثبات</button>:row.classification==="NEEDS_REVIEW"?"راجع الدفعة المحتملة":"—"}</td>
              </tr>)}
              {!historicalLoading&&!filteredHistoricalProduction.length&&<tr><td colSpan={9}>لا توجد سجلات مستحقة أو حالات غير محسومة.</td></tr>}
            </tbody></table></div>
            <p className="form-hint">السجلات التي لها دفعات فعلية غير موزعة بالكامل تُعلَّم «غير محسوم» ولا يسمح النظام بإثباتها كمدفوعة تاريخيًا حتى تتم مراجعة الدفعة.</p>
          </div>
        </section>}
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
          {selected && <section className="card">
            <div className="card-header"><div><h2 className="card-title">تفاصيل التوزيعات القديمة والتحقق منها</h2><p className="form-hint">عرض للقراءة فقط؛ لا يغيّر أي قيد مالي.</p></div></div>
            <div className="card-body">
              {diagnosticsLoading && <p className="form-hint">جارٍ فحص مصادر التوزيع…</p>}
              {diagnosticsError && <div role="alert" className="alert error">{diagnosticsError}</div>}
              {diagnostics && <>
                <div className="stats">
                  <article className="card stat"><div className="stat-label">التوزيع القديم</div><div className="stat-value">{money(diagnostics.summary.legacyAmount)}</div><div className="stat-note">{diagnostics.summary.legacyCount} قيد</div></article>
                  <article className="card stat"><div className="stat-label">توزيع الطلبية</div><div className="stat-value">{money(diagnostics.summary.orderAmount)}</div><div className="stat-note">{diagnostics.summary.orderCount} قيد</div></article>
                  <article className="card stat"><div className="stat-label">تسوية المستحقات</div><div className="stat-value">{money(diagnostics.summary.settlementAmount)}</div><div className="stat-note">{diagnostics.summary.settlementCount} قيد</div></article>
                  <article className="card stat"><div className="stat-label">قيود غير سليمة</div><div className="stat-value">{diagnostics.summary.invalidCount}</div><div className="stat-note">{diagnostics.summary.duplicateProductionIds.length} تكرار داخل نفس مصدر التوزيع</div></article>
                </div>
                {diagnostics.summary.overAllocated && <div role="alert" className="alert error">يوجد مصدر توزيع يتجاوز إجمالي الدفعة. لا تعتمد التوزيع قبل المراجعة.</div>}
                <div className="table-wrap"><table><thead><tr><th>مصدر القيد</th><th>سجل الإنتاج</th><th>العامل المسجل بالإنتاج</th><th>الطلبية / المرحلة</th><th>الحالة</th><th>المبلغ</th></tr></thead><tbody>
                  {diagnostics.allocations.map((a, index) => <tr key={a.source + ":" + a.production_entry_id + ":" + index}>
                    <td>{a.source === "LEGACY" ? "قديم" : a.source === "ORDER" ? "توزيع طلبية" : "تسوية مستحقات"}</td>
                    <td>{a.production_code || a.production_entry_id || "سجل مفقود"}</td>
                    <td>{a.production_employee_name || "غير موجود"}</td>
                    <td>{a.production_order_name || "بدون طلبية"}{a.production_stage_name ? <div className="form-hint">{a.production_stage_name}</div> : null}</td>
                    <td><span className={a.validation === "OK" ? "status success" : "status warning"}>{a.validation === "OK" ? "سليم" : a.validation}</span></td>
                    <td>{money(Number(a.amount))}</td>
                  </tr>)}
                  {!diagnostics.allocations.length && <tr><td colSpan={6}>لا توجد قيود توزيع محفوظة لهذه الدفعة.</td></tr>}
                </tbody></table></div>
              </>}
            </div>
          </section>}
        </>}
      </section>
    </main>
  </div>;
}
