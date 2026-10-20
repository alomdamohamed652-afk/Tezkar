import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { verifyPassword } from "../auth/auth.service.js";
import { hasPermission } from "../rbac/rbac.service.js";
import { createInventoryLot } from "../warehouse/inventory-lots.service.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";

const createSchema = z.object({
  employeeId: z.string().uuid().optional(),
  orderStageId: z.string().uuid().nullable().optional(),
  productionTypeId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().optional(),
  stageId: z.string().uuid(),
  shiftId: z.string().uuid(),
  workDate: z.string().date(),
  quantity: z.number().positive(),
  baseAmount: z.number().nonnegative().nullable().optional(),
  hoursWorked: z.number().positive().nullable().optional(),
  rateOverride: z.number().nonnegative().nullable().optional(),
  warehouseId: z.string().uuid().optional(),
  locationId: z.string().uuid().nullable().optional(),
  bonusAmount: z.number().nonnegative().optional().default(0),
  shiftLeaderEmployeeId: z.string().uuid().nullable().optional(),
  bonusReason: z.string().trim().max(500).nullable().optional(),
  deductionAmount: z.number().nonnegative().optional().default(0),
  deductionReason: z.string().trim().max(500).nullable().optional()
});

const rejectSchema = z.object({
  reason: z.string().trim().min(2).max(500)
});

const adjustmentSchema = z.object({
  employeeId: z.string().uuid(),
  shiftId: z.string().uuid().nullable().optional(),
  productionEntryId: z.string().uuid().nullable().optional(),
  adjustmentType: z.enum(["BONUS","DEDUCTION"]),
  amount: z.number().positive(),
  reason: z.string().trim().min(2).max(500),
  adjustmentDate: z.string().date().optional()
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
            sle.full_name AS shift_leader_name,
            pr.code AS product_code, pr.name AS product_name,
            st.code AS stage_code, st.name AS stage_name,
            os.order_id AS order_id,
            sh.code AS shift_code, sh.name AS shift_name,
            u.code AS unit_code, u.name AS unit_name
       FROM production_entries p
       JOIN employees e ON e.id=p.employee_id
       LEFT JOIN employees sle ON sle.id=p.shift_leader_employee_id
       JOIN products pr ON pr.id=p.product_id
       JOIN stages st ON st.id=p.stage_id
       LEFT JOIN order_stages os ON os.id=p.order_stage_id
       JOIN shifts sh ON sh.id=p.shift_id
       JOIN units u ON u.id=p.unit_id
      WHERE p.id=$1${lock ? " FOR UPDATE OF p" : ""}`,
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
      orderId: z.string().uuid().optional(),
      stageId: z.string().uuid().optional(),
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
      where.push(`p.employee_id=$${params.length}`);
    }

    if (query.data.status) { params.push(query.data.status); where.push(`p.status=$${params.length}`); }
    else where.push("p.status <> 'CANCELLED'");
    if (query.data.employeeId) { params.push(query.data.employeeId); where.push(`p.employee_id=$${params.length}`); }
    if (query.data.orderId) {
      params.push(query.data.orderId);
      where.push(`EXISTS (SELECT 1 FROM order_stages os_filter WHERE os_filter.id=p.order_stage_id AND os_filter.order_id=$${params.length})`);
    }
    if (query.data.stageId) { params.push(query.data.stageId); where.push(`p.stage_id=$${params.length}`); }
    if (query.data.from) { params.push(query.data.from); where.push(`p.work_date >= $${params.length}`); }
    if (query.data.to) { params.push(query.data.to); where.push(`p.work_date <= $${params.length}`); }

    params.push(query.data.limit);

    const result = await pool.query(
      `SELECT p.id,p.code,to_char(p.work_date,'YYYY-MM-DD') AS work_date,p.responsible_name,p.employee_id,p.shift_id,p.shift_leader_employee_id,p.product_id,p.stage_id,p.base_amount,p.hours_worked,p.quantity,p.rate_snapshot,p.earning_amount,p.bonus_amount,p.deduction_amount,
              (SELECT a.reason FROM employee_earnings_adjustments a WHERE a.production_entry_id=p.id AND a.adjustment_type='BONUS' ORDER BY a.created_at DESC LIMIT 1) AS bonus_reason,
              (SELECT a.reason FROM employee_earnings_adjustments a WHERE a.production_entry_id=p.id AND a.adjustment_type='DEDUCTION' ORDER BY a.created_at DESC LIMIT 1) AS deduction_reason,
              p.total_earning_amount,p.status,
              e.code AS employee_code,e.full_name AS employee_name,
              sle.full_name AS shift_leader_name,
              pr.code AS product_code,pr.name AS product_name,
              st.code AS stage_code,st.name AS stage_name,
              pt.name AS production_type_name,
              sh.code AS shift_code,sh.name AS shift_name,
              u.code AS unit_code,u.name AS unit_name,
              p.wage_type_code_snapshot,p.wage_type_method_snapshot,p.order_stage_id,p.production_type_id
         FROM production_entries p
         JOIN employees e ON e.id=p.employee_id
         LEFT JOIN employees sle ON sle.id=p.shift_leader_employee_id
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
    preHandler: [authenticateRequest, requirePermission("production.view_own","own")]
  }, async (request) => {
    if (!request.user?.employeeId) throw new AppError("EMPLOYEE_LINK_REQUIRED","الحساب غير مرتبط بموظف",403);
    const result = await pool.query(
      `SELECT p.id,p.code,to_char(p.work_date,'YYYY-MM-DD') AS work_date,p.quantity,p.earning_amount,p.status,
              pr.name AS product_name,st.name AS stage_name,sh.name AS shift_name,u.name AS unit_name
         FROM production_entries p
         JOIN products pr ON pr.id=p.product_id
         JOIN stages st ON st.id=p.stage_id
         JOIN shifts sh ON sh.id=p.shift_id
         JOIN units u ON u.id=p.unit_id
        WHERE p.employee_id=$1 AND p.status <> 'CANCELLED'
        ORDER BY p.work_date DESC,p.created_at DESC LIMIT 300`,
      [request.user.employeeId]
    );
    return {data:result.rows};
  });

  app.post("/api/production", {
    preHandler: [authenticateRequest, requirePermission("production.create")]
  }, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const fieldLabels: Record<string, string> = {
        employeeId: "الموظف",
        orderStageId: "مرحلة الطلبية",
        productionTypeId: "نوع الإنتاج",
        productId: "المنتج",
        stageId: "المرحلة",
        shiftId: "الوردية",
        warehouseId: "المخزن",
        locationId: "موقع التخزين",
        workDate: "تاريخ الإنتاج",
        quantity: "الكمية",
        rateOverride: "سعر المرحلة"
      };
      const field = String(firstIssue?.path?.[0] ?? "");
      const message = firstIssue?.message === "Invalid UUID" && fieldLabels[field]
        ? `معرّف ${fieldLabels[field]} غير صحيح. حدّث الصفحة وأعد الاختيار.`
        : firstIssue?.message || "بيانات الإنتاج غير صحيحة";
      throw new AppError("VALIDATION_ERROR", message, 422);
    }

    const row = await withTransaction(async (client) => {
      await assertAccountingPeriodOpen(client, parsed.data.workDate);
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
      if(parsed.data.shiftLeaderEmployeeId){
        const leader=await client.query(
          "SELECT 1 FROM shift_leaders WHERE employee_id=$1 AND shift_id=$2 AND is_active=TRUE AND (starts_on IS NULL OR starts_on<=$3::date) AND (ends_on IS NULL OR ends_on>=$3::date) LIMIT 1",
          [parsed.data.shiftLeaderEmployeeId,parsed.data.shiftId,parsed.data.workDate]
        );
        if(!leader.rowCount)throw new AppError("SHIFT_LEADER_NOT_ASSIGNED","مسؤول الوردية المختار غير مكلف بهذه الوردية في تاريخ الإنتاج",422);
      }

      let resolvedWarehouseId = parsed.data.warehouseId;
      if(parsed.data.orderStageId){
        const os0=await client.query("SELECT os.order_id,os.sequence_no,os.is_final_product FROM order_stages os WHERE os.id=$1",[parsed.data.orderStageId]);
        if(!os0.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const final0=await client.query("SELECT MAX(sequence_no) AS max_sequence,BOOL_OR(is_final_product) AS has_explicit_final FROM order_stages WHERE order_id=$1 AND status <> 'CANCELLED'",[os0.rows[0].order_id]);
        const type0=Boolean(os0.rows[0].is_final_product)||(!Boolean(final0.rows[0]?.has_explicit_final)&&Number(os0.rows[0].sequence_no)===Number(final0.rows[0]?.max_sequence)) ? "FINISHED_GOODS" : "WIP";
        const wh0=await client.query("SELECT id FROM warehouses WHERE warehouse_type=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",[type0]);
        if(!wh0.rowCount) throw new AppError("VIRTUAL_WAREHOUSE_MISSING","المخزن الافتراضي للإنتاج غير مُجهز",500);
        // The server enforces the stage's virtual warehouse. The client cannot redirect
        // a stage-bound production entry into raw materials or another operational store.
        resolvedWarehouseId=wh0.rows[0].id;
      }

      const destination = parsed.data.locationId
        ? await client.query(
            `SELECT l.id,l.warehouse_id
               FROM warehouse_locations l
               JOIN warehouses w ON w.id=l.warehouse_id
              WHERE l.id=$1 AND l.warehouse_id=$2 AND l.is_active=TRUE AND w.is_active=TRUE`,
            [parsed.data.locationId, resolvedWarehouseId]
          )
        : await client.query(
            `SELECT l.id,l.warehouse_id
               FROM warehouse_locations l
               JOIN warehouses w ON w.id=l.warehouse_id
              WHERE l.warehouse_id=$1 AND l.is_active=TRUE AND w.is_active=TRUE
              ORDER BY l.created_at,l.id LIMIT 1`,
            [resolvedWarehouseId]
          );
      if (!destination.rowCount) {
        throw new AppError("DESTINATION_NOT_FOUND", "المخزن غير موجود أو لا يحتوي على وجهة تخزين داخلية", 422);
      }
      const resolvedLocationId = destination.rows[0].id;

      if (parsed.data.orderStageId) {
        // Always lock the parent order before its stage. Order edits/cancellation
        // use the same lock order, avoiding order↔stage deadlocks under concurrency.
        const stageRef = await client.query(
          "SELECT order_id FROM order_stages WHERE id=$1",
          [parsed.data.orderStageId]
        );
        if (!stageRef.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const parentOrder = await client.query(
          "SELECT status FROM production_orders WHERE id=$1 FOR UPDATE",
          [stageRef.rows[0].order_id]
        );
        if (!parentOrder.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
        const orderStage = await client.query(
          `SELECT os.id,os.order_id,os.output_product_id,os.stage_id,os.sequence_no,os.is_final_product,os.status AS stage_status,po.status AS order_status
             FROM order_stages os
             JOIN production_orders po ON po.id=os.order_id
            WHERE os.id=$1
            FOR UPDATE OF os`,
          [parsed.data.orderStageId]
        );
        if (!orderStage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const os=orderStage.rows[0];
        if (os.order_status === "CANCELLED" || os.stage_status === "CANCELLED") throw new AppError("ORDER_CANCELLED","لا يمكن تسجيل إنتاج لمرحلة طلبية أو مرحلة ملغاة",409);
        if (os.order_status === "DRAFT" || os.order_status === "COMPLETED") throw new AppError("ORDER_NOT_ACTIVE","لا يمكن تسجيل إنتاج لطلبية مسودة أو مكتملة؛ فعّل الطلبية أو أعد فتحها أولًا",409);
        if (os.stage_status === "COMPLETED") throw new AppError("ORDER_STAGE_COMPLETED","لا يمكن تسجيل إنتاج إضافي لمرحلة مكتملة",409);
        const finalStage=await client.query("SELECT MAX(sequence_no) AS max_sequence,BOOL_OR(is_final_product) AS has_explicit_final FROM order_stages WHERE order_id=$1 AND status <> 'CANCELLED'",[os.order_id]);
        const warehouseType=Boolean(os.is_final_product)||(!Boolean(finalStage.rows[0]?.has_explicit_final)&&Number(os.sequence_no)===Number(finalStage.rows[0]?.max_sequence)) ? "FINISHED_GOODS" : "WIP";
        const virtualWarehouse=await client.query("SELECT id FROM warehouses WHERE warehouse_type=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",[warehouseType]);
        if(!virtualWarehouse.rowCount) throw new AppError("VIRTUAL_WAREHOUSE_MISSING","المخزن الافتراضي للإنتاج غير مُجهز",500);
        // A production entry tied to an order stage must land in the system warehouse
        // dictated by the workflow (WIP for intermediate stages, finished goods for
        // the final stage). Do not let a client-supplied warehouse bypass that rule.
        resolvedWarehouseId=virtualWarehouse.rows[0].id;
        if (os.stage_id !== parsed.data.stageId) {
          throw new AppError("ORDER_STAGE_STAGE_MISMATCH","مرحلة الإنتاج لا تطابق مرحلة الطلب المرتبطة",409);
        }
        if (!os.output_product_id) throw new AppError("ORDER_STAGE_PRODUCT_REQUIRED","المرحلة لا تحتوي على منتج ناتج محدد",422);
        parsed.data.productId = os.output_product_id;
        parsed.data.stageId = os.stage_id;
      }

      if (!parsed.data.productId) throw new AppError("PRODUCT_REQUIRED", "اختر منتجًا أو اربط المرحلة بمنتج ناتج في بيانات الطلبية", 422);

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

      const orderStagePricing=parsed.data.orderStageId ? await client.query(`SELECT stage_rate,stage_rate_method,stage_rate_unit_id FROM order_stages WHERE id=$1`,[parsed.data.orderStageId]) : {rowCount:0,rows:[]};
      const stagePrice=orderStagePricing.rowCount && orderStagePricing.rows[0].stage_rate != null ? orderStagePricing.rows[0] : null;
      const rateResult = stagePrice ? await client.query(
        `SELECT NULL::uuid AS id,wt.id AS wage_type_id,$1::numeric AS rate,
                COALESCE($2::uuid,pr.unit_id) AS unit_id,$3::uuid AS production_type_id,
                wt.code AS wage_type_code,wt.name AS wage_type_name,wt.method,wt.percentage_base
           FROM wage_types wt CROSS JOIN products pr
          WHERE pr.id=$4
            AND wt.method=$5
            AND wt.is_active=TRUE
          ORDER BY CASE WHEN wt.percentage_base='ORDER_VALUE' THEN 0 ELSE 1 END,wt.created_at,wt.id
          LIMIT 1`,
        [Number(stagePrice.stage_rate),stagePrice.stage_rate_unit_id ?? null,parsed.data.productionTypeId ?? null,parsed.data.productId,stagePrice.stage_rate_method]
      ) : await client.query(
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
              WHEN $5::uuid IS NOT NULL AND r.production_type_id=$5 THEN 0
              WHEN r.production_type_id IS NULL THEN 1
              ELSE 2
            END,
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
      if (!rateResult.rowCount) {
        throw new AppError("WAGE_TYPE_NOT_FOUND", "طريقة أجر المرحلة غير معرفة في بيانات الأجور", 422);
      }
      if (!stagePrice && parsed.data.rateOverride != null && parsed.data.rateOverride !== Number(rate.rate)) {
        const canOverrideRate = await hasPermission(client, request.user!.userId, "production.rate_override");
        if (!canOverrideRate) {
          throw new AppError("FORBIDDEN", "ليس لديك صلاحية تعديل سعر الإنتاج", 403);
        }
      }
      const effectiveRate = stagePrice ? Number(rate.rate) : (parsed.data.rateOverride ?? Number(rate.rate));
      let earning: number;

      if (method === "PER_PIECE") {
        earning = parsed.data.quantity * effectiveRate;
      } else if (method === "PER_1000") {
        earning = (parsed.data.quantity / 1000) * effectiveRate;
      } else if (method === "PER_DAY") {
        earning = effectiveRate;
      } else if (method === "PERCENTAGE") {
        if (parsed.data.baseAmount == null) {
          throw new AppError("BASE_AMOUNT_REQUIRED", "هذا النوع من الأجر يحتاج قيمة أساس للحساب", 422);
        }
        earning = parsed.data.baseAmount * Number(rate.rate) / 100;
      } else if (method === "PER_HOUR") {
        if (parsed.data.hoursWorked == null) {
          throw new AppError("HOURS_WORKED_REQUIRED", "الأجر بالساعة يحتاج عدد الساعات الفعلية", 422);
        }
        earning = parsed.data.hoursWorked * effectiveRate;
      } else {
        throw new AppError("WAGE_METHOD_UNSUPPORTED", "طريقة حساب الأجر غير مدعومة", 422);
      }

      if (!Number.isFinite(earning) || earning < 0) {
        throw new AppError("EARNING_CALCULATION_ERROR", "تعذر حساب مستحق الإنتاج بشكل صحيح", 422);
      }
      if (earning + Number(parsed.data.bonusAmount ?? 0) < Number(parsed.data.deductionAmount ?? 0)) {
        throw new AppError("DEDUCTION_EXCEEDS_EARNING", "الخصم لا يمكن أن يجعل إجمالي مستحق الإنتاج بالسالب", 422);
      }

      const unitId = rate.unit_id ?? product.rows[0].unit_id;

      const inserted = await client.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,production_type_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,hours_worked,warehouse_id,location_id,responsible_name,
           rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,
           wage_type_method_snapshot,percentage_base_snapshot,base_amount,earning_amount,
           bonus_amount,deduction_amount,submitted_by,shift_leader_employee_id
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         RETURNING id,code,employee_id,order_stage_id,production_type_id,product_id,stage_id,shift_id,work_date,quantity,
                   unit_id,rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,
                   wage_type_method_snapshot,percentage_base_snapshot,base_amount,
                   earning_amount,bonus_amount,deduction_amount,total_earning_amount,status,submitted_by,created_at`,
        [
          employeeId, parsed.data.orderStageId ?? null, parsed.data.productionTypeId ?? rate.production_type_id ?? null, parsed.data.productId, parsed.data.stageId, parsed.data.shiftId,
          parsed.data.workDate, parsed.data.quantity, unitId, parsed.data.hoursWorked ?? null, resolvedWarehouseId, resolvedLocationId, null, rate.id, effectiveRate,
          rate.wage_type_id, rate.wage_type_code, rate.method, rate.percentage_base ?? null,
          parsed.data.baseAmount ?? null, earning, Number(parsed.data.bonusAmount ?? 0),
           Number(parsed.data.deductionAmount ?? 0), request.user!.userId, parsed.data.shiftLeaderEmployeeId ?? null
        ]
      );

      const created = inserted.rows[0];

      const bonusAmount = Number(parsed.data.bonusAmount ?? 0);
      const deductionAmount = Number(parsed.data.deductionAmount ?? 0);
      if (bonusAmount > 0) {
        if (!parsed.data.bonusReason?.trim()) throw new AppError("BONUS_REASON_REQUIRED","بيان البونص مطلوب",422);
        await client.query(
          `INSERT INTO employee_earnings_adjustments(
             employee_id,shift_id,production_entry_id,adjustment_type,amount,reason,adjustment_date,created_by
           ) VALUES($1,$2,$3,'BONUS',$4,$5,$6,$7)`,
          [employeeId,parsed.data.shiftId,created.id,bonusAmount,parsed.data.bonusReason.trim(),parsed.data.workDate,request.user!.userId]
        );
      }
      if (deductionAmount > 0) {
        if (!parsed.data.deductionReason?.trim()) throw new AppError("DEDUCTION_REASON_REQUIRED","بيان الخصم مطلوب",422);
        await client.query(
          `INSERT INTO employee_earnings_adjustments(
             employee_id,shift_id,production_entry_id,adjustment_type,amount,reason,adjustment_date,created_by
           ) VALUES($1,$2,$3,'DEDUCTION',$4,$5,$6,$7)`,
          [employeeId,parsed.data.shiftId,created.id,deductionAmount,parsed.data.deductionReason.trim(),parsed.data.workDate,request.user!.userId]
        );
      }

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

  app.delete("/api/production/:id",{preHandler:[authenticateRequest,requirePermission("production.edit")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const parsed=z.object({password:z.string().min(1).max(200)}).safeParse(request.body);
    if(!parsed.success)throw new AppError("PASSWORD_REQUIRED","أدخل كلمة مرور حسابك لتأكيد حذف سجل الإنتاج",422);
    const row=await withTransaction(async client=>{
      const actor=await client.query("SELECT password_hash FROM users WHERE id=$1 AND is_active=TRUE",[request.user!.userId]);
      if(!actor.rowCount || !verifyPassword(parsed.data.password,actor.rows[0].password_hash))throw new AppError("INVALID_PASSWORD","كلمة المرور غير صحيحة؛ لم يتم حذف سجل الإنتاج",401);
      const current=await getEntry(client,id,true);
      if(!current)throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",404);
      await assertAccountingPeriodOpen(client,current.work_date instanceof Date?current.work_date.toISOString().slice(0,10):String(current.work_date).slice(0,10));
      if(current.status!=="PENDING")throw new AppError("PRODUCTION_DELETE_LOCKED","يمكن حذف الإنتاج المعلّق فقط. الإنتاج المعتمد له أثر مخزني ومستحقات، ويحتاج إجراء عكس معتمد حتى لا تتلخبط الأرصدة.",409);
      const updated=await client.query("UPDATE production_entries SET status='CANCELLED',updated_at=now() WHERE id=$1 RETURNING id,code,status,employee_id,order_stage_id,quantity,work_date",[id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"cancel",module:"production",entityType:"production_entry",entityId:id,beforeData:current,afterData:updated.rows[0],metadata:{reason:"password_confirmed_delete"},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:row};
  });

  app.patch("/api/production/:id",{preHandler:[authenticateRequest,requirePermission("production.edit")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const parsed=z.object({
      employeeId:z.string().uuid().optional(),
      orderStageId:z.string().uuid().nullable().optional(),
      productionTypeId:z.string().uuid().nullable().optional(),
      productId:z.string().uuid().optional(),
      stageId:z.string().uuid().optional(),
      shiftId:z.string().uuid().optional(),
      shiftLeaderEmployeeId:z.string().uuid().nullable().optional(),
      workDate:z.string().date().optional(),
      quantity:z.number().positive().optional(),
      baseAmount:z.number().nonnegative().nullable().optional(),
      hoursWorked:z.number().positive().nullable().optional(),
      rateOverride:z.number().nonnegative().nullable().optional(),
      bonusAmount:z.number().nonnegative().optional(),
      bonusReason:z.string().trim().max(500).nullable().optional(),
      deductionAmount:z.number().nonnegative().optional(),
      deductionReason:z.string().trim().max(500).nullable().optional()
    }).refine(v=>Object.keys(v).length>0).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات تعديل الإنتاج غير صحيحة",422);
    const row=await withTransaction(async client=>{
      const current=await getEntry(client,id,true);
      if(!current)throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",404);
      const originalWorkDate=current.work_date instanceof Date?current.work_date.toISOString().slice(0,10):String(current.work_date).slice(0,10);
      await assertAccountingPeriodOpen(client,originalWorkDate);
      if(current.status!=="PENDING")throw new AppError("PRODUCTION_EDIT_LOCKED","لا يمكن تعديل إنتاج تم اعتماده أو رفضه. استخدم إجراء العكس المعتمد بدل تعديل سجل مرحّل.",409);
      const data=parsed.data;
      const employeeId=data.employeeId??current.employee_id;
      const shiftId=data.shiftId??current.shift_id;
      const workDate=data.workDate??String(current.work_date).slice(0,10);
      if(workDate!==originalWorkDate)await assertAccountingPeriodOpen(client,workDate);
      const quantity=data.quantity??Number(current.quantity);
      const baseAmount=data.baseAmount===undefined?(current.base_amount==null?null:Number(current.base_amount)):data.baseAmount;
      const hoursWorked=data.hoursWorked===undefined?(current.hours_worked==null?null:Number(current.hours_worked)):data.hoursWorked;
      const bonusAmount=data.bonusAmount??Number(current.bonus_amount??0);
      const deductionAmount=data.deductionAmount??Number(current.deduction_amount??0);
      const orderStageId=data.orderStageId===undefined?current.order_stage_id:data.orderStageId;
      let productId=data.productId??current.product_id;
      let stageId=data.stageId??current.stage_id;
      let productionTypeId=data.productionTypeId===undefined?current.production_type_id:data.productionTypeId;
      const bonusReason=data.bonusReason?.trim()||null;
      const deductionReason=data.deductionReason?.trim()||null;
      const oldAdjustments=await client.query("SELECT adjustment_type,reason FROM employee_earnings_adjustments WHERE production_entry_id=$1 AND ledger_id IS NULL ORDER BY created_at DESC",[id]);
      const oldBonusReason=oldAdjustments.rows.find((a:any)=>a.adjustment_type==="BONUS")?.reason as string|undefined;
      const oldDeductionReason=oldAdjustments.rows.find((a:any)=>a.adjustment_type==="DEDUCTION")?.reason as string|undefined;
      const finalBonusReason=data.bonusReason===undefined?oldBonusReason:bonusReason??undefined;
      const finalDeductionReason=data.deductionReason===undefined?oldDeductionReason:deductionReason??undefined;
      if(bonusAmount>0&&!finalBonusReason)throw new AppError("BONUS_REASON_REQUIRED","بيان البونص مطلوب",422);
      if(deductionAmount>0&&!finalDeductionReason)throw new AppError("DEDUCTION_REASON_REQUIRED","بيان الخصم مطلوب",422);
      const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[employeeId]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
      const shift=await client.query("SELECT id,rate_group_id FROM shifts WHERE id=$1 AND is_active=TRUE",[shiftId]);
      if(!shift.rowCount)throw new AppError("SHIFT_NOT_FOUND","الوردية غير موجودة أو غير نشطة",422);
      if(data.shiftLeaderEmployeeId){
        const leader=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[data.shiftLeaderEmployeeId]);
        if(!leader.rowCount)throw new AppError("SHIFT_LEADER_NOT_FOUND","مسؤول الوردية غير موجود أو غير نشط",422);
        const assignment=await client.query("SELECT 1 FROM shift_leaders WHERE employee_id=$1 AND shift_id=$2 AND is_active=TRUE AND (starts_on IS NULL OR starts_on<=$3::date) AND (ends_on IS NULL OR ends_on>=$3::date) LIMIT 1",[data.shiftLeaderEmployeeId,shiftId,workDate]);
        if(!assignment.rowCount)throw new AppError("SHIFT_LEADER_NOT_ASSIGNED","مسؤول الوردية غير مكلف بهذه الوردية في تاريخ الإنتاج",422);
      }
      let warehouseId=current.warehouse_id;
      let locationId=current.location_id;
      let orderStage:any=null;
      if(orderStageId){
        // Keep the same parent-order -> stage lock order used by production creation
        // and order maintenance to avoid lock inversion under concurrent edits.
        const stageRef=await client.query("SELECT order_id FROM order_stages WHERE id=$1",[orderStageId]);
        if(!stageRef.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const parentOrder=await client.query("SELECT id FROM production_orders WHERE id=$1 FOR UPDATE",[stageRef.rows[0].order_id]);
        if(!parentOrder.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
        const os=await client.query(
          `SELECT os.id,os.order_id,os.stage_id,os.output_product_id,os.sequence_no,os.is_final_product,os.status AS stage_status,
                  os.stage_rate,os.stage_rate_method,os.stage_rate_unit_id,os.production_type_id AS stage_production_type_id,
                  po.status AS order_status
             FROM order_stages os JOIN production_orders po ON po.id=os.order_id
            WHERE os.id=$1 FOR UPDATE OF os`,
          [orderStageId]
        );
        if(!os.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        orderStage=os.rows[0];
        if(["CANCELLED","DRAFT","COMPLETED"].includes(orderStage.order_status)||["CANCELLED","COMPLETED"].includes(orderStage.stage_status))
          throw new AppError("ORDER_STAGE_LOCKED","لا يمكن ربط الإنتاج بطلبية أو مرحلة غير نشطة",409);
        if(!orderStage.output_product_id)throw new AppError("ORDER_STAGE_PRODUCT_REQUIRED","المرحلة لا تحتوي على منتج ناتج محدد",422);
        productId=orderStage.output_product_id;
        stageId=orderStage.stage_id;
        productionTypeId=orderStage.stage_production_type_id??productionTypeId;
        const finalStage=await client.query("SELECT MAX(sequence_no) AS max_sequence,BOOL_OR(is_final_product) AS has_explicit_final FROM order_stages WHERE order_id=$1 AND status<>'CANCELLED'",[orderStage.order_id]);
        const warehouseType=Boolean(orderStage.is_final_product)||(!Boolean(finalStage.rows[0]?.has_explicit_final)&&Number(orderStage.sequence_no)===Number(finalStage.rows[0]?.max_sequence))?"FINISHED_GOODS":"WIP";
        const wh=await client.query("SELECT id FROM warehouses WHERE warehouse_type=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",[warehouseType]);
        if(!wh.rowCount)throw new AppError("VIRTUAL_WAREHOUSE_MISSING","المخزن الافتراضي للإنتاج غير مُجهز",500);
        warehouseId=wh.rows[0].id;
      }
      const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",[productId]);
      if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود أو غير نشط",422);
      const stage=await client.query("SELECT id FROM stages WHERE id=$1 AND is_active=TRUE",[stageId]);
      if(!stage.rowCount)throw new AppError("STAGE_NOT_FOUND","المرحلة غير موجودة أو غير نشطة",422);
      if(warehouseId){
        const loc=await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[locationId,warehouseId]);
        if(!loc.rowCount){
          const first=await client.query("SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",[warehouseId]);
          if(!first.rowCount)throw new AppError("DESTINATION_NOT_FOUND","لا توجد وجهة تخزين نشطة للمخزن المحدد",422);
          locationId=first.rows[0].id;
        }
      }
      const stagePrice=orderStage&&orderStage.stage_rate!=null?orderStage:null;
      const rateResult=stagePrice?await client.query(
        `SELECT NULL::uuid AS id,wt.id AS wage_type_id,$1::numeric AS rate,
                COALESCE($2::uuid,pr.unit_id) AS unit_id,$3::uuid AS production_type_id,
                wt.code AS wage_type_code,wt.method,wt.percentage_base
           FROM wage_types wt CROSS JOIN products pr
          WHERE pr.id=$4 AND wt.method=$5 AND wt.is_active=TRUE
          ORDER BY CASE WHEN wt.percentage_base='ORDER_VALUE' THEN 0 ELSE 1 END,wt.created_at,wt.id LIMIT 1`,
        [Number(stagePrice.stage_rate),stagePrice.stage_rate_unit_id??null,productionTypeId??null,productId,stagePrice.stage_rate_method]
      ):await client.query(
        `SELECT r.id,r.rate,r.wage_type_id,r.unit_id,r.production_type_id,wt.code AS wage_type_code,
                wt.method,wt.percentage_base
           FROM rates r JOIN wage_types wt ON wt.id=r.wage_type_id
          WHERE r.is_active=TRUE AND r.stage_id=$2 AND (r.rate_group_id=$3 OR r.rate_group_id IS NULL)
            AND (r.product_id=$1 OR r.product_id IS NULL)
            AND ($5::uuid IS NULL OR r.production_type_id=$5 OR r.production_type_id IS NULL)
            AND $4::date <@ r.effective_range
          ORDER BY CASE WHEN $5::uuid IS NOT NULL AND r.production_type_id=$5 THEN 0 WHEN r.production_type_id IS NULL THEN 1 ELSE 2 END,
            CASE WHEN r.product_id=$1 AND r.stage_id=$2 AND r.rate_group_id=$3 THEN 1
                 WHEN r.product_id IS NULL AND r.stage_id=$2 AND r.rate_group_id=$3 THEN 2
                 WHEN r.product_id=$1 AND r.stage_id=$2 THEN 3
                 WHEN r.product_id IS NULL AND r.stage_id=$2 THEN 4 ELSE 99 END,
            r.created_at DESC LIMIT 1`,
        [productId,stageId,shift.rows[0].rate_group_id,workDate,productionTypeId??null]
      );
      if(!rateResult.rowCount)throw new AppError("RATE_NOT_FOUND","لا يوجد سعر مطابق للمنتج والمرحلة والوردية والتاريخ",422);
      const rate=rateResult.rows[0];
      const method=String(rate.method);
      const rateContextChanged=productId!==current.product_id||stageId!==current.stage_id||shiftId!==current.shift_id||
        workDate!==String(current.work_date).slice(0,10)||productionTypeId!==current.production_type_id||orderStageId!==current.order_stage_id;
      const canUseOverride=!stagePrice&&data.rateOverride!=null;
      const submittedRate=Number(data.rateOverride);
      const preservesExistingRate=canUseOverride&&!rateContextChanged&&submittedRate===Number(current.rate_snapshot);
      const hasOverridePermission=await hasPermission(client,request.user!.userId,"production.rate_override");
      if(canUseOverride&&submittedRate!==Number(rate.rate)&&!preservesExistingRate&&!hasOverridePermission)
        throw new AppError("FORBIDDEN","ليس لديك صلاحية تعديل سعر الإنتاج",403);
      const effectiveRate=stagePrice?Number(rate.rate):(canUseOverride&&(hasOverridePermission||preservesExistingRate)?submittedRate:Number(rate.rate));
      let earning=Number(current.earning_amount);
      if(method==="PER_PIECE")earning=quantity*effectiveRate;
      else if(method==="PER_1000")earning=quantity/1000*effectiveRate;
      else if(method==="PER_DAY")earning=effectiveRate;
      else if(method==="PER_HOUR"){
        if(!hoursWorked||hoursWorked<=0)throw new AppError("HOURS_WORKED_REQUIRED","أدخل عدد ساعات صحيحًا لهذا النوع من الأجر",422);
        earning=hoursWorked*effectiveRate;
      }else if(method==="PERCENTAGE"){
        if(baseAmount===null||baseAmount===undefined)throw new AppError("BASE_AMOUNT_REQUIRED","أدخل قيمة الأساس لحساب أجر النسبة",422);
        earning=baseAmount*Number(rate.rate)/100;
      }else throw new AppError("WAGE_METHOD_UNSUPPORTED","طريقة حساب الأجر غير مدعومة",422);
      if(!Number.isFinite(earning)||earning<0)throw new AppError("EARNING_CALCULATION_ERROR","تعذر حساب مستحق الإنتاج بشكل صحيح",422);
      if(earning+bonusAmount<deductionAmount)throw new AppError("DEDUCTION_EXCEEDS_EARNING","الخصم لا يمكن أن يجعل إجمالي مستحق الإنتاج بالسالب",422);
      const unitId=rate.unit_id??product.rows[0].unit_id;
      await client.query(
        `UPDATE production_entries SET employee_id=$1,order_stage_id=$2,production_type_id=$3,product_id=$4,stage_id=$5,shift_id=$6,
          work_date=$7,quantity=$8,unit_id=$9,hours_worked=$10,warehouse_id=$11,location_id=$12,shift_leader_employee_id=$13,
          rate_id=$14,rate_snapshot=$15,wage_type_id=$16,wage_type_code_snapshot=$17,wage_type_method_snapshot=$18,
          percentage_base_snapshot=$19,base_amount=$20,earning_amount=$21,bonus_amount=$22,deduction_amount=$23,updated_at=now()
          WHERE id=$24`,
        [employeeId,orderStageId??null,productionTypeId??null,productId,stageId,shiftId,workDate,quantity,unitId,hoursWorked,warehouseId,locationId,
         data.shiftLeaderEmployeeId===undefined?current.shift_leader_employee_id:data.shiftLeaderEmployeeId,
         rate.id??null,effectiveRate,rate.wage_type_id,rate.wage_type_code,method,rate.percentage_base??null,baseAmount,earning,bonusAmount,deductionAmount,id]
      );
      await client.query("DELETE FROM employee_earnings_adjustments WHERE production_entry_id=$1 AND ledger_id IS NULL",[id]);
      if(bonusAmount>0)await client.query(
        `INSERT INTO employee_earnings_adjustments(employee_id,shift_id,production_entry_id,adjustment_type,amount,reason,adjustment_date,created_by)
         VALUES($1,$2,$3,'BONUS',$4,$5,$6,$7)`,
        [employeeId,shiftId,id,bonusAmount,finalBonusReason!,workDate,request.user!.userId]
      );
      if(deductionAmount>0)await client.query(
        `INSERT INTO employee_earnings_adjustments(employee_id,shift_id,production_entry_id,adjustment_type,amount,reason,adjustment_date,created_by)
         VALUES($1,$2,$3,'DEDUCTION',$4,$5,$6,$7)`,
        [employeeId,shiftId,id,deductionAmount,finalDeductionReason!,workDate,request.user!.userId]
      );
      const updated=await getEntry(client,id);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"edit",module:"production",entityType:"production_entry",entityId:id,beforeData:current,afterData:updated,metadata:{editedFields:Object.keys(data)},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated;
    });
    return {data:row};
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
      await assertAccountingPeriodOpen(client, current.work_date instanceof Date ? current.work_date.toISOString().slice(0,10) : String(current.work_date).slice(0,10));
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

      // Match warehouse movement lock order: serialize all stock mutations by product
      // before locking/inserting a location balance. This also protects the
      // first production receipt when no stock_balances row exists yet.
      const stockProduct = await client.query(
        "SELECT id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE FOR UPDATE",
        [current.product_id]
      );
      if (!stockProduct.rowCount) {
        throw new AppError("PRODUCT_NOT_INVENTORIED", "المنتج غير موجود أو غير متابع مخزنيًا", 409);
      }

      const scrapResult = await client.query(
        "SELECT COALESCE(SUM(quantity),0) AS quantity FROM production_scrap_records WHERE production_entry_id=$1",
        [id]
      );
      const recordedScrapQuantity = Number(scrapResult.rows[0]?.quantity ?? 0);
      if (recordedScrapQuantity > Number(current.quantity) + 1e-9) {
        throw new AppError("SCRAP_EXCEEDS_PRODUCTION", "إجمالي الهالك المسجل يتجاوز كمية الإنتاج", 409);
      }
      // Production quantity is the gross processed amount. Only good units enter
      // the regular warehouse; pre-approval scrap was already received separately.
      const grossQuantity = Number(current.quantity);
      const methodSnapshot = String(current.wage_type_method_snapshot ?? "");
      const goodQuantity = Math.max(0, grossQuantity - recordedScrapQuantity);
      const approvedEarning = methodSnapshot === "PER_PIECE"
        ? goodQuantity * Number(current.rate_snapshot)
        : methodSnapshot === "PER_1000"
          ? goodQuantity / 1000 * Number(current.rate_snapshot)
          : Number(current.earning_amount);
      if (!Number.isFinite(approvedEarning) || approvedEarning < 0) {
        throw new AppError("EARNING_CALCULATION_ERROR", "تعذر حساب مستحق الإنتاج الصالح بعد خصم الهالك", 409);
      }
      await client.query("UPDATE production_entries SET earning_amount=$1, updated_at=now() WHERE id=$2", [approvedEarning, id]);
      const totalLaborCost = approvedEarning + Number(current.bonus_amount ?? 0) - Number(current.deduction_amount ?? 0);
      const productionUnitCost = goodQuantity > 0 ? Math.max(0,totalLaborCost) / goodQuantity : 0;
      const goodInventoryValue = goodQuantity * productionUnitCost;
      const lockedBalance = await client.query(
        "SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
        [current.product_id, current.warehouse_id, current.location_id]
      );
      const currentBalance = Number(lockedBalance.rows[0]?.quantity ?? 0);
      const currentValue = Number(lockedBalance.rows[0]?.inventory_value ?? 0);
      const currentAvg = Number(lockedBalance.rows[0]?.avg_unit_cost ?? 0);
      if (goodQuantity > 0) {
        const nextBalance = currentBalance + goodQuantity;
        const nextValue = currentValue + goodInventoryValue;
        const nextAvg = nextBalance > 0 ? nextValue / nextBalance : currentAvg;
        if (lockedBalance.rowCount) {
          await client.query(
            "UPDATE stock_balances SET quantity=$1,avg_unit_cost=$2,inventory_value=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",
            [nextBalance,nextAvg,nextValue,current.product_id,current.warehouse_id,current.location_id]
          );
        } else {
          await client.query(
            "INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity,avg_unit_cost,inventory_value) VALUES($1,$2,$3,$4,$5,$6)",
            [current.product_id,current.warehouse_id,current.location_id,goodQuantity,productionUnitCost,goodInventoryValue]
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
            current.product_id,current.warehouse_id,current.location_id,goodQuantity,current.unit_id,
            productionUnitCost,goodInventoryValue,current.order_id??null,current.order_stage_id??null,
            "إدخال الإنتاج الصالح بعد استبعاد الهالك "+current.code,request.user!.userId,id
          ]
        );
      }

      const updated = await client.query(
        `UPDATE production_entries
            SET status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now()
          WHERE id=$2
          RETURNING *`,
        [request.user!.userId, id]
      );

      if (current.order_stage_id) {
        const stageUpdate=await client.query(
          `UPDATE order_stages
              SET completed_quantity=completed_quantity+$1,
                  status=CASE
                    WHEN planned_quantity IS NOT NULL AND completed_quantity+$1 >= planned_quantity THEN 'COMPLETED'
                    WHEN status='PENDING' THEN 'IN_PROGRESS'
                    ELSE status
                  END,
                  completed_at=CASE
                    WHEN planned_quantity IS NOT NULL AND completed_quantity+$1 >= planned_quantity THEN COALESCE(completed_at,now())
                    ELSE completed_at
                  END
            WHERE id=$2
            RETURNING id,order_id,completed_quantity,status`,
          [goodQuantity,current.order_stage_id]
        );
        if(!stageUpdate.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب المرتبطة بالإنتاج غير موجودة",409);
        const orderCompletion=await client.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed
             FROM order_stages
            WHERE order_id=$1 AND status<>'CANCELLED'`,
          [stageUpdate.rows[0].order_id]
        );
        if(Number(orderCompletion.rows[0]?.total||0)>0 &&
           Number(orderCompletion.rows[0]?.total||0)===Number(orderCompletion.rows[0]?.completed||0)){
          await client.query(
            "UPDATE production_orders SET status='COMPLETED',updated_at=now() WHERE id=$1 AND status NOT IN ('CANCELLED','COMPLETED')",
            [stageUpdate.rows[0].order_id]
          );
        }
      }

      if (goodQuantity > 0) {
        await createInventoryLot(client,{
          productId:current.product_id,
          warehouseId:current.warehouse_id,
          locationId:current.location_id,
          quantity:goodQuantity,
          unitCost:productionUnitCost,
          batchCode:current.code,
          sourceType:"PRODUCTION",
          sourceId:id
        });
      }

      await client.query(
        `INSERT INTO employee_earnings_ledger(
           employee_id,entry_type,credit_amount,production_entry_id,created_by,notes
         )
         VALUES($1,'PRODUCTION_APPROVAL',$2,$3,$4,'Approved production earning')
         ON CONFLICT DO NOTHING`,
        [current.employee_id, approvedEarning, id, request.user!.userId]
      );

      // Advance repayment is intentionally not posted when production is approved.
      // It is settled when the employee is actually paid, so production cost remains gross
      // and the cash-custody payout can be split into gross due and advance recovery.
      const adjustments = await client.query(
        `SELECT id,adjustment_type,amount,reason
           FROM employee_earnings_adjustments
          WHERE production_entry_id=$1 AND ledger_id IS NULL
          ORDER BY created_at,id
          FOR UPDATE`,
        [id]
      );
      for (const adjustment of adjustments.rows) {
        const credit = adjustment.adjustment_type === "BONUS" ? Number(adjustment.amount) : 0;
        const debit = adjustment.adjustment_type === "DEDUCTION" ? Number(adjustment.amount) : 0;
        const ledger = await client.query(
          `INSERT INTO employee_earnings_ledger(
             employee_id,entry_type,credit_amount,debit_amount,production_entry_id,created_by,notes
           ) VALUES($1,'ADJUSTMENT',$2,$3,$4,$5,$6)
           RETURNING id`,
          [current.employee_id,credit,debit,null,request.user!.userId,adjustment.reason]
        );
        await client.query("UPDATE employee_earnings_adjustments SET ledger_id=$1 WHERE id=$2",[ledger.rows[0].id,adjustment.id]);
      }

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

  app.post("/api/production/:id/reverse",{
    preHandler:[authenticateRequest,requirePermission("production.cancel")]
  },async(request)=>{
    const id=(request.params as {id:string}).id;
    const parsed=z.object({password:z.string().min(1).max(200),reason:z.string().trim().min(3).max(500)}).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","أدخل كلمة المرور وسبب التراجع (٣ أحرف على الأقل)",422);
    const result=await withTransaction(async client=>{
      const actor=await client.query("SELECT password_hash FROM users WHERE id=$1 AND is_active=TRUE",[request.user!.userId]);
      if(!actor.rowCount||!verifyPassword(parsed.data.password,actor.rows[0].password_hash))throw new AppError("INVALID_PASSWORD","كلمة المرور غير صحيحة؛ لم يتم التراجع",401);
      const current=await getEntry(client,id,true);
      if(!current)throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",404);
      if(current.status!=="APPROVED")throw new AppError("REVERSAL_REQUIRES_APPROVED","التراجع العكسي متاح لسجل إنتاج معتمد فقط؛ السجلات المعلقة يمكن إلغاؤها مباشرة",409);
      await assertAccountingPeriodOpen(client,current.work_date instanceof Date?current.work_date.toISOString().slice(0,10):String(current.work_date).slice(0,10));
      const paid=await client.query("SELECT 1 FROM worker_payment_allocations WHERE production_entry_id=$1 LIMIT 1 FOR SHARE",[id]);
      if(paid.rowCount)throw new AppError("PRODUCTION_ALREADY_PAID","لا يمكن عكس إنتاج تم تخصيص دفعة مالية له. عالج دفعة العامل أولًا حتى لا يتغير رصيد المستحقات بأثر رجعي.",409);
      const scrap=await client.query("SELECT 1 FROM production_scrap_records WHERE production_entry_id=$1 LIMIT 1 FOR SHARE",[id]);
      if(scrap.rowCount)throw new AppError("PRODUCTION_HAS_SCRAP","لا يمكن عكس إنتاج مسجل عليه هالك؛ عالج حركات الهالك والمخزون أولًا.",409);
      const lot=await client.query("SELECT * FROM inventory_lots WHERE source_type='PRODUCTION' AND source_id=$1 FOR UPDATE",[id]);
      if(!lot.rowCount)throw new AppError("PRODUCTION_LOT_MISSING","تعذر العثور على دفعة المخزون الناتجة عن هذا الإنتاج؛ لم يتم التراجع",409);
      const sourceLot=lot.rows[0];
      const originalQty=Number(sourceLot.original_quantity);
      const remainingQty=Number(sourceLot.remaining_quantity);
      if(Math.abs(remainingQty-originalQty)>0.0005)throw new AppError("PRODUCTION_STOCK_ALREADY_USED","لا يمكن التراجع لأن جزءًا من إنتاج العملية تم صرفه أو استهلاكه من المخزن. عالج الحركات التابعة أولًا.",409);
      const balance=await client.query("SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[current.product_id,current.warehouse_id,current.location_id]);
      if(!balance.rowCount||Number(balance.rows[0].quantity)+0.0005<Number(current.quantity))throw new AppError("PRODUCTION_STOCK_BALANCE_CHANGED","رصيد المخزون الحالي لا يسمح بعكس الكمية كاملة",409);
      const nextQty=Number(balance.rows[0].quantity)-Number(current.quantity);
      const removedValue=Number(sourceLot.unit_cost)*Number(current.quantity);
      const nextValue=Math.max(0,Number(balance.rows[0].inventory_value)-removedValue);
      const nextAvg=nextQty>0?nextValue/nextQty:0;
      await client.query("UPDATE stock_balances SET quantity=$1,inventory_value=$2,avg_unit_cost=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",[nextQty,nextValue,nextAvg,current.product_id,current.warehouse_id,current.location_id]);
      const movement=await client.query(
        `INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,order_id,order_stage_id,notes,created_by,reference_type,reference_id)
         VALUES('OUT',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PRODUCTION_REVERSAL',$12) RETURNING id`,
        [current.product_id,current.warehouse_id,current.location_id,current.quantity,current.unit_id,sourceLot.unit_cost,removedValue,current.order_id??null,current.order_stage_id??null,"عكس إنتاج "+current.code+" — "+parsed.data.reason,request.user!.userId,id]
      );
      await client.query("INSERT INTO stock_movement_lots(movement_id,lot_id,quantity,unit_cost,total_cost) VALUES($1,$2,$3,$4,$5)",[movement.rows[0].id,sourceLot.id,current.quantity,sourceLot.unit_cost,removedValue]);
      await client.query("UPDATE inventory_lots SET remaining_quantity=0,updated_at=now() WHERE id=$1",[sourceLot.id]);
      const originalEarning=await client.query("SELECT employee_id,credit_amount FROM employee_earnings_ledger WHERE production_entry_id=$1 AND entry_type='PRODUCTION_APPROVAL' FOR UPDATE",[id]);
      if(!originalEarning.rowCount)throw new AppError("PRODUCTION_EARNING_MISSING","لا يوجد قيد مستحقات أصلي يمكن عكسه بأمان",409);
      if(Number(originalEarning.rows[0].credit_amount)>0){
        await client.query(
          "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,notes,created_by) VALUES($1,'ADJUSTMENT',0,$2,$3,$4)",
          [current.employee_id,Number(originalEarning.rows[0].credit_amount),"عكس مستحق الإنتاج "+current.code+" — "+parsed.data.reason,request.user!.userId]
        );
      }
      const adjustments=await client.query("SELECT adjustment_type,amount,reason FROM employee_earnings_adjustments WHERE production_entry_id=$1",[id]);
      for(const a of adjustments.rows){
        const amount=Number(a.amount);
        const credit=a.adjustment_type==="DEDUCTION"?amount:0;
        const debit=a.adjustment_type==="BONUS"?amount:0;
        if(amount>0)await client.query(
          "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,notes,created_by) VALUES($1,'ADJUSTMENT',$2,$3,$4,$5)",
          [current.employee_id,credit,debit,"عكس "+(a.adjustment_type==="BONUS"?"بونص":"خصم")+" إنتاج "+current.code+" — "+parsed.data.reason,request.user!.userId]
        );
      }
      if(current.order_stage_id){
        await client.query(
          `UPDATE order_stages SET completed_quantity=GREATEST(0,completed_quantity-$1),
             status=CASE
               WHEN planned_quantity IS NOT NULL AND GREATEST(0,completed_quantity-$1)>=planned_quantity THEN 'COMPLETED'
               WHEN GREATEST(0,completed_quantity-$1)=0 THEN 'PENDING'
               ELSE 'IN_PROGRESS'
             END,
             completed_at=CASE
               WHEN planned_quantity IS NOT NULL AND GREATEST(0,completed_quantity-$1)>=planned_quantity THEN completed_at
               WHEN GREATEST(0,completed_quantity-$1)=0 THEN NULL
               ELSE completed_at
             END
           WHERE id=$2`,
          [current.quantity,current.order_stage_id]
        );
        if(current.order_id){
          const stageState=await client.query(
            `SELECT COUNT(*)::int AS total,COUNT(*) FILTER(WHERE status='COMPLETED')::int AS completed
               FROM order_stages WHERE order_id=$1 AND status<>'CANCELLED'`,
            [current.order_id]
          );
          const nextOrderStatus=Number(stageState.rows[0]?.total||0)>0&&Number(stageState.rows[0]?.total)===Number(stageState.rows[0]?.completed)?"COMPLETED":"IN_PROGRESS";
          await client.query("UPDATE production_orders SET status=$1,updated_at=now() WHERE id=$2 AND status NOT IN ('CANCELLED','DRAFT')",[nextOrderStatus,current.order_id]);
        }
      }
      const updated=await client.query("UPDATE production_entries SET status='CANCELLED',cancelled_by=$1,cancelled_at=now(),updated_at=now() WHERE id=$2 RETURNING id,code,status,employee_id,quantity,work_date",[request.user!.userId,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"reverse",module:"production",entityType:"production_entry",entityId:id,beforeData:current,afterData:updated.rows[0],metadata:{reason:parsed.data.reason,stockMovementId:movement.rows[0].id,inventoryLotId:sourceLot.id},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:result};
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
  });  app.get("/api/production/adjustments",{preHandler:[authenticateRequest,requirePermission("production.adjustments.view")]},async(request)=>{
    const q=z.object({employeeId:z.string().uuid().optional(),productionEntryId:z.string().uuid().optional(),from:z.string().date().optional(),to:z.string().date().optional()}).safeParse(request.query);
    if(!q.success)throw new AppError("VALIDATION_ERROR","فلاتر البونص والخصم غير صحيحة",422);
    const params:unknown[]=[];const where:string[]=["(a.production_entry_id IS NULL OR p.status <> 'CANCELLED')"];
    if(q.data.employeeId){params.push(q.data.employeeId);where.push("a.employee_id=$"+params.length);}
    if(q.data.productionEntryId){params.push(q.data.productionEntryId);where.push("a.production_entry_id=$"+params.length);}
    if(q.data.from){params.push(q.data.from);where.push("a.adjustment_date>=$"+params.length);}
    if(q.data.to){params.push(q.data.to);where.push("a.adjustment_date<=$"+params.length);}
    const r=await pool.query(`
      SELECT a.id,a.code,a.adjustment_date,a.adjustment_type,a.amount,a.reason,
             e.code AS employee_code,e.full_name AS employee_name,
             s.code AS shift_code,s.name AS shift_name,
             p.code AS production_code
        FROM employee_earnings_adjustments a
        JOIN employees e ON e.id=a.employee_id
        LEFT JOIN shifts s ON s.id=a.shift_id
        LEFT JOIN production_entries p ON p.id=a.production_entry_id
       ${where.length?"WHERE "+where.join(" AND "):""}
       ORDER BY a.adjustment_date DESC,a.created_at DESC LIMIT 300`,params);
    return {data:r.rows};
  });

  app.post("/api/production/adjustments",{preHandler:[authenticateRequest,requirePermission("production.adjustments.create")]},async(request,reply)=>{
    const p=adjustmentSchema.safeParse(request.body);
    if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات البونص أو الخصم غير صحيحة",422);
    const row=await withTransaction(async client=>{
      await assertAccountingPeriodOpen(client,p.data.adjustmentDate??new Date().toISOString().slice(0,10));
      const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[p.data.employeeId]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
      if(p.data.shiftId){
        const assigned=await client.query("SELECT 1 FROM shift_employees WHERE shift_id=$1 AND employee_id=$2 AND is_active=TRUE",[p.data.shiftId,p.data.employeeId]);
        if(!assigned.rowCount)throw new AppError("EMPLOYEE_NOT_ASSIGNED_TO_SHIFT","الموظف غير مربوط بالوردية المحددة",422);
      }
      if(p.data.productionEntryId){
        const production=await client.query("SELECT employee_id FROM production_entries WHERE id=$1",[p.data.productionEntryId]);
        if(!production.rowCount)throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",422);
        if(production.rows[0].employee_id!==p.data.employeeId)throw new AppError("EMPLOYEE_PRODUCTION_MISMATCH","الإنتاج لا يخص الموظف المحدد",409);
      }
      const credit=p.data.adjustmentType==="BONUS"?p.data.amount:0;
      const debit=p.data.adjustmentType==="DEDUCTION"?p.data.amount:0;
      const ledger=await client.query(
        "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,notes,created_by) VALUES($1,'ADJUSTMENT',$2,$3,$4,$5) RETURNING id",
        [p.data.employeeId,credit,debit,p.data.reason,request.user!.userId]
      );
      const adjustment=await client.query(
        `INSERT INTO employee_earnings_adjustments(
          employee_id,shift_id,production_entry_id,adjustment_type,amount,reason,adjustment_date,ledger_id,created_by
        ) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8,$9) RETURNING *`,
        [p.data.employeeId,p.data.shiftId??null,p.data.productionEntryId??null,p.data.adjustmentType,p.data.amount,p.data.reason,p.data.adjustmentDate??null,ledger.rows[0].id,request.user!.userId]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"production",entityType:"employee_adjustment",entityId:adjustment.rows[0].id,afterData:adjustment.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return adjustment.rows[0];
    });
    return reply.code(201).send({data:row});
  });


 
  app.get("/api/production/earnings/settlement-eligible", { preHandler: [authenticateRequest, requirePermission("production.view")] }, async () => {
    const result = await pool.query(`
      SELECT e.id,e.code,e.full_name,
        COALESCE((SELECT SUM(COALESCE(p.total_earning_amount,p.earning_amount)) FROM production_entries p WHERE p.employee_id=e.id AND p.status='APPROVED'),0)
        + COALESCE((SELECT SUM(CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE -a.amount END)
                     FROM employee_earnings_adjustments a LEFT JOIN production_entries p ON p.id=a.production_entry_id
                    WHERE a.employee_id=e.id AND (a.production_entry_id IS NULL OR p.status='APPROVED')),0)
        - COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s WHERE s.employee_id=e.id),0)
        - COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
                     LEFT JOIN employee_earnings_settlements s ON s.worker_payment_id=wp.id
                    WHERE wp.employee_id=e.id AND s.id IS NULL),0) AS available_earnings,
        COALESCE((SELECT SUM(l.credit_amount-l.debit_amount) FROM employee_earnings_ledger l WHERE l.employee_id=e.id),0) AS account_balance,
        COALESCE((SELECT SUM(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0))
                    FROM advance_requests a WHERE a.employee_id=e.id AND a.status='PAID' AND a.repayment_status='OPEN'),0) AS outstanding_advances
      FROM employees e WHERE e.is_active=TRUE
      ORDER BY e.full_name
    `);
    return {data:result.rows};
  });

  app.get("/api/production/earnings/order-summary", { preHandler: [authenticateRequest, requirePermission("production.view")] }, async request => {
    const q=z.object({orderId:z.string().uuid().optional(),employeeId:z.string().uuid().optional()}).safeParse(request.query);
    if(!q.success)throw new AppError("VALIDATION_ERROR","فلاتر حساب الطلبيات غير صحيحة",422);
    const values:unknown[]=[];const filters:string[]=[];
    if(q.data.orderId){values.push(q.data.orderId);filters.push("order_id=$"+values.length);}
    if(q.data.employeeId){values.push(q.data.employeeId);filters.push("employee_id=$"+values.length);}
    const result=await pool.query(`
      WITH production_due AS (
        SELECT e.id AS employee_id,e.code AS employee_code,e.full_name AS employee_name,
               o.id AS order_id,o.code AS order_code,o.order_name,
               p.id AS production_entry_id,p.code AS production_code,p.work_date,
               GREATEST(COALESCE(p.total_earning_amount,p.earning_amount),0)::numeric(14,2) AS earned,
               COALESCE(a.paid_amount,0)::numeric(14,2) AS allocated_paid
          FROM production_entries p
          JOIN employees e ON e.id=p.employee_id
          JOIN order_stages os ON os.id=p.order_stage_id
          JOIN production_orders o ON o.id=os.order_id
          LEFT JOIN LATERAL (
            SELECT
              COALESCE((SELECT SUM(sa.amount) FROM employee_earnings_settlement_allocations sa
                         JOIN employee_earnings_settlements s ON s.id=sa.settlement_id
                        WHERE sa.production_entry_id=p.id),0)
              + COALESCE((SELECT SUM(wpa.amount) FROM worker_payment_order_allocations wpa
                           WHERE wpa.production_entry_id=p.id),0) AS paid_amount
          ) a ON TRUE
         WHERE p.status='APPROVED'
      )
      SELECT employee_id,employee_code,employee_name,order_id,order_code,order_name,
             COUNT(*)::int AS production_records,
             SUM(earned)::numeric(14,2) AS total_earned,
             SUM(allocated_paid)::numeric(14,2) AS paid_amount,
             GREATEST(SUM(earned)-SUM(allocated_paid),0)::numeric(14,2) AS remaining_amount,
             CASE WHEN SUM(earned)-SUM(allocated_paid)<=0.009 THEN 'PAID'
                  WHEN SUM(allocated_paid)>0.009 THEN 'PARTIAL' ELSE 'UNPAID' END AS payment_status
        FROM production_due
       ${filters.length ? "WHERE "+filters.join(" AND ") : ""}
       GROUP BY employee_id,employee_code,employee_name,order_id,order_code,order_name
       ORDER BY order_name,employee_name
    `,values);
    const unallocated=await pool.query(`
      SELECT e.id AS employee_id,e.full_name AS employee_name,
             COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s
                        WHERE s.employee_id=e.id AND NOT EXISTS(
                          SELECT 1 FROM employee_earnings_settlement_allocations a WHERE a.settlement_id=s.id
                        )),0)
             + COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
                          WHERE wp.employee_id=e.id
                            AND NOT EXISTS(SELECT 1 FROM employee_earnings_settlements s WHERE s.worker_payment_id=wp.id)
                            AND NOT EXISTS(SELECT 1 FROM worker_payment_order_allocations wpa WHERE wpa.worker_payment_id=wp.id)
                          ),0) AS unallocated_historical_payments
        FROM employees e
       WHERE e.is_active=TRUE AND ($1::uuid IS NULL OR e.id=$1)
       ORDER BY e.full_name
    `,[q.data.employeeId??null]);
    return {data:result.rows,unallocatedHistoricalPayments:unallocated.rows};
  });

  app.get("/api/production/earnings/settlements", { preHandler: [authenticateRequest, requirePermission("production.view")] }, async request => {
    const q=z.object({employeeId:z.string().uuid().optional()}).safeParse(request.query);
    if(!q.success)throw new AppError("VALIDATION_ERROR","فلتر الموظف غير صحيح",422);
    const values:unknown[]=[];let where="";
    if(q.data.employeeId){values.push(q.data.employeeId);where="WHERE s.employee_id=$1";}
    const result=await pool.query(`
      SELECT s.*,e.code AS employee_code,e.full_name AS employee_name,u.username AS created_by_username
        FROM employee_earnings_settlements s
        JOIN employees e ON e.id=s.employee_id
        LEFT JOIN users u ON u.id=s.created_by
        ${where}
       ORDER BY s.settlement_date DESC,s.created_at DESC LIMIT 300
    `,values);
    return {data:result.rows};
  });

  app.post("/api/production/earnings/settlements", { preHandler: [authenticateRequest, requirePermission("production.adjustments.create")] }, async (request,reply) => {
    const parsed=z.object({
      employeeId:z.string().uuid(),
      orderId:z.string().uuid().nullable().optional(),
      grossAmount:z.number().positive(),
      settlementDate:z.string().date().optional(),
      notes:z.string().trim().max(500).optional(),
      idempotencyKey:z.string().uuid().optional(),
      repayments:z.array(z.object({advanceId:z.string().uuid(),amount:z.number().positive()})).max(20).optional()
    }).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات صرف مستحقات العامل غير صحيحة",422);
    if(!request.user!.employeeId)throw new AppError("CUSTODY_EMPLOYEE_REQUIRED","اربط حساب الصارف بملف موظف/عهدة قبل صرف المستحقات",409);
    const result=await withTransaction(async client=>{
      await assertAccountingPeriodOpen(client,parsed.data.settlementDate??new Date().toISOString().slice(0,10));
      const employee=await client.query("SELECT id,full_name FROM employees WHERE id=$1 AND is_active=TRUE FOR UPDATE",[parsed.data.employeeId]);
      if(!employee.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","العامل غير موجود أو غير نشط",404);
      if(parsed.data.idempotencyKey){
        const prior=await client.query("SELECT * FROM employee_earnings_settlements WHERE idempotency_key=$1 FOR SHARE",[parsed.data.idempotencyKey]);
        if(prior.rowCount) return {settlement:prior.rows[0],employee:employee.rows[0],availableBefore:0,grossAmount:Number(prior.rows[0].gross_amount),cashPaid:Number(prior.rows[0].cash_paid_amount),advanceRepaymentAmount:Number(prior.rows[0].advance_repayment_amount),repayments:[],idempotentReplay:true};
      }
      if(parsed.data.orderId){
        const legacy=await client.query(`
          SELECT COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s
                            WHERE s.employee_id=$1 AND NOT EXISTS(
                              SELECT 1 FROM employee_earnings_settlement_allocations a WHERE a.settlement_id=s.id
                            )),0)
               + COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
                            WHERE wp.employee_id=$1 AND NOT EXISTS(
                              SELECT 1 FROM employee_earnings_settlements s WHERE s.worker_payment_id=wp.id
                            )),0) AS unallocated
        `,[parsed.data.employeeId]);
        if(Number(legacy.rows[0].unallocated)>0.009)throw new AppError("HISTORICAL_PAYMENTS_NEED_ALLOCATION",`يوجد ${Number(legacy.rows[0].unallocated).toFixed(2)} ج.م من دفعات قديمة غير موزعة على طلبيات؛ راجعها قبل تسوية طلبية محددة حتى لا يتكرر الصرف.`,409);
      }
      const earnings=await client.query(`
        SELECT CASE WHEN $2::uuid IS NULL THEN
          COALESCE((SELECT SUM(p.earning_amount) FROM production_entries p WHERE p.employee_id=$1 AND p.status='APPROVED'),0)
          + COALESCE((SELECT SUM(CASE WHEN a.adjustment_type='BONUS' THEN a.amount ELSE -a.amount END)
                       FROM employee_earnings_adjustments a LEFT JOIN production_entries p ON p.id=a.production_entry_id
                      WHERE a.employee_id=$1 AND (a.production_entry_id IS NULL OR p.status='APPROVED')),0)
          - COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s WHERE s.employee_id=$1),0)
          - COALESCE((SELECT SUM(wp.gross_amount) FROM worker_payments wp
                       LEFT JOIN employee_earnings_settlements s ON s.worker_payment_id=wp.id
                      WHERE wp.employee_id=$1 AND s.id IS NULL),0)
        ELSE
          COALESCE((SELECT SUM(COALESCE(p.total_earning_amount,p.earning_amount)) FROM production_entries p
                     JOIN order_stages os ON os.id=p.order_stage_id
                    WHERE p.employee_id=$1 AND os.order_id=$2 AND p.status='APPROVED'),0)
          - COALESCE((SELECT SUM(a.amount) FROM employee_earnings_settlement_allocations a
                       JOIN production_entries p ON p.id=a.production_entry_id
                       JOIN order_stages os ON os.id=p.order_stage_id
                      WHERE p.employee_id=$1 AND os.order_id=$2),0)
        END AS available
      `,[parsed.data.employeeId,parsed.data.orderId??null]);
      const available=Math.round(Number(earnings.rows[0].available)*100)/100;
      if(parsed.data.grossAmount>available+0.009)throw new AppError("SETTLEMENT_EXCEEDS_EARNINGS",`المستحقات المتاحة للعامل ${available.toFixed(2)} جنيه فقط`,409);
      const date=parsed.data.settlementDate??new Date().toISOString().slice(0,10);
      const advances=await client.query(`
        SELECT a.*,
          GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS outstanding,
          (SELECT MAX(ar.payment_date) FROM advance_repayments ar WHERE ar.advance_id=a.id) AS last_repayment_date
        FROM advance_requests a
        WHERE a.employee_id=$1 AND a.status='PAID' AND a.repayment_status='OPEN'
          AND a.repayment_method='PRODUCTION_PERCENTAGE'
        ORDER BY a.paid_at,a.created_at,a.id FOR UPDATE
      `,[parsed.data.employeeId]);
      const repaymentPlan:Array<{advance:any;amount:number;type:string;notes:string}>=[];
      let remaining=parsed.data.grossAmount;
      for(const advance of advances.rows){
        if(remaining<=0)break;
        const startValue=advance.last_repayment_date??advance.paid_at;
        const startDate=startValue instanceof Date?startValue.toISOString().slice(0,10):String(startValue).slice(0,10);
        const elapsed=Math.floor((Date.parse(date+"T00:00:00Z")-Date.parse(startDate+"T00:00:00Z"))/86400000);
        const periodDays=Number(advance.production_period_days??15);
        if(elapsed<periodDays)continue;
        const duePeriods=Math.max(1,Math.floor(elapsed/periodDays));
        const production=await client.query(
          `SELECT GREATEST(0,
             COALESCE(SUM(COALESCE(p.total_earning_amount,p.earning_amount)),0)
             -COALESCE((SELECT SUM(s.gross_amount) FROM employee_earnings_settlements s WHERE s.employee_id=$1 AND s.settlement_date>$2::date AND s.settlement_date<=$3::date),0)
           ) AS amount
             FROM production_entries p
            WHERE p.employee_id=$1 AND p.status='APPROVED' AND p.work_date>$2::date AND p.work_date<=$3::date`,
          [parsed.data.employeeId,startDate,date]
        );
        const legacyPaid=await client.query(
          `SELECT COALESCE(SUM(wp.gross_amount),0) AS amount FROM worker_payments wp
             LEFT JOIN employee_earnings_settlements s ON s.worker_payment_id=wp.id
            WHERE wp.employee_id=$1 AND s.id IS NULL AND wp.created_at::date>$2::date AND wp.created_at::date<=$3::date`,
          [parsed.data.employeeId,startDate,date]
        );
        const periodEarning=Math.max(0,Number(production.rows[0].amount)-Number(legacyPaid.rows[0].amount));
        if(advance.production_minimum_earning!==null&&advance.production_minimum_earning!==undefined&&periodEarning<Number(advance.production_minimum_earning))continue;
        const scheduled=advance.production_installment_amount!==null
          ? Number(advance.production_installment_amount)*duePeriods
          : periodEarning*Number(advance.production_percentage??0)/100;
        const amount=Math.round(Math.min(Number(advance.outstanding),scheduled,remaining)*100)/100;
        if(amount<=0)continue;
        repaymentPlan.push({advance,amount,type:"PRODUCTION_PERCENTAGE",notes:`استقطاع دوري من مستحقات إنتاج ${employee.rows[0].full_name} لسداد السلفة ${advance.code}`});
        remaining=Math.round((remaining-amount)*100)/100;
      }
      for(const manual of parsed.data.repayments??[]){
        if(remaining<=0)throw new AppError("REPAYMENT_EXCEEDS_SETTLEMENT","مبلغ سداد السلف أكبر من المستحق المتاح",422);
        if(repaymentPlan.some(x=>x.advance.id===manual.advanceId))throw new AppError("DUPLICATE_ADVANCE_REPAYMENT","السلفة محددة أكثر من مرة",422);
        const advance=await client.query("SELECT a.*,GREATEST(a.amount-COALESCE((SELECT SUM(ar.amount) FROM advance_repayments ar WHERE ar.advance_id=a.id),0),0) AS outstanding FROM advance_requests a WHERE a.id=$1 AND a.employee_id=$2 AND a.status='PAID' AND a.repayment_status='OPEN' FOR UPDATE",[manual.advanceId,parsed.data.employeeId]);
        if(!advance.rowCount)throw new AppError("ADVANCE_NOT_OPEN","السلفة المحددة غير مفتوحة أو لا تخص العامل",409);
        if(manual.amount>Number(advance.rows[0].outstanding)+0.009)throw new AppError("REPAYMENT_EXCEEDS_BALANCE","مبلغ السداد أكبر من باقي السلفة",409);
        if(manual.amount>remaining+0.009)throw new AppError("REPAYMENT_EXCEEDS_SETTLEMENT","مبلغ السداد أكبر من المستحق المتاح",409);
        repaymentPlan.push({advance:advance.rows[0],amount:Math.round(manual.amount*100)/100,type:"CUSTOM",notes:`سداد سلفة ${advance.rows[0].code} من مستحقات العامل`});
        remaining=Math.round((remaining-manual.amount)*100)/100;
      }
      const repaymentTotal=Math.round(repaymentPlan.reduce((sum,x)=>sum+x.amount,0)*100)/100;
      const cashPaid=Math.round((parsed.data.grossAmount-repaymentTotal)*100)/100;
      const settlement=await client.query(
        "INSERT INTO employee_earnings_settlements(employee_id,order_id,gross_amount,cash_paid_amount,advance_repayment_amount,settlement_date,notes,created_by,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [parsed.data.employeeId,parsed.data.orderId??null,parsed.data.grossAmount,cashPaid,repaymentTotal,date,parsed.data.notes??null,request.user!.userId,parsed.data.idempotencyKey??null]
      );
      // Allocate the settlement to the selected order's approved production rows (oldest first).
      // The transaction locks each production row and caps each allocation at its remaining due.
      let allocationRemaining=parsed.data.grossAmount;
      const eligibleEntries=await client.query(`
        SELECT p.id,GREATEST(COALESCE(p.total_earning_amount,p.earning_amount,0)
          -COALESCE((SELECT SUM(a.amount) FROM employee_earnings_settlement_allocations a WHERE a.production_entry_id=p.id),0),0) AS remaining
          FROM production_entries p
          LEFT JOIN order_stages os ON os.id=p.order_stage_id
         WHERE p.employee_id=$1 AND p.status='APPROVED'
           AND ($2::uuid IS NULL OR os.order_id=$2)
         ORDER BY p.work_date,p.created_at,p.id
         FOR UPDATE OF p
      `,[parsed.data.employeeId,parsed.data.orderId??null]);
      for(const entry of eligibleEntries.rows){
        if(allocationRemaining<=0.009)break;
        const amount=Math.round(Math.min(allocationRemaining,Number(entry.remaining))*100)/100;
        if(amount<=0)continue;
        await client.query("INSERT INTO employee_earnings_settlement_allocations(settlement_id,production_entry_id,amount) VALUES($1,$2,$3) ON CONFLICT(settlement_id,production_entry_id) DO NOTHING",[settlement.rows[0].id,entry.id,amount]);
        allocationRemaining=Math.round((allocationRemaining-amount)*100)/100;
      }
      if(parsed.data.orderId && allocationRemaining>0.009){
        throw new AppError("ORDER_SETTLEMENT_ALLOCATION_INCOMPLETE","تعذر توزيع كامل مبلغ التسوية على إنتاج الطلبية؛ راجع المستحقات المرتبطة بالطلبية قبل الاعتماد.",409);
      }
      for(const item of repaymentPlan){
        const repayment=await client.query(
          "INSERT INTO advance_repayments(advance_id,amount,repayment_type,payment_date,notes,created_by,settlement_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
          [item.advance.id,item.amount,item.type,date,item.notes,request.user!.userId,settlement.rows[0].id]
        );
        await client.query(
          `INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,advance_repayment_id,created_by,notes)
           VALUES($1,'ADJUSTMENT',$2,$3,$4,$5)
           ON CONFLICT (advance_repayment_id) WHERE advance_repayment_id IS NOT NULL DO NOTHING`,
          [parsed.data.employeeId,item.amount,repayment.rows[0].id,request.user!.userId,`سداد سلفة ${item.advance.code} من مستحقات الإنتاج`]
        );
        const next=Number(item.advance.outstanding)-item.amount;
        await client.query("UPDATE advance_requests SET repayment_status=$1,updated_at=now() WHERE id=$2",[next<=0.009?"SETTLED":"OPEN",item.advance.id]);
        await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"production_earnings_repayment",module:"advances",entityType:"advance_request",entityId:item.advance.id,metadata:{settlementId:settlement.rows[0].id,repaymentId:repayment.rows[0].id,amount:item.amount,remaining:Math.max(0,next)},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      }
      await client.query(
        `INSERT INTO employee_earnings_ledger(employee_id,entry_type,debit_amount,created_by,notes,settlement_id)
         VALUES($1,'ADJUSTMENT',$2,$3,$4,$5)
         ON CONFLICT (settlement_id) WHERE settlement_id IS NOT NULL DO NOTHING`,
        [parsed.data.employeeId,parsed.data.grossAmount,request.user!.userId,`تسوية إجمالي مستحقات إنتاج ${settlement.rows[0].id}؛ صافي النقد ${cashPaid.toFixed(2)} ج.م؛ خصم السلف ${repaymentTotal.toFixed(2)} ج.م`,settlement.rows[0].id]
      );
      const custodyBalance=await client.query(
        "SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN amount ELSE -amount END),0) AS balance FROM cash_custody_transactions WHERE employee_id=$1 AND transaction_date<=$2::date",
        [request.user!.employeeId,date]
      );
      if(cashPaid>Number(custodyBalance.rows[0]?.balance??0)+0.009)throw new AppError("INSUFFICIENT_CASH_CUSTODY_BALANCE","رصيد العهدة لا يكفي لصافي النقد المطلوب دفعه للعامل؛ لم يتم تسجيل التسوية",409);
      const cashOut=await client.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'OUT',$2,$3::date,$4,$5,'PRODUCTION_EARNINGS_SETTLEMENT',$6,$7) RETURNING id",
        [request.user!.employeeId,parsed.data.grossAmount,date,`تسوية إجمالي مستحقات إنتاج ${employee.rows[0].full_name}`,`صافي المدفوع ${cashPaid.toFixed(2)} ج.م؛ مسترد سلف ${repaymentTotal.toFixed(2)} ج.م`,settlement.rows[0].id,request.user!.userId]
      );
      let cashIn=null;
      if(repaymentTotal>0)cashIn=await client.query(
        "INSERT INTO cash_custody_transactions(employee_id,direction,amount,transaction_date,description,notes,source_type,source_id,created_by) VALUES($1,'IN',$2,$3::date,$4,$5,'ADVANCE_REPAYMENT_OFFSET',$6,$7) RETURNING id",
        [request.user!.employeeId,repaymentTotal,date,`استرداد سلفة من مستحقات ${employee.rows[0].full_name}`,repaymentPlan.map(x=>`${x.advance.code}: ${x.amount.toFixed(2)} ج.م`).join("؛ "),settlement.rows[0].id,request.user!.userId]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"settle_production_earnings",module:"production",entityType:"employee_earnings_settlement",entityId:settlement.rows[0].id,afterData:settlement.rows[0],metadata:{cashPaid,repaymentTotal,repayments:repaymentPlan.map(x=>({advanceId:x.advance.id,amount:x.amount})),cashCustodyOutId:cashOut.rows[0].id,cashCustodyInId:cashIn?.rows[0]?.id??null},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {settlement:settlement.rows[0],employee:employee.rows[0],availableBefore:available,grossAmount:parsed.data.grossAmount,cashPaid,advanceRepaymentAmount:repaymentTotal,repayments:repaymentPlan.map(x=>({advanceCode:x.advance.code,amount:x.amount,remaining:Math.max(0,Number(x.advance.outstanding)-x.amount)}))};
    });
    return reply.code(201).send({data:result});
  });

}
