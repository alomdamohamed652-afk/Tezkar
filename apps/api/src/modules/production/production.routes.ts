import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { hasPermission } from "../rbac/rbac.service.js";
import { createInventoryLot } from "../warehouse/inventory-lots.service.js";

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
  responsibleName: z.string().trim().max(200).nullable().optional(),
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
            pr.code AS product_code, pr.name AS product_name,
            st.code AS stage_code, st.name AS stage_name,
            os.order_id AS order_id,
            sh.code AS shift_code, sh.name AS shift_name,
            u.code AS unit_code, u.name AS unit_name
       FROM production_entries p
       JOIN employees e ON e.id=p.employee_id
       JOIN products pr ON pr.id=p.product_id
       JOIN stages st ON st.id=p.stage_id
       LEFT JOIN order_stages os ON os.id=p.order_stage_id
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
      `SELECT p.id,p.code,p.work_date,p.responsible_name,p.quantity,p.rate_snapshot,p.earning_amount,p.bonus_amount,p.deduction_amount,p.total_earning_amount,p.status,
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
    preHandler: [authenticateRequest, requirePermission("production.view_own","own")]
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

      let resolvedWarehouseId = parsed.data.warehouseId;
      if(parsed.data.orderStageId){
        const os0=await client.query("SELECT os.order_id,os.sequence_no FROM order_stages os WHERE os.id=$1",[parsed.data.orderStageId]);
        if(!os0.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const final0=await client.query("SELECT MAX(sequence_no) AS max_sequence FROM order_stages WHERE order_id=$1 AND status <> 'CANCELLED'",[os0.rows[0].order_id]);
        const type0=Number(os0.rows[0].sequence_no)===Number(final0.rows[0]?.max_sequence) ? "FINISHED_GOODS" : "WIP";
        const wh0=await client.query("SELECT id FROM warehouses WHERE warehouse_type=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",[type0]);
        if(!wh0.rowCount) throw new AppError("VIRTUAL_WAREHOUSE_MISSING","المخزن الافتراضي للإنتاج غير مُجهز",500);
        if (!parsed.data.warehouseId) resolvedWarehouseId=wh0.rows[0].id;
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
        const orderStage = await client.query(
          `SELECT os.id,os.order_id,os.output_product_id,os.stage_id,os.sequence_no,os.status AS stage_status,po.status AS order_status
             FROM order_stages os
             JOIN production_orders po ON po.id=os.order_id
            WHERE os.id=$1
            FOR UPDATE`,
          [parsed.data.orderStageId]
        );
        if (!orderStage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const os=orderStage.rows[0];
        if (os.order_status === "CANCELLED" || os.stage_status === "CANCELLED") throw new AppError("ORDER_CANCELLED","لا يمكن تسجيل إنتاج لمرحلة طلبية أو مرحلة ملغاة",409);
        const finalStage=await client.query("SELECT MAX(sequence_no) AS max_sequence FROM order_stages WHERE order_id=$1 AND status <> 'CANCELLED'",[os.order_id]);
        const warehouseType=Number(os.sequence_no)===Number(finalStage.rows[0]?.max_sequence) ? "FINISHED_GOODS" : "WIP";
        const virtualWarehouse=await client.query("SELECT id FROM warehouses WHERE warehouse_type=$1 AND is_active=TRUE ORDER BY created_at,id LIMIT 1",[warehouseType]);
        if(!virtualWarehouse.rowCount) throw new AppError("VIRTUAL_WAREHOUSE_MISSING","المخزن الافتراضي للإنتاج غير مُجهز",500);
        if (!parsed.data.warehouseId) resolvedWarehouseId=virtualWarehouse.rows[0].id;
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
      const rateResult = stagePrice ? {rowCount:1,rows:[{id:null,rate:Number(stagePrice.stage_rate),wage_type_id:null,unit_id:stagePrice.stage_rate_unit_id ?? product.rows[0].unit_id,production_type_id:parsed.data.productionTypeId ?? null,wage_type_code:stagePrice.stage_rate_method,wage_type_name:stagePrice.stage_rate_method,method:stagePrice.stage_rate_method,percentage_base:null}]} : await client.query(
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

      const unitId = rate.unit_id ?? product.rows[0].unit_id;

      const inserted = await client.query(
        `INSERT INTO production_entries(
           employee_id,order_stage_id,production_type_id,product_id,stage_id,shift_id,work_date,quantity,unit_id,hours_worked,warehouse_id,location_id,responsible_name,
           rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,
           wage_type_method_snapshot,percentage_base_snapshot,base_amount,earning_amount,
           bonus_amount,deduction_amount,submitted_by
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         RETURNING id,code,employee_id,order_stage_id,production_type_id,product_id,stage_id,shift_id,work_date,quantity,
                   unit_id,rate_id,rate_snapshot,wage_type_id,wage_type_code_snapshot,
                   wage_type_method_snapshot,percentage_base_snapshot,base_amount,
                   earning_amount,bonus_amount,deduction_amount,total_earning_amount,status,submitted_by,created_at`,
        [
          employeeId, parsed.data.orderStageId ?? null, parsed.data.productionTypeId ?? rate.production_type_id ?? null, parsed.data.productId, parsed.data.stageId, parsed.data.shiftId,
          parsed.data.workDate, parsed.data.quantity, unitId, parsed.data.hoursWorked ?? null, resolvedWarehouseId, resolvedLocationId, parsed.data.responsibleName?.trim() || null, rate.id, effectiveRate,
          rate.wage_type_id, rate.wage_type_code, rate.method, rate.percentage_base ?? null,
          parsed.data.baseAmount ?? null, earning, Number(parsed.data.bonusAmount ?? 0),
           Number(parsed.data.deductionAmount ?? 0), request.user!.userId
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

  app.patch("/api/production/:id",{preHandler:[authenticateRequest,requirePermission("production.edit")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const parsed=z.object({quantity:z.number().positive(),workDate:z.string().date().optional()}).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات تعديل الإنتاج غير صحيحة",422);
    const row=await withTransaction(async client=>{
      const current=await getEntry(client,id,true);
      if(!current)throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",404);
      if(current.status!=="PENDING")throw new AppError("PRODUCTION_EDIT_LOCKED","لا يمكن تعديل إنتاج تم اعتماده أو رفضه",409);
      const method=current.wage_type_method_snapshot as string;
      let earning=Number(current.earning_amount);
      if(method==="PER_PIECE")earning=parsed.data.quantity*Number(current.rate_snapshot);
      else if(method==="PER_1000")earning=parsed.data.quantity/1000*Number(current.rate_snapshot);
      const r=await client.query("UPDATE production_entries SET quantity=$1,work_date=COALESCE($2,work_date),earning_amount=$3,updated_at=now() WHERE id=$4 RETURNING id,code,quantity,work_date,earning_amount,status",[parsed.data.quantity,parsed.data.workDate??null,earning,id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"edit",module:"production",entityType:"production_entry",entityId:id,beforeData:{quantity:current.quantity,work_date:current.work_date,earning_amount:current.earning_amount},afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return r.rows[0];
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
        "SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",
        [current.product_id, current.warehouse_id, current.location_id]
      );
      const currentBalance = Number(lockedBalance.rows[0]?.quantity ?? 0);
      const currentValue = Number(lockedBalance.rows[0]?.inventory_value ?? 0);
      const currentAvg = Number(lockedBalance.rows[0]?.avg_unit_cost ?? 0);
      const totalLaborCost = Number(current.total_earning_amount ?? current.earning_amount);
      const productionUnitCost = Number(current.quantity) > 0 ? totalLaborCost / Number(current.quantity) : 0;
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
          [current.product_id,current.warehouse_id,current.location_id,current.quantity,productionUnitCost,totalLaborCost]
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
          productionUnitCost,totalLaborCost,current.order_id??null,current.order_stage_id??null,
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
          [current.quantity,current.order_stage_id]
        );
        if(!stageUpdate.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب المرتبطة بالإنتاج غير موجودة",409);
        const orderCompletion=await client.query(
          `SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status='COMPLETED')::int AS completed
             FROM order_stages
            WHERE order_id=$1`,
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

      await createInventoryLot(client,{
        productId:current.product_id,
        warehouseId:current.warehouse_id,
        locationId:current.location_id,
        quantity:Number(current.quantity),
        unitCost:productionUnitCost,
        batchCode:current.code,
        sourceType:"PRODUCTION",
        sourceId:id
      });

      await client.query(
        `INSERT INTO employee_earnings_ledger(
           employee_id,entry_type,credit_amount,production_entry_id,created_by,notes
         )
         VALUES($1,'PRODUCTION_APPROVAL',$2,$3,$4,'Approved production earning')
         ON CONFLICT (production_entry_id) DO NOTHING`,
        [current.employee_id, current.earning_amount, id, request.user!.userId]
      );

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
    const q=z.object({employeeId:z.string().uuid().optional(),from:z.string().date().optional(),to:z.string().date().optional()}).safeParse(request.query);
    if(!q.success)throw new AppError("VALIDATION_ERROR","فلاتر البونص والخصم غير صحيحة",422);
    const params:unknown[]=[];const where:string[]=[];
    if(q.data.employeeId){params.push(q.data.employeeId);where.push("a.employee_id=$"+params.length);}
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


}
