import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const orderSchema = z.object({
  customerName: z.string().trim().max(200).optional(),
  orderDate: z.string().date().optional(),
  dueDate: z.string().date().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().positive(),
    unitId: z.string().uuid(),
    notes: z.string().trim().max(500).optional()
  })).min(1),
  stages: z.array(z.object({
    stageId: z.string().uuid(),
    sequenceNo: z.number().int().positive(),
    plannedQuantity: z.number().nonnegative().optional()
  })).optional()
});

const machineSchema = z.object({
  name: z.string().trim().min(2).max(120),
  machineType: z.string().trim().max(120).optional()
});

const machineProductionSchema = z.object({
  orderStageId: z.string().uuid().nullable().optional(),
  machineId: z.string().uuid(),
  productId: z.string().uuid(),
  employeeId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  workDate: z.string().date(),
  quantity: z.number().positive(),
  unitId: z.string().uuid(),
  notes: z.string().trim().max(500).optional()
});

export async function orderRoutes(app: FastifyInstance) {
  app.get("/api/orders", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const q = z.object({ status: z.enum(["DRAFT","PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"]).optional() }).parse(request.query);
    const params: unknown[] = [];
    let where = "";
    if (q.status) { params.push(q.status); where = "WHERE o.status=$1"; }
    const r = await pool.query(
      `SELECT o.id,o.code,o.customer_name,o.order_date,o.due_date,o.status,o.notes,
              COUNT(DISTINCT ol.id)::int AS line_count,
              COALESCE(SUM(ol.quantity),0) AS ordered_quantity,
              COALESCE(SUM(os.completed_quantity),0) AS completed_quantity
         FROM production_orders o
         LEFT JOIN production_order_lines ol ON ol.order_id=o.id
         LEFT JOIN order_stages os ON os.order_id=o.id
         ${where}
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 300`, params);
    return { data: r.rows };
  });

  app.get("/api/orders/:id", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const order = await pool.query(
      `SELECT o.*,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id',ol.id,'product_id',ol.product_id,'product_name',p.name,'product_code',p.code,'quantity',ol.quantity,'unit_id',ol.unit_id,'unit_name',u.name,'notes',ol.notes)) FILTER (WHERE ol.id IS NOT NULL),'[]') AS lines,
              COALESCE((SELECT json_agg(jsonb_build_object('id',os.id,'stage_id',os.stage_id,'stage_name',s.name,'stage_code',s.code,'sequence_no',os.sequence_no,'status',os.status,'planned_quantity',os.planned_quantity,'completed_quantity',os.completed_quantity) ORDER BY os.sequence_no) FROM order_stages os JOIN stages s ON s.id=os.stage_id WHERE os.order_id=o.id),'[]') AS stages
         FROM production_orders o
         LEFT JOIN production_order_lines ol ON ol.order_id=o.id
         LEFT JOIN products p ON p.id=ol.product_id
         LEFT JOIN units u ON u.id=ol.unit_id
        WHERE o.id=$1
        GROUP BY o.id`, [id]);
    if (!order.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
    return { data: order.rows[0] };
  });

  app.post("/api/orders", { preHandler: [authenticateRequest, requirePermission("orders.create")] }, async (request, reply) => {
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات الطلب غير صحيحة",422);
    const row = await withTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO production_orders(customer_name,order_date,due_date,notes,created_by,status)
         VALUES($1,COALESCE($2,CURRENT_DATE),$3,$4,$5,'DRAFT') RETURNING *`,
        [parsed.data.customerName ?? null, parsed.data.orderDate ?? null, parsed.data.dueDate ?? null, parsed.data.notes ?? null, request.user!.userId]
      );
      const order = created.rows[0];
      for (const line of parsed.data.lines) {
        await client.query("INSERT INTO production_order_lines(order_id,product_id,quantity,unit_id,notes) VALUES($1,$2,$3,$4,$5)",
          [order.id,line.productId,line.quantity,line.unitId,line.notes ?? null]);
      }
      for (const stage of parsed.data.stages ?? []) {
        await client.query("INSERT INTO order_stages(order_id,stage_id,sequence_no,planned_quantity) VALUES($1,$2,$3,$4)",
          [order.id,stage.stageId,stage.sequenceNo,stage.plannedQuantity ?? null]);
      }
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"orders",entityType:"production_order",entityId:order.id,afterData:order,ipAddress:request.ip,userAgent:request.headers["user-agent"] ?? null});
      return order;
    });
    return reply.code(201).send({ data: row });
  });

  app.patch("/api/orders/:id", { preHandler: [authenticateRequest, requirePermission("orders.edit")] }, async (request) => {
    const id=(request.params as {id:string}).id;
    const parsed=z.object({status:z.enum(["DRAFT","PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"]).optional(),customerName:z.string().trim().max(200).nullable().optional(),dueDate:z.string().date().nullable().optional(),notes:z.string().trim().max(1000).nullable().optional()}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات تعديل الطلب غير صحيحة",422);
    const current=await pool.query("SELECT * FROM production_orders WHERE id=$1",[id]);
    if(!current.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
    const p=parsed.data;
    const r=await pool.query(`UPDATE production_orders SET customer_name=COALESCE($1,customer_name),due_date=COALESCE($2,due_date),notes=COALESCE($3,notes),status=COALESCE($4,status),updated_at=now() WHERE id=$5 RETURNING *`,
      [p.customerName ?? null,p.dueDate ?? null,p.notes ?? null,p.status ?? null,id]);
    return { data:r.rows[0] };
  });

  app.post("/api/orders/:id/stages", { preHandler: [authenticateRequest, requirePermission("orders.manage_stages")] }, async (request, reply) => {
    const orderId=(request.params as {id:string}).id;
    const parsed=z.object({stageId:z.string().uuid(),sequenceNo:z.number().int().positive(),plannedQuantity:z.number().nonnegative().optional()}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات المرحلة غير صحيحة",422);
    const r=await pool.query("INSERT INTO order_stages(order_id,stage_id,sequence_no,planned_quantity) VALUES($1,$2,$3,$4) RETURNING *",[orderId,parsed.data.stageId,parsed.data.sequenceNo,parsed.data.plannedQuantity ?? null]);
    return reply.code(201).send({data:r.rows[0]});
  });

  app.post("/api/stages/:id/outputs", { preHandler: [authenticateRequest, requirePermission("orders.manage_stages")] }, async (request, reply) => {
    const stageId=(request.params as {id:string}).id;
    const parsed=z.object({productId:z.string().uuid(),isDefault:z.boolean().optional()}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات منتج المرحلة غير صحيحة",422);
    const r=await pool.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,$3) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default RETURNING *",[stageId,parsed.data.productId,parsed.data.isDefault ?? false]);
    return reply.code(201).send({data:r.rows[0]});
  });

  app.get("/api/stages/:id/outputs", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const stageId=(request.params as {id:string}).id;
    const r=await pool.query("SELECT so.id,so.product_id,p.code AS product_code,p.name AS product_name,so.is_default FROM stage_outputs so JOIN products p ON p.id=so.product_id WHERE so.stage_id=$1 ORDER BY p.name",[stageId]);
    return {data:r.rows};
  });

  app.get("/api/machines", { preHandler: [authenticateRequest, requirePermission("machines.view")] }, async () => {
    const r=await pool.query("SELECT id,code,name,machine_type,is_active FROM machines WHERE is_active=TRUE ORDER BY name");
    return {data:r.rows};
  });

  app.post("/api/machines", { preHandler: [authenticateRequest, requirePermission("machines.create")] }, async (request, reply) => {
    const parsed=machineSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات الماكينة غير صحيحة",422);
    const r=await pool.query("INSERT INTO machines(name,machine_type) VALUES($1,$2) RETURNING id,code,name,machine_type,is_active",[parsed.data.name,parsed.data.machineType ?? null]);
    return reply.code(201).send({data:r.rows[0]});
  });

  app.post("/api/machine-production", { preHandler: [authenticateRequest, requirePermission("machine_production.create")] }, async (request, reply) => {
    const parsed=machineProductionSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات إنتاج الماكينة غير صحيحة",422);
    if(parsed.data.orderStageId){
      const stage=await pool.query("SELECT id FROM order_stages WHERE id=$1",[parsed.data.orderStageId]);
      if(!stage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
    }
    const r=await pool.query(
      `INSERT INTO machine_productions(order_stage_id,machine_id,product_id,employee_id,shift_id,work_date,quantity,unit_id,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [parsed.data.orderStageId ?? null,parsed.data.machineId,parsed.data.productId,parsed.data.employeeId ?? null,parsed.data.shiftId ?? null,parsed.data.workDate,parsed.data.quantity,parsed.data.unitId,parsed.data.notes ?? null,request.user!.userId]
    );
    return reply.code(201).send({data:r.rows[0]});
  });

  app.get("/api/machine-production", { preHandler: [authenticateRequest, requirePermission("machine_production.view")] }, async (request) => {
    const r=await pool.query(
      `SELECT mp.id,mp.code,mp.work_date,mp.quantity,mp.notes,m.code AS machine_code,m.name AS machine_name,
              p.code AS product_code,p.name AS product_name,e.full_name AS employee_name,
              o.code AS order_code,s.name AS stage_name
         FROM machine_productions mp
         JOIN machines m ON m.id=mp.machine_id
         JOIN products p ON p.id=mp.product_id
         LEFT JOIN employees e ON e.id=mp.employee_id
         LEFT JOIN order_stages os ON os.id=mp.order_stage_id
         LEFT JOIN production_orders o ON o.id=os.order_id
         LEFT JOIN stages s ON s.id=os.stage_id
        ORDER BY mp.created_at DESC LIMIT 500`);
    return {data:r.rows};
  });
}
