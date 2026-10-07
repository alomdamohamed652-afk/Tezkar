import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const createSchema = z.object({
  employeeId: z.string().uuid().optional(),
  orderStageId: z.string().uuid().nullable().optional(),
  productionTypeId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid(),
  stageId: z.string().uuid(),
  shiftId: z.string().uuid(),
  workDate: z.string().date(),
  quantity: z.number().positive(),
  baseAmount: z.number().nonnegative().nullable().optional(),
  hoursWorked: z.number().positive().nullable().optional(),
  warehouseId: z.string().uuid(),
  locationId: z.string().uuid()
});

const rejectSchema = z.object({
  reason: z.string().trim().min(2).max(500)
});

async function isWorker(client: import("pg").PoolClient, userId: string) {
  const result = await client.query(
    `SELECT EXISTS(
       SELECT 1 FROM user_roles ur
       JOIN roles r ON r.id=ur.role_id
       WHERE ur.user_id=$1 AND r.code='worker' AND r.is_active=TRUE
     ) AS is_worker`,
    [userId]
  );
  return Boolean(result.rows[0]?.is_worker);
}

async function getEntry(client: import("pg").PoolClient, id: string, lock = false) {
  const result = await client.query(
    `SELECT p.*,
            e.code AS employee_code, e.full_name AS employee_name,
            pr.code AS product_code, pr.name AS product_name,
            st.code AS stage_code, st.name AS stage_name,
            sh.code AS shift_code, sh.name AS shift_name,
            u.code AS unit_code, u.name AS unit_name
       FROM production_entries p
       JOIN employees e ON e.id=p.employee_id
       JOIN products pr ON pr.id=p.product_id
       JOIN stages st ON st.id=p.stage_id
       JOIN shifts sh ON sh.id=p.shift_id
       JOIN units u ON u.id=p.unit_id
      WHERE p.id=$1${lock ? " FOR UPDATE" : ""}`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function productionRoutes(app: FastifyInstance) {
  app.get("/api/production/destinations", {
    preHandler: [authenticateRequest, requirePermission("production.create")]
  }, async () => {
    const result = await pool.query(
      `SELECT l.id,l.code,l.name,l.warehouse_id,w.code AS warehouse_code,w.name AS warehouse_name
         FROM warehouse_locations l
         JOIN warehouses w ON w.id=l.warehouse_id
        WHERE l.is_active=TRUE AND w.is_active=TRUE
        ORDER BY w.name,l.code`
    );
    return { data: result.rows };
  });

  app.get("/api/production", {
    preHandler: [authenticateRequest, requirePermission("production.view")]
  }, async (request) => {
    const query = z.object({
      status: z.enum(["PENDING","APPROVED","REJECTED","CANCELLED"]).optional(),
      employeeId: z.string().uuid().optional(),
      from: z.string().date().optional(),
      to: z.string().date().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100)
    }).safeParse(request.query);

    if (!query.success) throw new AppError("VALIDATION_ERROR", "فلاتر الإنتاج غير صحيحة", 422);

    const params: unknown[] = [];
    const where: string[] = [];

    const client = await pool.connect();
    let workerOnly = false;
    try {
      workerOnly = await isWorker(client, request.user!.userId);
    } finally {
      client.release();
    }

    if (workerOnly) {
      if (!request.user!.employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED", "حساب العامل غير مرتبط بملف موظف", 403);
      params.push(request.user!.employeeId);
      where.push(`p.employee_id=${params.length}`);
    }

    if (query.data.status) { params.push(query.data.status); where.push(`p.status=$${params.length}`); }
    if (query.data.employeeId) { params.push(query.data.employeeId); where.push(`p.employee_id=$${params.length}`); }
    if (query.data.from) { params.push(query.data.from); where.push(`p.work_date >= $${params.length}`); }
    if (query.data.to) { params.push(query.data.to); where.push(`p.work_date <= $${params.length}`); }

    params.push(query.data.limit);

    const result = await pool.query(
      `SELECT p.id,p.code,p.work_date,p.quantity,p.rate_snapshot,p.earning_amount,p.status,
              e.code AS employee_code,e.full_name AS employee_name,
              pr.code AS product_code,pr.name AS product_name,
              st.code AS stage_code,st.name AS stage_name,
              pt.name AS production_type_name,
              sh.code AS shift_code,sh.name AS shift_name,
              u.code AS unit_code,u.name AS unit_name,
              p.wage_type_code_snapshot,p.wage_type_method_snapshot,p.order_stage_id,p.production_type_id
         FROM production_entries p
         JOIN employees e ON e.id=p.employee_id
         JOIN products pr ON pr.id=p.product_id
         JOIN stages st ON st.id=p.stage_id
         JOIN shifts sh ON sh.id=p.shift_id
         JOIN units u ON u.id=p.unit_id
         LEFT JOIN production_types pt ON pt.id=p.production_type_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY p.work_date DESC,p.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    return { data: result.rows };
  });

  app.get("/api/production/my", {
    preHandler: [authenticateRequest, requirePermission("production.view_own")]
  }, async (request) => {
    if (!request.user?.employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
    const result = await pool.query(
      `SELECT p.id,p.code,p.work_date,p.quantity,p.earning_amount,p.status,
              pr.name AS product_name,st.name AS stage_name,sh.name AS shift_name,u.name AS unit_name
         FROM production_entries p
         JOIN products pr ON pr.id=p.product_id
         JOIN stages st ON st.id=p.stage_id
         JOIN shifts sh ON sh.id=p.shift_id
         JOIN units u ON u.id=p.unit_id
        WHERE p.employee_id=$1
        ORDER BY p.work_date DESC,p.created_at DESC LIMIT 300`,
      [request.user.employeeId]
    );
    return {data:result.rows};
  });

  app.post("/api/production", {
    preHandler: [authenticateRequest, requirePermission("production.create")]
  }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "بيانات الإنتاج غير صحيحة", 422);

    const row = await withTransaction(async (client) => {
      const worker = await isWorker(client, request.user!.userId);
      const employeeId = worker
        ? request.user!.employeeId
        : parsed.data.employeeId;

      if (!employeeId) {
        throw new AppError("EMPLOYEE_REQUIRED", "يجب تحديد الموظف الذي تم تسجيل الإنتاج له", 422);
      }

      const employee = await client.query(
        "SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",
        [employeeId]
      );
      if (!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND", "الموظف غير موجود أو غير نشط", 422);

      const destination = await client.query(
        `SELECT l.id,l.warehouse_id
           FROM warehouse_locations l
           JOIN warehouses w ON w.id=l.warehouse_id
          WHERE l.id=$1 AND l.warehouse_id=$2 AND l.is_active=TRUE AND w.is_active=TRUE`,
        [parsed.data.locationId, parsed.data.warehouseId]
      );
      if (!destination.rowCount) {
        throw new AppError("DESTINATION_NOT_FOUND", "مخزن أو مكان تخزين الإنتاج غير موجود أو غير نشط", 422);
      }

      const product = await client.query(
        "SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",
        [parsed.data.productId]
      );
      if (!product.rowCount) throw new AppError("PRODUCT_NOT_FOUND", "المنتج غير موجود أو غير نشط", 422);

      const stage = await client.query(
        "SELECT id FROM stages WHERE id=$1 AND is_active=TRUE",
        [parsed.data.stageId]
      );
      if (!stage.rowCount) throw new AppError("STAGE_NOT_FOUND", "مرحلة الإنتاج غير موجودة أو غير نشطة", 422);

      const shift = await client.query(
        "SELECT id,rate_group_id FROM shifts WHERE id=$1 AND is_active=TRUE",
        [parsed.data.shiftId]
      );
      if (!shift.rowCount) throw new AppError("SHIFT_NOT_FOUND", "الوردية غير موجودة أو غير نشطة", 422);

      const rateResult = await client.query(
        `SELECT r.id,r.rate,r.wage_type_id,r.unit_id,r.production_type_id,
                wt.code AS wage_type_code,wt.name AS wage_type_name,
                wt.method,wt.percentage_base
           FROM rates r
           JOIN wage_types wt ON wt.id=r.wage_type_id
          WHERE r.is_active=TRUE
            AND r.stage_id=$2
            AND (r.rate_group_id=$3 OR r.rate_group_id IS NULL)
            AND (r.product_id=$1 OR r.product_id IS NULL)
            AND ($5::uuid IS NULL OR r.production_type_id=$5 OR r.production_type_id IS NULL)
            AND $4::date <@ r.effective_range
          ORDER BY
            CASE
              WHEN r.product_id=$1 AND r.stage_id=$2 AND r.rate_group_id=$3 THEN 1
              WHEN r.product_id IS NULL AND r.stage_id=$2 AND r.rate_group_id=$3 THEN 2
              WHEN r.product_id=$1 AND r.stage_id=$2 THEN 3
              WHEN r.product_id IS NULL AND r.stage_id=$2 THEN 4
              ELSE 99
            END,
            r.created_at DESC
          LIMIT 1`,
        [parsed.data.productId, parsed.data.stageId, shift.rows[0].rate_group_id, parsed.data.workDate, parsed.data.productionTypeId ?? null]
      );

      if (!rateResult.rowCount) {
        throw new AppError("RATE_NOT_FOUND", "لا يوجد سعر إنتاج مطابق للمنتج والمرحلة والوردية في هذا التاريخ", 422);
      }

      const rate = rateResult.rows[0];
      const method = rate.method as string;
      let earning: number;

      if (method === "PER_PIECE") {
        earning = parsed.data.quantity * Number(rate.rate);
      } else if (method === "PER_1000") {
        earning = (parsed.data.quantity / 1000) * Number(rate.rate);
      } else if (method === "PER_DAY") {
        earning = Number(rate.rate);
      } else if (method === "PERCENTAGE") {
        if (parsed.data.baseAmount == null) {
          throw new AppError("BASE_AMOUNT_REQUIRED", "هذا النوع من الأجر يحتاج قيمة أساس للحساب", 422);
        }
        earning = parsed.data.baseAmount * Number(rate.rate) / 100;
      } else if (method === "PER_HOUR") {
        if (parsed.data.hoursWorked == null) {
          throw new AppError("HOURS_WORKED_REQUIRED", "الأجر بالساعة يحتاج عدد الساعات الفعلية", 422);
        }
        earning = parsed.data.hoursWorked * Number(rate.rate);
      } else {
        throw new AppError("WAGE_METHOD_UNSUPPORTED", "طريقة حساب الأجر غير مدعومة", 422);
      }

      if (!Number.isFinite(earning) || earning < 0) {
        throw new AppError("EARNING_CALCULATION_ERROR", "تعذر حساب مستحق الإنتاج بشكل صحيح", 422);
      }

      const unitId = rate.unit_id ?? product.rows[0].unit_id;

      const inserted = await client.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,production_type_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,hours_worked,warehouse_id,location_id,
           rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,
           wage_type_method_snapshot,percentage_base_snapshot,base_amount,earning_amount,
           submitted_by
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING id,code,employee_id,order_stage_id,production_type_id,product_id,stage_id,shift_id,work_date,quantity,
                   unit_id,rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,
                   wage_type_method_snapshot,percentage_base_snapshot,base_amount,
                   earning_amount,status,submitted_by,created_at`,
        [
          employeeId, parsed.data.orderStageId ?? null, parsed.data.productionTypeId ?? rate.production_type_id ?? null, parsed.data.productId, parsed.data.stageId, parsed.data.shiftId,
          parsed.data.workDate, parsed.data.quantity, unitId, parsed.data.hoursWorked ?? null, parsed.data.warehouseId, parsed.data.locationId, rate.id, rate.rate,
          rate.wage_type_id, rate.wage_type_code, rate.method, rate.percentage_base ?? null,
          parsed.data.baseAmount ?? null, earning, request.user!.userId
        ]
      );

      const created = inserted.rows[0];
      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "create",
        module: "production",
        entityType: "production_entry",
        entityId: created.id,
        afterData: created,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });

      return created;
    });

    return reply.code(201).send({ data: row });
  });

  app.post("/api/production/:id/approve", {
    preHandler: [authenticateRequest, requirePermission("production.approve")]
  }, async (request) => {
    const id = (request.params as { id: string }).id;

    const row = await withTransaction(async (client) => {
      const current = await getEntry(client, id, true);
      if (!current) throw new AppError("PRODUCTION_NOT_FOUND", "سجل الإنتاج غير موجود", 404);
      if (current.status !== "PENDING") {
        throw new AppError("INVALID_STATUS", "لا يمكن اعتماد سجل الإنتاج إلا إذا كان في حالة انتظار", 409);
      }
      if (current.submitted_by === request.user!.userId) {
        throw new AppError("SELF_APPROVAL", "لا يمكنك اعتماد سجل إنتاج قمت بتسجيله بنفسك", 409);
      }

      if (!current.warehouse_id || !current.location_id) {
        throw new AppError("PRODUCTION_DESTINATION_REQUIRED", "الإنتاج القديم لا يحتوي على وجهة مخزنية؛ لا يمكن إدخاله للمخزن قبل تحديد الوجهة", 409);
      }

      const destination = await client.query(
        "SELECT l.id,l.warehouse_id FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1 AND l.warehouse_id=$2 AND l.is_active=TRUE AND w.is_active=TRUE",
        [current.location_id, current.warehouse_id]
      );
      if (!destination.rowCount) throw new AppError("DESTINATION_NOT_FOUND", "وجهة الإنتاج غير موجودة أو غير نشطة", 409);

      const lockedBalance = await client.query(
        "SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
        [current.product_id, current.warehouse_id, current.location_id]
      );
      const currentBalance = Number(lockedBalance.rows[0]?.quantity ?? 0);
      const currentValue = Number(lockedBalance.rows[0]?.inventory_value ?? 0);
      const currentAvg = Number(lockedBalance.rows[0]?.avg_unit_cost ?? 0);
      const productionUnitCost = Number(current.quantity) > 0 ? Number(current.earning_amount) / Number(current.quantity) : 0;
      const nextBalance = currentBalance + Number(current.quantity);
      const nextValue = currentValue + Number(current.quantity) * productionUnitCost;
      const nextAvg = nextBalance > 0 ? nextValue / nextBalance : currentAvg;
      if (lockedBalance.rowCount) {
        await client.query(
          "UPDATE stock_balances SET quantity=$1,avg_unit_cost=$2,inventory_value=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",
          [nextBalance,nextAvg,nextValue,current.product_id,current.warehouse_id,current.location_id]
        );
      } else {
        await client.query(
          "INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity,avg_unit_cost,inventory_value) VALUES($1,$2,$3,$4,$5,$6)",
          [current.product_id,current.warehouse_id,current.location_id,current.quantity,productionUnitCost,Number(current.earning_amount)]
        );
      }

      await client.query(
        `INSERT INTO stock_movements(
           movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,order_id,order_stage_id,
           notes,created_by,reference_type,reference_id
         )
         VALUES('IN',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PRODUCTION',$12)
         ON CONFLICT DO NOTHING`,
        [
          current.product_id,current.warehouse_id,current.location_id,current.quantity,current.unit_id,
          productionUnitCost,Number(current.earning_amount),current.order_stage_id??null,current.order_stage_id??null,
          "إدخال إنتاج معتمد "+current.code,request.user!.userId,id
        ]
      );

      const updated = await client.query(
        `UPDATE production_entries
            SET status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now()
          WHERE id=$2
          RETURNING *`,
        [request.user!.userId, id]
      );

      await client.query(
        `INSERT INTO employee_earnings_ledger(
           employee_id,entry_type,credit_amount,production_entry_id,created_by,notes
         )
         VALUES($1,'PRODUCTION_APPROVAL',$2,$3,$4,'Approved production earning')
         ON CONFLICT (production_entry_id) DO NOTHING`,
        [current.employee_id, current.earning_amount, id, request.user!.userId]
      );

      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "approve",
        module: "production",
        entityType: "production_entry",
        entityId: id,
        beforeData: current,
        afterData: updated.rows[0],
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });

      return updated.rows[0];
    });

    return { data: row };
  });

  app.post("/api/production/:id/cancel", {
    preHandler: [authenticateRequest, requirePermission("production.cancel")]
  }, async (request) => {
    const id = (request.params as { id: string }).id;

    const row = await withTransaction(async (client) => {
      const current = await getEntry(client, id, true);
      if (!current) throw new AppError("PRODUCTION_NOT_FOUND", "سجل الإنتاج غير موجود", 404);
      if (current.status !== "PENDING") {
        throw new AppError("INVALID_STATUS", "لا يمكن إلغاء الإنتاج بعد المراجعة", 409);
      }

      const updated = await client.query(
        `UPDATE production_entries
            SET status='CANCELLED',cancelled_by=$1,cancelled_at=now(),updated_at=now()
          WHERE id=$2
          RETURNING *`,
        [request.user!.userId, id]
      );

      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "cancel",
        module: "production",
        entityType: "production_entry",
        entityId: id,
        beforeData: current,
        afterData: updated.rows[0],
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });

      return updated.rows[0];
    });

    return { data: row };
  });

  app.post("/api/production/:id/reject", {
    preHandler: [authenticateRequest, requirePermission("production.reject")]
  }, async (request) => {
    const id = (request.params as { id: string }).id;
    const parsed = rejectSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "سبب الرفض مطلوب", 422);

    const row = await withTransaction(async (client) => {
      const current = await getEntry(client, id, true);
      if (!current) throw new AppError("PRODUCTION_NOT_FOUND", "سجل الإنتاج غير موجود", 404);
      if (current.status !== "PENDING") throw new AppError("INVALID_STATUS", "لا يمكن رفض هذا السجل في حالته الحالية", 409);
      if (current.submitted_by === request.user!.userId) throw new AppError("SELF_REVIEW", "لا يمكنك مراجعة سجل قمت بتسجيله بنفسك", 409);

      const updated = await client.query(
        `UPDATE production_entries
            SET status='REJECTED',rejection_reason=$1,updated_at=now()
          WHERE id=$2
          RETURNING *`,
        [parsed.data.reason, id]
      );

      await writeAudit(client, {
        actorUserId: request.user!.userId,
        actorEmployeeId: request.user!.employeeId,
        action: "reject",
        module: "production",
        entityType: "production_entry",
        entityId: id,
        beforeData: current,
        afterData: updated.rows[0],
        metadata: { reason: parsed.data.reason },
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null
      });

      return updated.rows[0];
    });

    return { data: row };
  });
}
