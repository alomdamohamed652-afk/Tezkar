import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

type Severity = "high" | "medium" | "low";
type Finding = { employeeId?: string | null; employeeCode?: string | null; employeeName?: string | null; reference?: string | null; amount: string; detail: string };
type Check = { code: string; title: string; severity: Severity; explanation: string; proposal: string; findings: Finding[] };

const LEDGER_BALANCES = `SELECT employee_id,SUM(credit_amount-debit_amount)::numeric(18,4) AS bal FROM employee_earnings_ledger GROUP BY employee_id`;
const PAYMENT_GROSS = "COALESCE(NULLIF(wp.gross_amount,0),wp.amount)";
// Every allocation row of a worker payment, in all three allocation tables, with what is still un-reversed.
const ALLOCATIONS_OPEN = `
  SELECT x.worker_payment_id, x.production_entry_id, x.amount - COALESCE((
           SELECT SUM(r.amount) FROM worker_payment_allocation_reversals r WHERE r.allocation_source=x.src AND r.source_allocation_id=x.id),0) AS open_amount
    FROM (
      SELECT 'WORKER_PAYMENT_ORDER' AS src,id,worker_payment_id,production_entry_id,amount FROM worker_payment_order_allocations
      UNION ALL SELECT 'WORKER_PAYMENT_LEGACY',id,worker_payment_id,production_entry_id,amount FROM worker_payment_allocations
      UNION ALL SELECT 'EMPLOYEE_EARNINGS_SETTLEMENT',a.id,s.worker_payment_id,a.production_entry_id,a.amount
        FROM employee_earnings_settlement_allocations a JOIN employee_earnings_settlements s ON s.id=a.settlement_id WHERE s.worker_payment_id IS NOT NULL
    ) x`;
const PAYMENT_REVERSED = `SELECT rl.source_id AS payment_id,SUM(rl.amount) AS reversed FROM financial_reversal_lines rl WHERE rl.source_type='WORKER_PAYMENT' GROUP BY rl.source_id`;

const money = (v: unknown) => String(v ?? "0");

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const emp = (r: any): Partial<Finding> => ({ employeeId: r.employee_id, employeeCode: r.employee_code, employeeName: r.employee_name });

  const negative = await pool.query(`
    SELECT b.employee_id,e.code AS employee_code,e.full_name AS employee_name,e.is_active,b.bal::text AS bal,
           EXISTS(SELECT 1 FROM worker_payments wp JOIN (${PAYMENT_REVERSED}) rv ON rv.payment_id=wp.id
                   WHERE wp.employee_id=b.employee_id AND rv.reversed < ${PAYMENT_GROSS}-0.0001) AS has_partial_reversal
      FROM (${LEDGER_BALANCES}) b JOIN employees e ON e.id=b.employee_id
     WHERE b.bal <= -0.01 ORDER BY b.bal LIMIT 500`);
  checks.push({
    code: "NEGATIVE_BALANCE", title: "أرصدة مستحقات سالبة", severity: "high",
    explanation: "رصيد دفتر المستحقات أقل من صفر: العامل مسجل عليه أكثر مما له. غالباً سببه عكس جزء فقط من دفعة قديمة أو ترحيل مكرر.",
    proposal: "راجع حركات العامل أولاً. إذا ثبت أن الفرق سجل تاريخي لا يُسترد فاستخدم «تسوية إدارية غير نقدية» من حساب العامل.",
    findings: negative.rows.map(r => ({ ...emp(r), amount: money(r.bal), detail: `${r.is_active ? "نشط" : "غير نشط"}${r.has_partial_reversal ? " · له عكس جزئي لدفعة" : ""}` }))
  });

  const drift = await pool.query(`
    SELECT b.employee_id,e.code AS employee_code,e.full_name AS employee_name,b.bal::text AS bal
      FROM (${LEDGER_BALANCES}) b JOIN employees e ON e.id=b.employee_id
     WHERE b.bal <> 0 AND abs(b.bal) < 0.01 ORDER BY abs(b.bal) DESC LIMIT 500`);
  checks.push({
    code: "ROUNDING_DRIFT", title: "بواقي تقريب (أقل من قرش)", severity: "low",
    explanation: "رصيد غير صفري لكنه أقل من ١ قرش، ينتج من حسابات بأربع خانات عشرية. يظهر كرصيد وهمي ويمنع إغلاق الحساب.",
    proposal: "تسوية إدارية غير نقدية لتصفير البقية.",
    findings: drift.rows.map(r => ({ ...emp(r), amount: money(r.bal), detail: "باقي تقريب" }))
  });

  const stale = await pool.query(`
    SELECT wp.id AS payment_id,wp.code,wp.employee_id,e.code AS employee_code,e.full_name AS employee_name,
           SUM(a.open_amount)::text AS open_amount,COUNT(*)::int AS lines
      FROM worker_payments wp
      JOIN (${PAYMENT_REVERSED}) rv ON rv.payment_id=wp.id AND rv.reversed >= ${PAYMENT_GROSS}-0.0001
      JOIN (${ALLOCATIONS_OPEN}) a ON a.worker_payment_id=wp.id AND a.open_amount > 0.0001
      JOIN employees e ON e.id=wp.employee_id
     GROUP BY wp.id,wp.code,wp.employee_id,e.code,e.full_name ORDER BY SUM(a.open_amount) DESC LIMIT 500`);
  checks.push({
    code: "STALE_ALLOCATIONS_AFTER_REVERSAL", title: "دفعة معكوسة وتوزيعاتها على الإنتاج ما زالت قائمة", severity: "high",
    explanation: "الدفعة اتعكست مالياً لكن توزيعها على الإنتاج لم يُعكس، فيظهر الإنتاج «مدفوع» رغم إلغاء الدفعة.",
    proposal: "لا يُصلح تلقائياً. تُراجع الدفعة ثم تُسجل حركة عكس توزيع (worker_payment_allocation_reversals) بعد موافقة المالك.",
    findings: stale.rows.map(r => ({ ...emp(r), reference: r.code, amount: money(r.open_amount), detail: `${r.lines} توزيع غير معكوس` }))
  });

  const cancelledPaid = await pool.query(`
    SELECT p.id,p.code AS production_code,p.employee_id,e.code AS employee_code,e.full_name AS employee_name,
           SUM(a.open_amount)::text AS open_amount,string_agg(DISTINCT wp.code,', ') AS payments
      FROM production_entries p
      JOIN (${ALLOCATIONS_OPEN}) a ON a.production_entry_id=p.id AND a.open_amount > 0.0001
      JOIN worker_payments wp ON wp.id=a.worker_payment_id
      JOIN employees e ON e.id=p.employee_id
     WHERE p.status='CANCELLED'
       AND NOT EXISTS(SELECT 1 FROM (${PAYMENT_REVERSED}) rv WHERE rv.payment_id=wp.id AND rv.reversed >= COALESCE(NULLIF(wp.gross_amount,0),wp.amount)-0.0001)
     GROUP BY p.id,p.code,p.employee_id,e.code,e.full_name ORDER BY SUM(a.open_amount) DESC LIMIT 500`);
  checks.push({
    code: "CANCELLED_PAID_PRODUCTION", title: "إنتاج ملغي كان مدفوعاً ولم تُعكس دفعته", severity: "high",
    explanation: "إنتاج اتلغى بعد ما اتدفع، والدفعة ما زالت سارية. المبلغ المدفوع يبقى زائداً على العامل.",
    proposal: "لا يُصلح تلقائياً. القاعدة المطلوبة (عكس كامل أم نصيب الإنتاج فقط) تنتظر قرار المالك؛ حتى ذلك الحين تُراجع كل حالة يدوياً.",
    findings: cancelledPaid.rows.map(r => ({ ...emp(r), reference: `${r.production_code} ← ${r.payments}`, amount: money(r.open_amount), detail: "مدفوع ومُلغى" }))
  });

  const partial = await pool.query(`
    SELECT wp.id,wp.code,wp.employee_id,e.code AS employee_code,e.full_name AS employee_name,
           (${PAYMENT_GROSS}-al.allocated)::text AS missing,al.allocated::text AS allocated,(${PAYMENT_GROSS})::text AS gross
      FROM worker_payments wp
      JOIN employees e ON e.id=wp.employee_id
      JOIN LATERAL (SELECT COALESCE(SUM(open_amount),0) AS allocated FROM (${ALLOCATIONS_OPEN}) a WHERE a.worker_payment_id=wp.id) al ON TRUE
     WHERE NOT EXISTS(SELECT 1 FROM (${PAYMENT_REVERSED}) rv WHERE rv.payment_id=wp.id)
       AND al.allocated > 0.009 AND al.allocated < ${PAYMENT_GROSS}-0.009
     ORDER BY (${PAYMENT_GROSS}-al.allocated) DESC LIMIT 500`);
  checks.push({
    code: "PARTIAL_PAYMENT_HANGING", title: "دفعات موزعة جزئياً فقط", severity: "medium",
    explanation: "جزء من الدفعة موزع على الإنتاج والباقي معلّق بدون توزيع.",
    proposal: "راجع الدفعة وحدد الإنتاج الذي يغطي الباقي، أو سجل الباقي كسلفة/فرق حسب الحالة. لا يُصلح تلقائياً.",
    findings: partial.rows.map(r => ({ ...emp(r), reference: r.code, amount: money(r.missing), detail: `موزع ${r.allocated} من ${r.gross}` }))
  });

  const custodyAmount = await pool.query(`
    SELECT wp.id,wp.code,wp.employee_id,e.code AS employee_code,e.full_name AS employee_name,
           (c.out_total)::text AS custody_out,(${PAYMENT_GROSS}-wp.advance_repayment_amount)::text AS expected_cash
      FROM worker_payments wp JOIN employees e ON e.id=wp.employee_id
      JOIN LATERAL (SELECT COALESCE(SUM(amount),0) AS out_total FROM cash_custody_transactions c WHERE c.source_type='WORKER_PAYMENT' AND c.source_id=wp.id AND c.direction='OUT') c ON c.out_total>0
     WHERE abs(c.out_total-(${PAYMENT_GROSS}-wp.advance_repayment_amount)) > 0.0099
     ORDER BY abs(c.out_total-(${PAYMENT_GROSS}-wp.advance_repayment_amount)) DESC LIMIT 500`);
  const custodyNoReturn = await pool.query(`
    SELECT wp.id,wp.code,wp.employee_id,e.code AS employee_code,e.full_name AS employee_name,c.out_total::text AS custody_out
      FROM worker_payments wp JOIN employees e ON e.id=wp.employee_id
      JOIN (${PAYMENT_REVERSED}) rv ON rv.payment_id=wp.id AND rv.reversed >= ${PAYMENT_GROSS}-0.0001
      JOIN LATERAL (SELECT COALESCE(SUM(amount),0) AS out_total FROM cash_custody_transactions c WHERE c.source_type='WORKER_PAYMENT' AND c.source_id=wp.id AND c.direction='OUT') c ON c.out_total>0
     WHERE NOT EXISTS(SELECT 1 FROM financial_reversal_lines rl JOIN cash_custody_transactions ci ON ci.source_type='FINANCIAL_REVERSAL' AND ci.source_id=rl.reversal_id AND ci.direction='IN'
                       WHERE rl.source_type='WORKER_PAYMENT' AND rl.source_id=wp.id)
     LIMIT 500`);
  const custodyNegative = await pool.query(`
    SELECT c.employee_id,e.code AS employee_code,e.full_name AS employee_name,SUM(CASE WHEN c.direction='IN' THEN c.amount ELSE -c.amount END)::text AS bal
      FROM cash_custody_transactions c JOIN employees e ON e.id=c.employee_id
     GROUP BY c.employee_id,e.code,e.full_name HAVING SUM(CASE WHEN c.direction='IN' THEN c.amount ELSE -c.amount END) < -0.0099 LIMIT 500`);
  checks.push({
    code: "CUSTODY_MISMATCH", title: "عدم تطابق العهدة النقدية مع الدفعات", severity: "high",
    explanation: "حركة العهدة الخارجة لا تساوي النقد الفعلي للدفعة (الإجمالي ناقص سداد السلف)، أو دفعة معكوسة لم يرجع نقدها للعهدة، أو رصيد عهدة سالب.",
    proposal: "لا يُصلح تلقائياً: قارن مع الجرد الفعلي للعهدة ثم سجل حركة عهدة تصحيحية بإذن المالك.",
    findings: [
      ...custodyAmount.rows.map(r => ({ ...emp(r), reference: r.code, amount: money(r.custody_out), detail: `النقد المتوقع ${r.expected_cash}` })),
      ...custodyNoReturn.rows.map(r => ({ ...emp(r), reference: r.code, amount: money(r.custody_out), detail: "دفعة معكوسة ولم يرجع نقدها للعهدة" })),
      ...custodyNegative.rows.map(r => ({ ...emp(r), amount: money(r.bal), detail: "رصيد عهدة نقدية سالب" }))
    ]
  });
  return checks;
}

export async function accountHealthRoutes(app: FastifyInstance) {
  app.get("/api/admin/account-health", { preHandler: [authenticateRequest, requirePermission("admin.account_health.view")] }, async () => {
    const startedAt = new Date();
    // Strictly read-only: every check is a SELECT. Nothing is ever corrected automatically.
    const checks = await runChecks();
    return {
      data: {
        generatedAt: startedAt.toISOString(),
        readOnly: true,
        totals: { checks: checks.length, issues: checks.reduce((n, c) => n + c.findings.length, 0), highSeverityIssues: checks.filter(c => c.severity === "high").reduce((n, c) => n + c.findings.length, 0) },
        checks
      }
    };
  });
}
