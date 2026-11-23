import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";

const PERMISSION = "earnings.administrative_settlement.create";

// Money is kept as exact 4-decimal numeric text inside PostgreSQL, never as JS floats.
const BALANCE_SQL = "SELECT COALESCE(SUM(credit_amount-debit_amount),0)::numeric(18,4)::text AS balance FROM employee_earnings_ledger WHERE employee_id=$1";

function describe(balance: string) {
  const negative = balance.startsWith("-");
  const abs = negative ? balance.slice(1) : balance;
  const isZero = Number(abs) === 0;
  return {
    balance,
    isZero,
    // Negative balance (worker owes the company on paper) is raised with a CREDIT; positive balance is lowered with a DEBIT.
    direction: isZero ? null : negative ? "CREDIT" : "DEBIT",
    amount: isZero ? "0.0000" : abs,
    balanceAfter: "0.0000"
  };
}

export async function administrativeSettlementRoutes(app: FastifyInstance) {
  app.get("/api/production/earnings/administrative-settlement/:employeeId", { preHandler: [authenticateRequest, requirePermission(PERMISSION)] }, async (request) => {
    const parsed = z.object({ employeeId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "معرّف العامل غير صحيح", 422);
    const employee = await pool.query("SELECT id,code,full_name,is_active FROM employees WHERE id=$1", [parsed.data.employeeId]);
    if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "العامل غير موجود", 404);
    const balance = (await pool.query(BALANCE_SQL, [parsed.data.employeeId])).rows[0].balance as string;
    const history = await pool.query(
      `SELECT s.code,s.direction,s.amount::text AS amount,s.balance_before::text AS balance_before,s.reason,s.created_at
         FROM employee_administrative_settlements s WHERE s.employee_id=$1 ORDER BY s.created_at DESC LIMIT 20`, [parsed.data.employeeId]);
    return {
      data: {
        employee: { id: employee.rows[0].id, code: employee.rows[0].code, name: employee.rows[0].full_name, isActive: employee.rows[0].is_active },
        ...describe(balance),
        notice: "هذه تسوية إدارية غير نقدية: لا تغيّر أي إنتاج ولا أي دفعة ولا العهدة النقدية، وتضيف حركة واحدة فقط على دفتر المستحقات لتصفير الرصيد.",
        requiresInactiveAcknowledgement: !employee.rows[0].is_active,
        history: history.rows
      }
    };
  });

  app.post("/api/production/earnings/administrative-settlement", { preHandler: [authenticateRequest, requirePermission(PERMISSION)] }, async (request, reply) => {
    const parsed = z.object({
      employeeId: z.string().uuid(),
      expectedBalance: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/),
      reason: z.string().trim().min(5).max(500),
      confirmEmployeeCode: z.string().trim().min(1),
      acknowledgeNonCash: z.literal(true),
      acknowledgeInactive: z.boolean().optional(),
      idempotencyKey: z.string().uuid()
    }).safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات التسوية الإدارية غير مكتملة: السبب (٥ أحرف على الأقل) وتأكيد كود العامل والإقرار بأنها غير نقدية مطلوبة", 422);
    const input = parsed.data;
    const fingerprint = createHash("sha256").update(JSON.stringify([input.employeeId, input.reason, input.confirmEmployeeCode])).digest("hex");
    const result = await withTransaction(async client => {
      const prior = await client.query("SELECT * FROM employee_administrative_settlements WHERE idempotency_key=$1", [input.idempotencyKey]);
      if (prior.rowCount) {
        if (prior.rows[0].request_fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_KEY_REUSED", "مفتاح التكرار مستخدم لطلب مختلف", 409);
        return { settlement: prior.rows[0], replay: true };
      }
      await assertAccountingPeriodOpen(client, new Date().toISOString().slice(0, 10));
      // Lock the worker row so two parallel submissions serialise. The row is only locked, never updated: an inactive worker stays inactive.
      const employee = await client.query("SELECT id,code,full_name,is_active FROM employees WHERE id=$1 FOR UPDATE", [input.employeeId]);
      if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "العامل غير موجود", 404);
      const raced = await client.query("SELECT * FROM employee_administrative_settlements WHERE idempotency_key=$1", [input.idempotencyKey]);
      if (raced.rowCount) {
        if (raced.rows[0].request_fingerprint !== fingerprint) throw new AppError("IDEMPOTENCY_KEY_REUSED", "مفتاح التكرار مستخدم لطلب مختلف", 409);
        return { settlement: raced.rows[0], replay: true };
      }
      if (employee.rows[0].code !== input.confirmEmployeeCode) throw new AppError("CONFIRMATION_MISMATCH", "كود العامل المكتوب للتأكيد غير مطابق", 409);
      if (!employee.rows[0].is_active && input.acknowledgeInactive !== true) throw new AppError("INACTIVE_EMPLOYEE_ACK_REQUIRED", "العامل غير نشط. أكّد صراحة أنك تسوّي حسابه وهو غير نشط (لن يُعاد تفعيله).", 409);
      const balance = (await client.query(BALANCE_SQL, [input.employeeId])).rows[0].balance as string;
      const plan = describe(balance);
      if (plan.isZero) throw new AppError("NOTHING_TO_SETTLE", "رصيد العامل صفر بالفعل", 409);
      if (Number(balance) !== Number(input.expectedBalance)) throw new AppError("BALANCE_CHANGED", `رصيد العامل تغيّر (الآن ${balance}). راجع المعاينة ثم أعد المحاولة.`, 409);
      const credit = plan.direction === "CREDIT" ? plan.amount : "0";
      const debit = plan.direction === "DEBIT" ? plan.amount : "0";
      const ledger = await client.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,notes,created_by) VALUES($1,'ADJUSTMENT',$2::numeric,$3::numeric,$4,$5) RETURNING id,code",
        [input.employeeId, credit, debit, `تسوية إدارية غير نقدية: ${input.reason}`, request.user!.userId]
      );
      const after = (await client.query(BALANCE_SQL, [input.employeeId])).rows[0].balance as string;
      if (Number(after) !== 0) throw new AppError("SETTLEMENT_NOT_ZERO", "فشل تصفير الرصيد؛ تم التراجع عن العملية", 500);
      const settlement = (await client.query(
        `INSERT INTO employee_administrative_settlements(employee_id,ledger_id,direction,amount,balance_before,balance_after,reason,employee_was_active,idempotency_key,request_fingerprint,created_by)
         VALUES($1,$2,$3,$4::numeric,$5::numeric,0,$6,$7,$8,$9,$10) RETURNING *`,
        [input.employeeId, ledger.rows[0].id, plan.direction, plan.amount, balance, input.reason, employee.rows[0].is_active, input.idempotencyKey, fingerprint, request.user!.userId]
      )).rows[0];
      await writeAudit(client, {
        actorUserId: request.user!.userId, actorEmployeeId: request.user!.employeeId, action: "administrative_settlement", module: "ADMIN",
        entityType: "employee_administrative_settlement", entityId: settlement.id,
        beforeData: { employeeId: input.employeeId, balance }, afterData: { balance: "0.0000", direction: plan.direction, amount: plan.amount, ledgerCode: ledger.rows[0].code },
        metadata: { reason: input.reason, employeeWasActive: employee.rows[0].is_active, nonCash: true },
        ipAddress: request.ip, userAgent: request.headers["user-agent"] ?? null
      });
      return { settlement, replay: false };
    });
    return reply.code(result.replay ? 200 : 201).send({ data: { id: result.settlement.id, code: result.settlement.code, direction: result.settlement.direction, amount: String(result.settlement.amount), balanceBefore: String(result.settlement.balance_before), balanceAfter: "0.0000", idempotentReplay: result.replay } });
  });
}
