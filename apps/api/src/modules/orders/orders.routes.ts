import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const orderLineSchema = z.object({
  productId: z.string().uuid().optional(),
  productName: z.string().trim().min(2).max(200).optional(),
  quantity: z.number().positive(),
  unitId: z.string().uuid().optional(),
  notes: z.string().trim().max(500).optional()
}).refine(x => Boolean(x.productId || x.productName), { message: "اسم المنتج أو معرف المنتج مطلوب" });

const orderStageSchema = z.object({
  stageId: z.string().uuid().optional(),
  stageName: z.string().trim().min(2).max(200).optional(),
  outputProductId: z.string().uuid().nullable().optional(),
  outputProductName: z.string().trim().min(2).max(200).optional(),
  sequenceNo: z.number().int().positive(),
  plannedQuantity: z.number().nonnegative().optional(),
  notes: z.string().trim().max(500).optional()
}).refine(x => Boolean(x.stageId || x.stageName), { message: "اسم المرحلة أو معرف المرحلة مطلوب" });

const orderSchema = z.object({
  orderName: z.string().trim().min(2).max(200),
  customerName: z.string().trim().max(200).optional(),
  orderDate: z.string().date().optional(),
  deliveryStartDate: z.string().date().optional(),
  dueDate: z.string().date().optional(),
  lastDeliveryDate: z.string().date().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(orderLineSchema).optional().default([]),
  stages: z.array(orderStageSchema).optional()
});


function normalizeBusinessName(value:string):string {
  return value
    .normalize("NFKD")
    .replace(/[\\u064B-\\u065F\\u0670\\u0640]/g,"")
    .replace(/\\s+/g," ")
    .trim()
    .toLocaleLowerCase("ar-EG");
}

async function ensureProduct(client:any, input:{productId?:string|undefined;productName?:string|undefined}) {
  if(input.productId){
    const existing=await client.query("SELECT id,unit_id,name FROM products WHERE id=$1 AND is_active=TRUE",[input.productId]);
    if(!existing.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود أو غير نشط",422);
    return existing.rows[0];
  }
  const name=input.productName!.trim();
  const normalized=normalizeBusinessName(name);
  // Serialize auto-creation by the same normalized business name. This treats
  // whitespace, case and Arabic tashkeel as presentation differences.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('product:' || $1))",[normalized]);
  const existing=await client.query(
    "SELECT id,unit_id,name FROM products WHERE is_active=TRUE AND regexp_replace(translate(lower(trim(name)), 'ًٌٍَُِّْـ', ''), '\\s+', ' ', 'g')=$1 ORDER BY created_at LIMIT 1",
    [normalized]
  );
  if(existing.rowCount)return existing.rows[0];
  const unit=await client.query("SELECT id FROM units WHERE code='PCS' AND is_active=TRUE LIMIT 1");
  if(!unit.rowCount)throw new AppError("DEFAULT_UNIT_MISSING","وحدة القطعة الافتراضية غير موجودة",500);
  const created=await client.query("INSERT INTO products(name,product_type,unit_id,minimum_stock,track_inventory) VALUES($1,'FINISHED_GOOD',$2,0,TRUE) RETURNING id,unit_id,name",[name,unit.rows[0].id]);
  return created.rows[0];
}

async function ensureStage(client:any, input:{stageId?:string|undefined;stageName?:string|undefined}) {
  if(input.stageId){
    const existing=await client.query("SELECT id,name FROM stages WHERE id=$1 AND is_active=TRUE",[input.stageId]);
    if(!existing.rowCount)throw new AppError("STAGE_NOT_FOUND","المرحلة غير موجودة أو غير نشطة",422);
    return existing.rows[0];
  }
  const name=input.stageName!.trim();
  const normalized=normalizeBusinessName(name);
  await client.query("SELECT pg_advisory_xact_lock(hashtext('stage:' || $1))",[normalized]);
  const existing=await client.query(
    "SELECT id,name FROM stages WHERE is_active=TRUE AND regexp_replace(translate(lower(trim(name)), 'ًٌٍَُِّْـ', ''), '\\s+', ' ', 'g')=$1 ORDER BY created_at LIMIT 1",
    [normalized]
  );
  if(existing.rowCount)return existing.rows[0];
  const created=await client.query("INSERT INTO stages(name) VALUES($1) RETURNING id,name",[name]);
  return created.rows[0];
}

const machineSchema = z.object({
  name: z.string().trim().min(2).max(120),
  machineType: z.string().trim().max(120).optional()
});

const machineProductionSchema = z.object({
  orderStageId: z.string().uuid().nullable().optional(),
  productionTypeId: z.string().uuid().nullable().optional(),
  machineId: z.string().uuid(),
  productId: z.string().uuid(),
  employeeId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  workDate: z.string().date(),
  quantity: z.number().positive(),
  unitId: z.string().uuid().optional(),
  notes: z.string().trim().max(500).optional()
});

export async function orderRoutes(app: FastifyInstance) {
  app.get("/api/orders", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const q = z.object({ status: z.enum(["DRAFT","PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"]).optional() }).parse(request.query);
    const params: unknown[] = [];
    let where = "";
    if (q.status) { params.push(q.status); where = "WHERE o.status=$1"; }
    const r = await pool.query(
      `SELECT o.id,o.code,o.order_name,o.customer_name,o.order_date,o.delivery_start_date,o.due_date,o.last_delivery_date,o.status,o.notes,
              COALESCE((SELECT COUNT(*)::int FROM production_order_lines ol WHERE ol.order_id=o.id),0) AS line_count,
              COALESCE((SELECT SUM(ol.quantity) FROM production_order_lines ol WHERE ol.order_id=o.id),0) AS ordered_quantity,
              COALESCE((SELECT SUM(os.completed_quantity) FROM order_stages os WHERE os.order_id=o.id),0) AS completed_quantity
         FROM production_orders o
         ${where}
        ORDER BY o.created_at DESC
        LIMIT 300`, params);
    return { data: r.rows };
  });

  app.get("/api/order-stages", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const q=z.object({orderId:z.string().uuid().optional()}).safeParse(request.query);
    if(!q.success) throw new AppError("VALIDATION_ERROR","فلتر مراحل الطلب غير صحيح",422);
    const params:unknown[]=[]; const where:string[]=["os.status <> 'CANCELLED'"];
    if(q.data.orderId){params.push(q.data.orderId);where.push("os.order_id=$"+params.length);}
    const r=await pool.query("SELECT os.id,os.order_id,o.code AS order_code,o.order_name,s.id AS stage_id,s.name AS stage_name,p.id AS output_product_id,p.name AS output_product_name,os.sequence_no,os.status,os.planned_quantity,os.completed_quantity FROM order_stages os JOIN production_orders o ON o.id=os.order_id JOIN stages s ON s.id=os.stage_id LEFT JOIN products p ON p.id=os.output_product_id WHERE "+where.join(" AND ")+" ORDER BY o.created_at DESC,os.sequence_no",params);
    return {data:r.rows};
  });

  app.get("/api/orders/:id", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const order = await pool.query(
      `SELECT o.*,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id',ol.id,'product_id',ol.product_id,'product_name',p.name,'product_code',p.code,'quantity',ol.quantity,'unit_id',ol.unit_id,'unit_name',u.name,'notes',ol.notes)) FILTER (WHERE ol.id IS NOT NULL),'[]') AS lines,
              COALESCE((SELECT json_agg(jsonb_build_object('id',os.id,'stage_id',os.stage_id,'stage_name',s.name,'stage_code',s.code,'sequence_no',os.sequence_no,'status',os.status,'planned_quantity',os.planned_quantity,'completed_quantity',os.completed_quantity,'output_product_id',os.output_product_id,'output_product_name',op.name,'notes',os.notes) ORDER BY os.sequence_no) FROM order_stages os JOIN stages s ON s.id=os.stage_id LEFT JOIN products op ON op.id=os.output_product_id WHERE os.order_id=o.id),'[]') AS stages
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
        `INSERT INTO production_orders(order_name,customer_name,order_date,delivery_start_date,due_date,last_delivery_date,notes,created_by,status)
         VALUES($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,'DRAFT') RETURNING *`,
        [parsed.data.orderName, parsed.data.customerName ?? null, parsed.data.orderDate ?? null, parsed.data.deliveryStartDate ?? null, parsed.data.dueDate ?? null, parsed.data.lastDeliveryDate ?? null, parsed.data.notes ?? null, request.user!.userId]
      );
      const order = created.rows[0];
      const stages = parsed.data.stages ?? [];
      const lineInputs = [...parsed.data.lines];
      // In the normal UI the product is entered once beside each stage.
      // Build order lines from stage outputs so the same product is never requested twice.
      if (!lineInputs.length) {
        if (!stages.length) throw new AppError("ORDER_STAGES_REQUIRED","يجب إضافة مرحلة واحدة على الأقل للطلبية",422);
        const derived = new Map<string,{productId?:string;productName?:string;quantity:number;notes?:string}>();
        for (const stage of stages) {
          if (!stage.outputProductId && !stage.outputProductName) continue;
          if (stage.plannedQuantity == null || stage.plannedQuantity <= 0) {
            throw new AppError("STAGE_QUANTITY_REQUIRED","الكمية المخططة مطلوبة لكل منتج ناتج من المرحلة",422);
          }
          const key=stage.outputProductId ?? stage.outputProductName!.trim().toLowerCase();
          const current=derived.get(key);
          if (current) current.quantity += stage.plannedQuantity;
          else derived.set(key,{productId:stage.outputProductId,productName:stage.outputProductName,quantity:stage.plannedQuantity,notes:stage.notes});
        }
        if (!derived.size) throw new AppError("ORDER_PRODUCTS_REQUIRED","اكتب المنتج الناتج بجانب مرحلة واحدة على الأقل",422);
        lineInputs.push(...Array.from(derived.values()));
      }
      for (const line of lineInputs) {
        const product=await ensureProduct(client,{productId:line.productId,productName:line.productName});
        const unitId=line.unitId ?? product.unit_id;
        await client.query("INSERT INTO production_order_lines(order_id,product_id,quantity,unit_id,notes) VALUES($1,$2,$3,$4,$5)",
          [order.id,product.id,line.quantity,unitId,line.notes ?? null]);
      }
      for (const stage of stages) {
        const stageRow=await ensureStage(client,{stageId:stage.stageId,stageName:stage.stageName});
        let outputProductId=stage.outputProductId ?? null;
        if(!outputProductId && stage.outputProductName) {
          const product=await ensureProduct(client,{productName:stage.outputProductName});
          outputProductId=product.id;
        }
        await client.query("INSERT INTO order_stages(order_id,stage_id,output_product_id,sequence_no,planned_quantity,notes) VALUES($1,$2,$3,$4,$5,$6)",
          [order.id,stageRow.id,outputProductId,stage.sequenceNo,stage.plannedQuantity ?? null,stage.notes ?? null]);
        if(outputProductId) await client.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,TRUE) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default",[stageRow.id,outputProductId]);
      }
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"orders",entityType:"production_order",entityId:order.id,afterData:order,ipAddress:request.ip,userAgent:request.headers["user-agent"] ?? null});
      return order;
    });
    return reply.code(201).send({ data: row });
  });

  app.delete("/api/orders/:id",{preHandler:[authenticateRequest,requirePermission("orders.delete")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await withTransaction(async client=>{
      const before=await client.query("SELECT id,code,order_name,status FROM production_orders WHERE id=$1 FOR UPDATE",[id]);
      if(!before.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
      if(before.rows[0].status==="COMPLETED")throw new AppError("ORDER_COMPLETED_LOCKED","لا يمكن إلغاء طلب مكتمل",409);
      const after=await client.query("UPDATE production_orders SET status='CANCELLED',updated_at=now() WHERE id=$1 RETURNING id,code,order_name,status",[id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"deactivate",module:"orders",entityType:"production_order",entityId:id,beforeData:before.rows[0],afterData:after.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return after.rows[0];
    });
    return {data:r};
  });

  app.patch("/api/orders/:id", { preHandler: [authenticateRequest, requirePermission("orders.edit")] }, async (request) => {
    const id=(request.params as {id:string}).id;
    const parsed=z.object({orderName:z.string().trim().min(2).max(200).optional(),status:z.enum(["DRAFT","PLANNED","IN_PROGRESS","COMPLETED","CANCELLED"]).optional(),customerName:z.string().trim().max(200).nullable().optional(),deliveryStartDate:z.string().date().nullable().optional(),dueDate:z.string().date().nullable().optional(),lastDeliveryDate:z.string().date().nullable().optional(),notes:z.string().trim().max(1000).nullable().optional()}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات تعديل الطلب غير صحيحة",422);
    const current=await pool.query("SELECT * FROM production_orders WHERE id=$1",[id]);
    if(!current.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
    const p=parsed.data;
    const r=await pool.query(`UPDATE production_orders SET order_name=COALESCE($1,order_name),customer_name=COALESCE($2,customer_name),delivery_start_date=COALESCE($3,delivery_start_date),due_date=COALESCE($4,due_date),last_delivery_date=COALESCE($5,last_delivery_date),notes=COALESCE($6,notes),status=COALESCE($7,status),updated_at=now() WHERE id=$8 RETURNING *`,
      [p.orderName ?? null,p.customerName ?? null,p.deliveryStartDate ?? null,p.dueDate ?? null,p.lastDeliveryDate ?? null,p.notes ?? null,p.status ?? null,id]);
    return { data:r.rows[0] };
  });

  app.post("/api/orders/:id/stages", { preHandler: [authenticateRequest, requirePermission("orders.manage_stages")] }, async (request, reply) => {
    const orderId=(request.params as {id:string}).id;
    const parsed=z.object({stageId:z.string().uuid().optional(),stageName:z.string().trim().min(2).max(200).optional(),outputProductId:z.string().uuid().nullable().optional(),outputProductName:z.string().trim().min(2).max(200).optional(),sequenceNo:z.number().int().positive(),plannedQuantity:z.number().nonnegative().optional(),notes:z.string().trim().max(500).optional()}).refine(x=>Boolean(x.stageId||x.stageName),{message:"اسم المرحلة أو معرف المرحلة مطلوب"}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات المرحلة غير صحيحة",422);
    const r=await withTransaction(async client=>{
      const order=await client.query("SELECT id FROM production_orders WHERE id=$1",[orderId]);if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
      const stage=await ensureStage(client,{stageId:parsed.data.stageId,stageName:parsed.data.stageName});
      let outputProductId=parsed.data.outputProductId??null;
      if(!outputProductId&&parsed.data.outputProductName)outputProductId=(await ensureProduct(client,{productName:parsed.data.outputProductName})).id;
      const x=await client.query("INSERT INTO order_stages(order_id,stage_id,output_product_id,sequence_no,planned_quantity,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[orderId,stage.id,outputProductId,parsed.data.sequenceNo,parsed.data.plannedQuantity??null,parsed.data.notes??null]);
      if(outputProductId)await client.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,TRUE) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default",[stage.id,outputProductId]);
      return x.rows[0];
    });
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

  app.patch("/api/order-stages/:id", { preHandler: [authenticateRequest, requirePermission("orders.manage_stages")] }, async (request) => {
    const id=(request.params as {id:string}).id;
    const parsed=z.object({stageId:z.string().uuid().optional(),stageName:z.string().trim().min(2).max(200).optional(),outputProductId:z.string().uuid().nullable().optional(),outputProductName:z.string().trim().min(2).max(200).optional(),sequenceNo:z.number().int().positive().optional(),plannedQuantity:z.number().nonnegative().nullable().optional(),status:z.enum(["PENDING","READY","IN_PROGRESS","COMPLETED","CANCELLED"]).optional(),notes:z.string().trim().max(500).nullable().optional()}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات تعديل المرحلة غير صحيحة",422);
    const p=parsed.data;
    const r=await withTransaction(async client=>{
      const current=await client.query("SELECT * FROM order_stages WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",404);
      const stage= p.stageId||p.stageName ? await ensureStage(client,{stageId:p.stageId,stageName:p.stageName}) : {id:current.rows[0].stage_id};
      let outputProductId=p.outputProductId;
      if(!outputProductId&&p.outputProductName)outputProductId=(await ensureProduct(client,{productName:p.outputProductName})).id;
      const x=await client.query("UPDATE order_stages SET stage_id=COALESCE($1,stage_id),output_product_id=COALESCE($2,output_product_id),sequence_no=COALESCE($3,sequence_no),planned_quantity=COALESCE($4,planned_quantity),status=COALESCE($5,status),notes=COALESCE($6,notes) WHERE id=$7 RETURNING *",[stage.id,outputProductId??null,p.sequenceNo??null,p.plannedQuantity??null,p.status??null,p.notes??null,id]);
      if(outputProductId)await client.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,TRUE) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default",[stage.id,outputProductId]);
      return x.rows[0];
    });
    return {data:r};
  });

  app.get("/api/orders/:id/dashboard", { preHandler: [authenticateRequest, requirePermission("orders.dashboard")] }, async (request) => {
    const id=(request.params as {id:string}).id;
    const order=await pool.query("SELECT o.* FROM production_orders o WHERE o.id=$1",[id]);
    if(!order.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
    const [stages,production,movements,deliveries]=await Promise.all([
      pool.query("SELECT os.id,os.sequence_no,os.status,os.planned_quantity,os.completed_quantity,os.notes,s.name AS stage_name,p.name AS output_product_name FROM order_stages os JOIN stages s ON s.id=os.stage_id LEFT JOIN products p ON p.id=os.output_product_id WHERE os.order_id=$1 ORDER BY os.sequence_no",[id]),
      pool.query("SELECT pe.id,pe.code,pe.work_date,pe.quantity,pe.earning_amount,e.full_name AS employee_name,p.name AS product_name,s.name AS stage_name,pt.name AS production_type_name FROM production_entries pe JOIN employees e ON e.id=pe.employee_id JOIN products p ON p.id=pe.product_id JOIN stages s ON s.id=pe.stage_id LEFT JOIN production_types pt ON pt.id=pe.production_type_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 ORDER BY pe.work_date DESC,pe.created_at DESC LIMIT 500",[id]),
      pool.query("SELECT sm.code,sm.movement_type,sm.quantity,sm.unit_cost,sm.total_cost,sm.created_at,p.name AS product_name,w.name AS warehouse_name FROM stock_movements sm JOIN products p ON p.id=sm.product_id JOIN warehouses w ON w.id=sm.warehouse_id WHERE sm.order_id=$1 ORDER BY sm.created_at DESC LIMIT 500",[id]),
      pool.query("SELECT d.id,d.code,d.destination,d.status,d.created_at,d.released_at,COALESCE(SUM(dl.quantity),0) AS quantity FROM delivery_permissions d LEFT JOIN delivery_permission_lines dl ON dl.delivery_permission_id=d.id WHERE d.order_id=$1 GROUP BY d.id ORDER BY d.created_at DESC",[id])
    ]);
    const totals=await pool.query("SELECT COALESCE((SELECT SUM(earning_amount) FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status='APPROVED'),0) AS production_cost,COALESCE((SELECT SUM(total_cost) FROM stock_movements WHERE order_id=$1 AND movement_type IN ('OUT','TRANSFER_OUT')),0) AS stock_out_cost,COALESCE((SELECT SUM(total_cost) FROM stock_movements WHERE order_id=$1 AND movement_type IN ('IN','RETURN','TRANSFER_IN')),0) AS stock_in_cost",[id]);
    return {data:{order:order.rows[0],stages:stages.rows,production:production.rows,movements:movements.rows,deliveries:deliveries.rows,totals:totals.rows[0]}};
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

  app.delete("/api/machines/:id",{preHandler:[authenticateRequest,requirePermission("machines.delete")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const r=await pool.query("UPDATE machines SET is_active=FALSE,updated_at=now() WHERE id=$1 RETURNING id,code,name,is_active",[id]);
    if(!r.rowCount)throw new AppError("MACHINE_NOT_FOUND","الماكينة غير موجودة",404);return {data:r.rows[0]};
  });

  app.post("/api/machine-production", { preHandler: [authenticateRequest, requirePermission("machine_production.create")] }, async (request, reply) => {
    const parsed=machineProductionSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات إنتاج الماكينة غير صحيحة",422);
    if(parsed.data.orderStageId){
      const stage=await pool.query("SELECT id FROM order_stages WHERE id=$1",[parsed.data.orderStageId]);
      if(!stage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
    }
    const product = await pool.query("SELECT unit_id FROM products WHERE id=$1 AND is_active=TRUE",[parsed.data.productId]);
    if(!product.rowCount) throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود أو غير نشط",422);
    const unitId=parsed.data.unitId ?? product.rows[0].unit_id;
    const r=await pool.query(
      `INSERT INTO machine_productions(order_stage_id,production_type_id,machine_id,product_id,employee_id,shift_id,work_date,quantity,unit_id,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [parsed.data.orderStageId ?? null,parsed.data.productionTypeId ?? null,parsed.data.machineId,parsed.data.productId,parsed.data.employeeId ?? null,parsed.data.shiftId ?? null,parsed.data.workDate,parsed.data.quantity,unitId,parsed.data.notes ?? null,request.user!.userId]
    );
    return reply.code(201).send({data:r.rows[0]});
  });

  app.get("/api/machine-production", { preHandler: [authenticateRequest, requirePermission("machine_production.view")] }, async (request) => {
    const r=await pool.query(
      `SELECT mp.id,mp.code,mp.work_date,mp.quantity,mp.notes,m.code AS machine_code,m.name AS machine_name,
              p.code AS product_code,p.name AS product_name,e.full_name AS employee_name,
              o.code AS order_code,o.order_name,s.name AS stage_name,pt.name AS production_type_name
         FROM machine_productions mp
         JOIN machines m ON m.id=mp.machine_id
         JOIN products p ON p.id=mp.product_id
         LEFT JOIN employees e ON e.id=mp.employee_id
         LEFT JOIN order_stages os ON os.id=mp.order_stage_id
         LEFT JOIN production_orders o ON o.id=os.order_id
         LEFT JOIN stages s ON s.id=os.stage_id
         LEFT JOIN production_types pt ON pt.id=mp.production_type_id
        ORDER BY mp.created_at DESC LIMIT 500`);
    return {data:r.rows};
  });
}
