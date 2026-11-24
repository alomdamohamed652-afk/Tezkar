import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { writeAudit } from "../audit/audit.service.js";
import { hasPermission } from "../rbac/rbac.service.js";
import { executeFinancialReversal, type FinancialReversalActor } from "../accounting/financial-reversal.service.js";

type Alloc = { paymentId: string; amount: number };

function deterministicUuid(seed: string) {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Called inside the production-reversal transaction, after the production row is CANCELLED.
 * Never recomputes at today's prices: it only uses the allocation amounts recorded at payment time.
 * - All production of a payment cancelled, nothing else in the payment, no earlier reversal, payment not from previous custody,
 *   actor allowed to reverse payments -> reverse the whole payment in the same transaction (savepoint-protected).
 * - Anything else -> an OPEN review row. Nothing is guessed.
 */
export async function settlePaidShareOnCancellation(
  client: PoolClient,
  input: { productionEntryId: string; employeeId: string; reason: string; actor: FinancialReversalActor }
) {
  const allocs = (await client.query(
    `SELECT worker_payment_id AS payment_id, SUM(amount)::float8 AS amount FROM (
       SELECT worker_payment_id, amount FROM worker_payment_order_allocations WHERE production_entry_id=$1
       UNION ALL SELECT worker_payment_id, amount FROM worker_payment_allocations WHERE production_entry_id=$1
       UNION ALL SELECT s.worker_payment_id, a.amount FROM employee_earnings_settlement_allocations a
                 JOIN employee_earnings_settlements s ON s.id=a.settlement_id WHERE a.production_entry_id=$1 AND s.worker_payment_id IS NOT NULL
     ) x GROUP BY worker_payment_id`,
    [input.productionEntryId]
  )).rows.map((r: { payment_id: string; amount: number }) => ({ paymentId: r.payment_id, amount: Number(r.amount) })) as Alloc[];

  const canReverse = await hasPermission(client, input.actor.userId, "finance.reversals.create");
  const outcomes: Array<{ paymentId: string; status: "AUTO_REVERSED" | "OPEN"; reasonCode: string }> = [];

  for (const alloc of allocs) {
    const payment = (await client.query(
      "SELECT id,employee_id,gross_amount::float8 AS gross,settlement_source FROM worker_payments WHERE id=$1 FOR UPDATE", [alloc.paymentId]
    )).rows[0];
    if (!payment) continue;
    const others = (await client.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float8 AS total FROM (
         SELECT production_entry_id, amount FROM worker_payment_order_allocations WHERE worker_payment_id=$1
         UNION ALL SELECT production_entry_id, amount FROM worker_payment_allocations WHERE worker_payment_id=$1
         UNION ALL SELECT a.production_entry_id, a.amount FROM employee_earnings_settlement_allocations a
                   JOIN employee_earnings_settlements s ON s.id=a.settlement_id WHERE s.worker_payment_id=$1
       ) y JOIN production_entries pe ON pe.id=y.production_entry_id WHERE pe.status<>'CANCELLED'`, [alloc.paymentId]
    )).rows[0];
    const allocatedTotal = Number((await client.query(
      `SELECT COALESCE(SUM(amount),0)::float8 AS t FROM (
         SELECT amount FROM worker_payment_order_allocations WHERE worker_payment_id=$1
         UNION ALL SELECT amount FROM worker_payment_allocations WHERE worker_payment_id=$1
         UNION ALL SELECT a.amount FROM employee_earnings_settlement_allocations a
                   JOIN employee_earnings_settlements s ON s.id=a.settlement_id WHERE s.worker_payment_id=$1) z`, [alloc.paymentId])).rows[0].t);
    const priorReversal = Number((await client.query(
      "SELECT COALESCE(SUM(amount),0)::float8 AS t FROM financial_reversal_lines WHERE source_type='WORKER_PAYMENT' AND source_id=$1", [alloc.paymentId])).rows[0].t);

    let reasonCode = "";
    let detail = "";
    if (Number(others.n) > 0) { reasonCode = "PAYMENT_HAS_OTHER_ACTIVE_PRODUCTION"; detail = "الدفعة تغطي إنتاجاً آخر لم يُلغَ؛ العكس الجزئي بالنصيب يحتاج قرار إداري"; }
    else if (priorReversal > 0.0001) { reasonCode = "PAYMENT_ALREADY_PARTLY_REVERSED"; detail = "الدفعة عليها عكس سابق"; }
    else if (Math.abs(allocatedTotal - payment.gross) > 0.01) { reasonCode = "ALLOCATION_DOES_NOT_COVER_PAYMENT"; detail = "توزيع الدفعة على الإنتاج لا يساوي إجمالي الدفعة؛ التوزيع غير واضح"; }
    else if (payment.settlement_source === "PREVIOUS_CUSTODY") { reasonCode = "PREVIOUS_CUSTODY_BOOKS_ONLY"; detail = "دفعة عهدة سابقة تبقى دفترية فقط"; }
    else if (!canReverse) { reasonCode = "ACTOR_CANNOT_REVERSE_PAYMENTS"; detail = "المستخدم لا يملك صلاحية عكس الدفعات"; }

    let reversalId: string | null = null;
    if (!reasonCode) {
      await client.query("SAVEPOINT cancel_payment_reversal");
      try {
        const result = await executeFinancialReversal(client, {
          sourceType: "WORKER_PAYMENT", sourceId: alloc.paymentId, amount: Math.round(payment.gross * 100) / 100,
          reason: `إلغاء كل إنتاج الدفعة: ${input.reason}`.slice(0, 500),
          idempotencyKey: deterministicUuid("production-cancel-payment-reversal:" + alloc.paymentId)
        }, input.actor);
        reversalId = (result.reversal as { id: string }).id;
        await client.query("RELEASE SAVEPOINT cancel_payment_reversal");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT cancel_payment_reversal");
        reasonCode = "AUTO_REVERSAL_REFUSED";
        detail = error instanceof Error ? error.message : "تعذر العكس التلقائي";
      }
    }

    const status = reversalId ? "AUTO_REVERSED" : "OPEN";
    await client.query(
      `INSERT INTO production_cancellation_payment_reviews(production_entry_id,worker_payment_id,employee_id,allocated_amount,payment_gross_amount,status,reason_code,detail,financial_reversal_id,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(production_entry_id,worker_payment_id) DO NOTHING`,
      [input.productionEntryId, alloc.paymentId, input.employeeId, alloc.amount, payment.gross, status, reversalId ? "ALL_PRODUCTION_CANCELLED" : reasonCode, detail || null, reversalId, input.actor.userId]
    );
    await writeAudit(client, {
      actorUserId: input.actor.userId, actorEmployeeId: input.actor.employeeId, action: reversalId ? "auto_reverse_payment" : "queue_payment_review",
      module: "production", entityType: "production_entry", entityId: input.productionEntryId,
      metadata: { workerPaymentId: alloc.paymentId, allocatedAmount: alloc.amount, paymentGross: payment.gross, status, reasonCode: reversalId ? "ALL_PRODUCTION_CANCELLED" : reasonCode, financialReversalId: reversalId },
      ipAddress: input.actor.ip, userAgent: input.actor.userAgent
    });
    outcomes.push({ paymentId: alloc.paymentId, status, reasonCode: reversalId ? "ALL_PRODUCTION_CANCELLED" : reasonCode });
  }
  return outcomes;
}
