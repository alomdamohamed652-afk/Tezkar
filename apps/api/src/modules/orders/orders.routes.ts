import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { verifyPassword } from "../auth/auth.service.js";

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
  notes: z.string().trim().max(500).optional(),
  stageRate: z.number().nonnegative().nullable().optional(),
  stageRateMethod: z.enum(["PER_PIECE","PER_1000","PER_HOUR","PER_DAY","PERCENTAGE"]).nullable().optional(),
  productionTypeId: z.string().uuid().nullable().optional(),
  isFinalProduct: z.boolean().optional().default(false)
}).refine(x => Boolean(x.stageId || x.stageName), { message: "اسم المرحلة أو معرف المرحلة مطلوب" })
  .refine(x => !x.isFinalProduct || Boolean((x.outputProductId || x.outputProductName) && x.plannedQuantity != null && x.plannedQuantity > 0), { message: "المنتج النهائي وكمية المرحلة مطلوبان" });

const orderSchema = z.object({
  orderName: z.string().trim().min(2).max(200),
  customerName: z.string().trim().max(200).optional(),
  orderDate: z.string().date().optional(),
  deliveryStartDate: z.string().date().optional(),
  dueDate: z.string().date().optional(),
  lastDeliveryDate: z.string().date().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(orderLineSchema).optional().default([]),
  stages: z.array(orderStageSchema).optional(),
  finalProductName: z.string().trim().min(2).max(200).optional(),
  finalQuantity: z.number().positive().optional()
}).refine(x => Boolean(x.finalProductName) === Boolean(x.finalQuantity), { message: "اسم المنتج النهائي وكميته مطلوبان معًا" });


function normalizeBusinessName(value:string):string {
  return value
    .normalize("NFKD")
    .replace(/[\u064B-\u065F\u0670\u0640]/g,"")
    .replace(/\s+/g," ")
    .trim()
    .toLocaleLowerCase("ar-EG");
}


function calculateStageEarning(method:string,rate:number,entry:{quantity:string|number;hours_worked:string|number|null;base_amount:string|number|null}):number{
  const quantity=Number(entry.quantity);
  let value:number;
  switch(method){
    case "PER_PIECE": value=quantity*rate; break;
    case "PER_1000": value=quantity/1000*rate; break;
    case "PER_DAY": value=rate; break;
    case "PER_HOUR":
      if(entry.hours_worked==null)throw new AppError("HOURS_WORKED_REQUIRED","لا يمكن إعادة حساب أجر بالساعة لأن عدد الساعات غير مسجل",422);
      value=Number(entry.hours_worked)*rate;break;
    case "PERCENTAGE":
      if(entry.base_amount==null)throw new AppError("BASE_AMOUNT_REQUIRED","لا يمكن إعادة حساب أجر النسبة لأن قيمة الأساس غير مسجلة",422);
      value=Number(entry.base_amount)*rate/100;break;
    default: throw new AppError("WAGE_METHOD_UNSUPPORTED","طريقة حساب الأجر غير مدعومة لتغيير سعر الطلبية",422);
  }
  if(!Number.isFinite(value)||value<0)throw new AppError("PRICE_CALCULATION_ERROR","تعذر حساب السعر الجديد للعملية",422);
  return Math.round((value+Number.EPSILON)*100)/100;
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

async function syncOrderLinesFromFinalStages(client:any, orderId:string) {
  const activity = await client.query(
    `SELECT
       EXISTS(SELECT 1 FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status <> 'CANCELLED') AS has_production,
       EXISTS(SELECT 1 FROM machine_productions mp JOIN order_stages os ON os.id=mp.order_stage_id WHERE os.order_id=$1) AS has_machine_production,
       EXISTS(SELECT 1 FROM stock_movements WHERE order_id=$1) AS has_stock_movements,
       EXISTS(SELECT 1 FROM delivery_permissions WHERE order_id=$1 AND status <> 'CANCELLED') AS has_deliveries`,
    [orderId]
  );
  if (activity.rows[0].has_production || activity.rows[0].has_machine_production || activity.rows[0].has_stock_movements || activity.rows[0].has_deliveries) {
    throw new AppError("ORDER_FINAL_PRODUCTS_LOCKED","لا يمكن تغيير المنتجات النهائية بعد بدء الإنتاج أو تسجيل حركة مخزنية أو تسليم؛ حفاظًا على مطابقة السجلات.",409);
  }
  const result = await client.query(
    `SELECT os.id AS stage_id,os.order_item_id,os.output_product_id,os.planned_quantity,p.unit_id
       FROM order_stages os LEFT JOIN products p ON p.id=os.output_product_id
      WHERE os.order_id=$1 AND os.is_final_product=TRUE AND os.status <> 'CANCELLED'
      ORDER BY os.sequence_no,os.id`,
    [orderId]
  );
  if (!result.rowCount) throw new AppError("ORDER_FINAL_PRODUCTS_REQUIRED","حدد منتجًا نهائيًا واحدًا على الأقل داخل مراحل الطلبية",422);
  for (const row of result.rows) {
    const quantity = Number(row.planned_quantity);
    if (!row.output_product_id || !row.unit_id || !Number.isFinite(quantity) || quantity <= 0) {
      throw new AppError("ORDER_FINAL_PRODUCT_INVALID","كل مرحلة نهائية تحتاج منتجًا وكمية مخططة موجبة",422);
    }
    if (row.order_item_id) {
      await client.query("UPDATE production_order_lines SET product_id=$1,quantity=$2,unit_id=$3 WHERE id=$4 AND order_id=$5",
        [row.output_product_id,quantity,row.unit_id,row.order_item_id,orderId]);
    } else {
      const line = await client.query("INSERT INTO production_order_lines(order_id,product_id,quantity,unit_id) VALUES($1,$2,$3,$4) RETURNING id",
        [orderId,row.output_product_id,quantity,row.unit_id]);
      await client.query("UPDATE order_stages SET order_item_id=$1 WHERE id=$2",[line.rows[0].id,row.stage_id]);
    }
  }
}

const machineSchema = z.object({
  name: z.string().trim().min(2).max(120),
  machineType: z.string().trim().max(120).optional()
});

const machineProductionSchema = z.object({
  orderStageId: z.string().uuid(),
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
    let where = "WHERE o.status <> 'CANCELLED'";
    if (q.status) { params.push(q.status); where = "WHERE o.status=$1"; }
    const r = await pool.query(
      `SELECT o.id,o.code,o.order_name,o.customer_name,o.order_date,o.delivery_start_date,o.due_date,o.last_delivery_date,o.status,o.notes,
              COALESCE((SELECT COUNT(*)::int FROM production_order_lines ol WHERE ol.order_id=o.id),0) AS line_count,
              COALESCE((SELECT SUM(ol.quantity) FROM production_order_lines ol WHERE ol.order_id=o.id),0) AS ordered_quantity,
              COALESCE((SELECT SUM(os.completed_quantity) FROM order_stages os WHERE os.order_id=o.id AND os.status <> 'CANCELLED' AND (os.is_final_product=TRUE OR (NOT EXISTS(SELECT 1 FROM order_stages f WHERE f.order_id=o.id AND f.is_final_product=TRUE AND f.status <> 'CANCELLED') AND os.sequence_no=(SELECT MAX(os2.sequence_no) FROM order_stages os2 WHERE os2.order_id=o.id AND os2.status <> 'CANCELLED')))),0) AS completed_quantity
         FROM production_orders o
         ${where}
        ORDER BY o.created_at DESC
        LIMIT 300`, params);
    return { data: r.rows };
  });

  app.get("/api/order-stages", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const q=z.object({orderId:z.string().uuid().optional()}).safeParse(request.query);
    if(!q.success) throw new AppError("VALIDATION_ERROR","فلتر مراحل الطلب غير صحيح",422);
    const params:unknown[]=[]; const where:string[]=["os.status <> 'CANCELLED'","o.status NOT IN ('COMPLETED','CANCELLED')"];
    if(q.data.orderId){params.push(q.data.orderId);where.push("os.order_id=$"+params.length);}
    const r=await pool.query("SELECT os.id,os.order_id,o.code AS order_code,o.order_name,s.id AS stage_id,s.name AS stage_name,p.id AS output_product_id,p.name AS output_product_name,os.sequence_no,os.status,os.planned_quantity,os.completed_quantity,os.stage_rate,os.stage_rate_method,os.stage_rate_unit_id,os.production_type_id,os.is_final_product FROM order_stages os JOIN production_orders o ON o.id=os.order_id JOIN stages s ON s.id=os.stage_id LEFT JOIN products p ON p.id=os.output_product_id WHERE "+where.join(" AND ")+" ORDER BY o.created_at DESC,os.sequence_no",params);
    return {data:r.rows};
  });

  app.get("/api/orders/:id", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const id = (request.params as { id: string }).id;
    const order = await pool.query(
      `SELECT o.*,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id',ol.id,'product_id',ol.product_id,'product_name',p.name,'product_code',p.code,'quantity',ol.quantity,'unit_id',ol.unit_id,'unit_name',u.name,'notes',ol.notes)) FILTER (WHERE ol.id IS NOT NULL),'[]') AS lines,
              COALESCE((SELECT json_agg(jsonb_build_object('id',os.id,'stage_id',os.stage_id,'stage_name',s.name,'stage_code',s.code,'sequence_no',os.sequence_no,'status',os.status,'planned_quantity',os.planned_quantity,'completed_quantity',os.completed_quantity,'output_product_id',os.output_product_id,'output_product_name',op.name,'stage_rate',os.stage_rate,'stage_rate_method',os.stage_rate_method,'stage_rate_unit_id',os.stage_rate_unit_id,'production_type_id',os.production_type_id,'is_final_product',os.is_final_product,'notes',os.notes) ORDER BY os.sequence_no) FROM order_stages os JOIN stages s ON s.id=os.stage_id LEFT JOIN products op ON op.id=os.output_product_id WHERE os.order_id=o.id),'[]') AS stages
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
      const explicitFinalStages = stages.filter(stage => stage.isFinalProduct);
      const lineInputs = [...parsed.data.lines];
      let finalStageLineIndexes: number[] = [];

      // Older clients may still submit one order-level final product. New clients
      // mark one or more stage outputs as final, supporting multiple finished
      // products with independent production paths in a single customer order.
      if (parsed.data.finalProductName) {
        lineInputs.splice(0, lineInputs.length, { productName: parsed.data.finalProductName, quantity: parsed.data.finalQuantity! });
      } else if (explicitFinalStages.length || !lineInputs.length) {
        if (!stages.length) throw new AppError("ORDER_STAGES_REQUIRED","يجب إضافة مرحلة واحدة على الأقل للطلبية",422);
        const finalSequence = Math.max(...stages.map(stage => stage.sequenceNo));
        const finalStages = explicitFinalStages.length ? explicitFinalStages : stages.filter(stage => stage.sequenceNo === finalSequence);
        const derived = finalStages.filter(stage => Boolean(stage.outputProductId || stage.outputProductName));
        for (const stage of derived) {
          if (stage.plannedQuantity == null || stage.plannedQuantity <= 0) throw new AppError("STAGE_QUANTITY_REQUIRED","الكمية المخططة مطلوبة لكل منتج نهائي",422);
        }
        if (!derived.length) throw new AppError("ORDER_PRODUCTS_REQUIRED","حدد منتجًا نهائيًا واحدًا على الأقل من داخل مراحله",422);
        lineInputs.splice(0, lineInputs.length, ...derived.map(stage => ({
          ...(stage.outputProductId ? {productId:stage.outputProductId} : {productName:stage.outputProductName!}),
          quantity:stage.plannedQuantity!,
          ...(stage.notes ? {notes:stage.notes} : {})
        })));
        finalStageLineIndexes = derived.map(stage => stages.indexOf(stage));
      }

      const lineProductIds: Array<{lineId:string;productId:string;quantity:number}> = [];
      for (const line of lineInputs) {
        const product = await ensureProduct(client,line.productId ? {productId:line.productId} : {productName:line.productName!});
        const unitId = line.unitId ?? product.unit_id;
        const insertedLine = await client.query("INSERT INTO production_order_lines(order_id,product_id,quantity,unit_id,notes) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [order.id,product.id,line.quantity,unitId,line.notes ?? null]);
        lineProductIds.push({lineId:insertedLine.rows[0].id,productId:product.id,quantity:line.quantity});
      }

      const finalSequence = stages.length ? Math.max(...stages.map(stage => stage.sequenceNo)) : null;
      const designatedFinalProductId = parsed.data.finalProductName ? lineProductIds[0]?.productId : null;
      const legacyFinalSelection = !parsed.data.finalProductName && explicitFinalStages.length === 0;
      for (const [stageIndex, stage] of stages.entries()) {
        const stageRow = await ensureStage(client,{stageId:stage.stageId,stageName:stage.stageName});
        let outputProductId = stage.outputProductId ?? null;
        if (!outputProductId && stage.outputProductName) outputProductId = (await ensureProduct(client,{productName:stage.outputProductName})).id;
        if (designatedFinalProductId && stage.sequenceNo === finalSequence) {
          if (outputProductId && outputProductId !== designatedFinalProductId) {
            throw new AppError("FINAL_PRODUCT_STAGE_MISMATCH","المنتج الناتج من آخر مرحلة لازم يكون هو نفس المنتج النهائي المحدد للطلبية",422);
          }
          outputProductId = designatedFinalProductId;
        }
        const isFinalProduct = Boolean(stage.isFinalProduct || (designatedFinalProductId && stage.sequenceNo === finalSequence) ||
          (legacyFinalSelection && stage.sequenceNo === finalSequence && outputProductId));
        if (isFinalProduct && (!outputProductId || stage.plannedQuantity == null || stage.plannedQuantity <= 0)) {
          throw new AppError("STAGE_FINAL_OUTPUT_REQUIRED","حدد المنتج النهائي وكمية موجبة للمرحلة النهائية",422);
        }
        let orderItemId: string | null = null;
        if (isFinalProduct) {
          const mappedLineIndex = finalStageLineIndexes.indexOf(stageIndex);
          if (mappedLineIndex >= 0) orderItemId = lineProductIds[mappedLineIndex]?.lineId ?? null;
          else if (designatedFinalProductId && stage.sequenceNo === finalSequence) orderItemId = lineProductIds[0]?.lineId ?? null;
          else orderItemId = lineProductIds.find(line => line.productId === outputProductId)?.lineId ?? null;
          if (!orderItemId) throw new AppError("FINAL_ORDER_LINE_REQUIRED","تعذر ربط المرحلة النهائية بسطر المنتج الخاص بها في الطلبية",422);
        }
        await client.query("INSERT INTO order_stages(order_id,order_item_id,stage_id,output_product_id,sequence_no,planned_quantity,notes,stage_rate,stage_rate_method,production_type_id,is_final_product) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [order.id,orderItemId,stageRow.id,outputProductId,stage.sequenceNo,stage.plannedQuantity ?? null,stage.notes ?? null,stage.stageRate ?? null,stage.stageRateMethod ?? null,stage.productionTypeId ?? null,isFinalProduct]);
        if (outputProductId) await client.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,TRUE) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default",[stageRow.id,outputProductId]);
      }
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"orders",entityType:"production_order",entityId:order.id,afterData:order,ipAddress:request.ip,userAgent:request.headers["user-agent"] ?? null});
      return order;
    });
    return reply.code(201).send({ data: row });
  });

  app.delete("/api/orders/:id",{preHandler:[authenticateRequest,requirePermission("orders.delete")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const parsed=z.object({password:z.string().min(1).max(200)}).safeParse(request.body);
    if(!parsed.success)throw new AppError("PASSWORD_REQUIRED","أدخل كلمة مرور حسابك لتأكيد حذف الطلبية",422);
    const r=await withTransaction(async client=>{
      const actor=await client.query("SELECT password_hash FROM users WHERE id=$1 AND is_active=TRUE",[request.user!.userId]);
      if(!actor.rowCount || !verifyPassword(parsed.data.password,actor.rows[0].password_hash))throw new AppError("INVALID_PASSWORD","كلمة المرور غير صحيحة؛ لم يتم حذف الطلبية",401);
      const before=await client.query("SELECT id,code,order_name,status FROM production_orders WHERE id=$1 FOR UPDATE",[id]);
      if(!before.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
      if(before.rows[0].status==="COMPLETED")throw new AppError("ORDER_COMPLETED_LOCKED","لا يمكن إلغاء طلب مكتمل",409);
      const activity=await client.query(
        `SELECT
           EXISTS(SELECT 1 FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status <> 'CANCELLED') AS has_production,
           EXISTS(SELECT 1 FROM stock_movements WHERE order_id=$1) AS has_stock_movements,
           EXISTS(SELECT 1 FROM delivery_permissions WHERE order_id=$1) AS has_deliveries`,
        [id]
      );
      if(activity.rows[0].has_production||activity.rows[0].has_stock_movements||activity.rows[0].has_deliveries){
        throw new AppError("ORDER_HAS_ACTIVITY_LOCKED","لا يمكن حذف طلبية عليها إنتاج أو حركة مخزنية أو إذونات تسليم. عالج السجلات التابعة أولًا حتى لا تتأثر الأرصدة والتكلفة.",409);
      }
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
    const p=parsed.data;
    if(p.status!==undefined) throw new AppError("ORDER_STATUS_TRANSITION_REQUIRED","تغيير حالة الطلب يجب أن يتم من خلال إجراء انتقال الحالة المخصص",409);
    const result=await withTransaction(async client=>{
      const current=await client.query("SELECT * FROM production_orders WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
      if(current.rows[0].status==="COMPLETED" && Object.keys(p).length>0){
        throw new AppError("ORDER_COMPLETED_LOCKED","لا يمكن تعديل طلب مكتمل",409);
      }

      const fields:string[]=[];
      const values:unknown[]=[];
      const add=(field:string,value:unknown)=>{values.push(value);fields.push(field+"=$"+values.length);};
      if(p.orderName!==undefined)add("order_name",p.orderName);
      if(p.customerName!==undefined)add("customer_name",p.customerName);
      if(p.deliveryStartDate!==undefined)add("delivery_start_date",p.deliveryStartDate);
      if(p.dueDate!==undefined)add("due_date",p.dueDate);
      if(p.lastDeliveryDate!==undefined)add("last_delivery_date",p.lastDeliveryDate);
      if(p.notes!==undefined)add("notes",p.notes);
      if(!fields.length)return current.rows[0];

      values.push(id);
      const updated=await client.query(`UPDATE production_orders SET ${fields.join(",")},updated_at=now() WHERE id=${values.length} RETURNING *`,values);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"edit",module:"orders",entityType:"production_order",entityId:id,beforeData:current.rows[0],afterData:updated.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return { data:result };
  });

  app.post("/api/orders/:id/stages", { preHandler: [authenticateRequest, requirePermission("orders.manage_stages")] }, async (request, reply) => {
    const orderId=(request.params as {id:string}).id;
    const parsed=z.object({stageId:z.string().uuid().optional(),stageName:z.string().trim().min(2).max(200).optional(),outputProductId:z.string().uuid().nullable().optional(),outputProductName:z.string().trim().min(2).max(200).optional(),sequenceNo:z.number().int().positive(),plannedQuantity:z.number().nonnegative().optional(),notes:z.string().trim().max(500).optional(),stageRate:z.number().nonnegative().nullable().optional(),stageRateMethod:z.enum(["PER_PIECE","PER_1000","PER_HOUR","PER_DAY","PERCENTAGE"]).nullable().optional(),productionTypeId:z.string().uuid().nullable().optional(),isFinalProduct:z.boolean().optional().default(false)}).refine(x=>Boolean(x.stageId||x.stageName),{message:"اسم المرحلة أو معرف المرحلة مطلوب"}).refine(x=>!x.isFinalProduct||Boolean((x.outputProductId||x.outputProductName)&&x.plannedQuantity!=null&&x.plannedQuantity>0),{message:"المنتج النهائي وكمية المرحلة مطلوبان"}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات المرحلة غير صحيحة",422);
    const r=await withTransaction(async client=>{
      const order=await client.query("SELECT id FROM production_orders WHERE id=$1",[orderId]);if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
      const stage=await ensureStage(client,{stageId:parsed.data.stageId,stageName:parsed.data.stageName});
      let outputProductId=parsed.data.outputProductId??null;
      if(!outputProductId&&parsed.data.outputProductName)outputProductId=(await ensureProduct(client,{productName:parsed.data.outputProductName})).id;
      const x=await client.query("INSERT INTO order_stages(order_id,stage_id,output_product_id,sequence_no,planned_quantity,notes,stage_rate,stage_rate_method,production_type_id,is_final_product) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[orderId,stage.id,outputProductId,parsed.data.sequenceNo,parsed.data.plannedQuantity??null,parsed.data.notes??null,parsed.data.stageRate??null,parsed.data.stageRateMethod??null,parsed.data.productionTypeId??null,parsed.data.isFinalProduct]);
      if(outputProductId)await client.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,TRUE) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default",[stage.id,outputProductId]);
      if(parsed.data.isFinalProduct)await syncOrderLinesFromFinalStages(client,orderId);
      const refreshed=await client.query("SELECT * FROM order_stages WHERE id=$1",[x.rows[0].id]);
      return refreshed.rows[0];
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
    const parsed=z.object({stageId:z.string().uuid().optional(),stageName:z.string().trim().min(2).max(200).optional(),outputProductId:z.string().uuid().nullable().optional(),outputProductName:z.string().trim().min(2).max(200).optional(),sequenceNo:z.number().int().positive().optional(),plannedQuantity:z.number().nonnegative().nullable().optional(),status:z.enum(["PENDING","READY","IN_PROGRESS","COMPLETED","CANCELLED"]).optional(),notes:z.string().trim().max(500).nullable().optional(),stageRate:z.number().nonnegative().nullable().optional(),stageRateMethod:z.enum(["PER_PIECE","PER_1000","PER_HOUR","PER_DAY","PERCENTAGE"]).nullable().optional(),productionTypeId:z.string().uuid().nullable().optional(),isFinalProduct:z.boolean().optional()}).safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات تعديل المرحلة غير صحيحة",422);
    const p=parsed.data;
    const r=await withTransaction(async client=>{
      const current=await client.query("SELECT * FROM order_stages WHERE id=$1 FOR UPDATE",[id]);
      if(!current.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",404);
      const stage= p.stageId||p.stageName ? await ensureStage(client,{stageId:p.stageId,stageName:p.stageName}) : {id:current.rows[0].stage_id};
      let outputProductId=p.outputProductId;
      if(!outputProductId&&p.outputProductName)outputProductId=(await ensureProduct(client,{productName:p.outputProductName})).id;
      const x=await client.query("UPDATE order_stages SET stage_id=COALESCE($1,stage_id),output_product_id=COALESCE($2,output_product_id),sequence_no=COALESCE($3,sequence_no),planned_quantity=COALESCE($4,planned_quantity),status=COALESCE($5,status),notes=COALESCE($6,notes),stage_rate=COALESCE($7,stage_rate),stage_rate_method=COALESCE($8,stage_rate_method),production_type_id=COALESCE($9,production_type_id),is_final_product=COALESCE($10,is_final_product),order_item_id=CASE WHEN $10=FALSE OR $5='CANCELLED' THEN NULL ELSE order_item_id END WHERE id=$11 RETURNING *",[stage.id,outputProductId??null,p.sequenceNo??null,p.plannedQuantity??null,p.status??null,p.notes??null,p.stageRate??null,p.stageRateMethod??null,p.productionTypeId??null,p.isFinalProduct??null,id]);
      if(outputProductId)await client.query("INSERT INTO stage_outputs(stage_id,product_id,is_default) VALUES($1,$2,TRUE) ON CONFLICT(stage_id,product_id) DO UPDATE SET is_default=EXCLUDED.is_default",[stage.id,outputProductId]);
      if((p.isFinalProduct!==undefined && p.isFinalProduct!==current.rows[0].is_final_product) || (current.rows[0].is_final_product && (p.outputProductName!==undefined || p.outputProductId!==undefined || p.plannedQuantity!==undefined || p.status==="CANCELLED"))) await syncOrderLinesFromFinalStages(client,current.rows[0].order_id);
      const refreshed=await client.query("SELECT * FROM order_stages WHERE id=$1",[id]);
      return refreshed.rows[0];
    });
    return {data:r};
  });

  app.post("/api/orders/:id/price-changes", { preHandler: [authenticateRequest, requirePermission("orders.manage_stages")] }, async (request, reply) => {
    const orderId=(request.params as {id:string}).id;
    const parsed=z.object({
      orderStageId:z.string().uuid(),
      newRate:z.number().nonnegative(),
      scope:z.enum(["NEW_ONLY","UNPAID_ONLY","ALL"]),
      reason:z.string().trim().min(2).max(500)
    }).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات تغيير سعر الطلبية غير صحيحة",422);
    const result=await withTransaction(async client=>{
      const order=await client.query("SELECT id,code,order_name,status FROM production_orders WHERE id=$1 FOR UPDATE",[orderId]);
      if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",404);
      if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن تغيير سعر طلبية ملغاة",409);
      const stage=await client.query("SELECT * FROM order_stages WHERE id=$1 AND order_id=$2 FOR UPDATE",[parsed.data.orderStageId,orderId]);
      if(!stage.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","المرحلة لا تتبع هذه الطلبية",404);
      const oldRate=stage.rows[0].stage_rate==null?null:Number(stage.rows[0].stage_rate);
      const newRate=parsed.data.newRate;
      await client.query("UPDATE order_stages SET stage_rate=$1 WHERE id=$2",[newRate,parsed.data.orderStageId]);
      const created=await client.query(
        "INSERT INTO order_price_changes(order_id,order_stage_id,previous_rate,new_rate,scope,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [orderId,parsed.data.orderStageId,oldRate,newRate,parsed.data.scope,parsed.data.reason,request.user!.userId]
      );
      let affected=0,totalDelta=0;
      if(parsed.data.scope!=="NEW_ONLY"){
        const entries=await client.query(
          `SELECT pe.id,pe.employee_id,pe.status,pe.quantity,pe.hours_worked,pe.base_amount,
                  pe.wage_type_method_snapshot,pe.rate_snapshot,pe.earning_amount,pe.bonus_amount,pe.deduction_amount,
                  COALESCE((SELECT SUM(wpa.amount) FROM worker_payment_allocations wpa WHERE wpa.production_entry_id=pe.id),0) AS paid_amount,
                  COALESCE((SELECT pci.revised_earning FROM order_price_change_items pci WHERE pci.production_entry_id=pe.id ORDER BY pci.created_at DESC,pci.id DESC LIMIT 1),pe.earning_amount) AS effective_earning
             FROM production_entries pe
            WHERE pe.order_stage_id=$1 AND pe.status IN ('PENDING','APPROVED')
            ${parsed.data.scope==="UNPAID_ONLY"?"AND COALESCE((SELECT SUM(wpa.amount) FROM worker_payment_allocations wpa WHERE wpa.production_entry_id=pe.id),0) = 0":""}
            ORDER BY pe.created_at,pe.id
            FOR UPDATE OF pe`,
          [parsed.data.orderStageId]
        );
        const proposed=entries.rows.map((entry:any)=>{
          const previous=Number(entry.effective_earning);
          const revised=calculateStageEarning(String(entry.wage_type_method_snapshot),newRate,entry);
          const delta=Math.round((revised-previous+Number.EPSILON)*100)/100;
          const paid=Number(entry.paid_amount);
          const revisedTotal=revised+Number(entry.bonus_amount||0)-Number(entry.deduction_amount||0);
          if(revisedTotal+0.0001<paid)throw new AppError("PRICE_BELOW_PAID_AMOUNT","السعر الجديد سيجعل مستحق العملية أقل من المبلغ المصروف بالفعل. راجع السعر قبل الحفظ.",409);
          return {...entry,previous,revised,delta,paid};
        });
        const debitsByEmployee=new Map<string,number>();
        for(const item of proposed){if(item.status==="APPROVED"&&item.delta<0)debitsByEmployee.set(item.employee_id,(debitsByEmployee.get(item.employee_id)||0)+Math.abs(item.delta));}
        for(const [employeeId,needed] of debitsByEmployee){
          const balance=await client.query("SELECT COALESCE(SUM(credit_amount-debit_amount),0) AS remaining FROM employee_earnings_ledger WHERE employee_id=$1",[employeeId]);
          if(Number(balance.rows[0]?.remaining||0)+0.0001<needed)throw new AppError("INSUFFICIENT_EARNINGS_BALANCE","خفض السعر سيخصم أكثر من الرصيد المتاح لأحد العمال. تم إلغاء العملية بالكامل لحماية حساباتهم.",409);
        }
        for(const item of proposed){
          await client.query(
            "INSERT INTO order_price_change_items(price_change_id,production_entry_id,employee_id,previous_earning,revised_earning,delta_amount,ledger_adjustment,applied_rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(price_change_id,production_entry_id) DO NOTHING",
            [created.rows[0].id,item.id,item.employee_id,item.previous,item.revised,item.delta,item.status==="APPROVED",newRate]
          );
          if(item.status==="PENDING"){
            await client.query("UPDATE production_entries SET rate_snapshot=$1,earning_amount=$2,updated_at=now() WHERE id=$3",[newRate,item.revised,item.id]);
          }else if(Math.abs(item.delta)>=0.005){
            const credit=item.delta>0?item.delta:0;
            const debit=item.delta<0?Math.abs(item.delta):0;
            await client.query(
              "INSERT INTO employee_earnings_ledger(employee_id,entry_type,credit_amount,debit_amount,production_entry_id,created_by,notes) VALUES($1,'ADJUSTMENT',$2,$3,NULL,$4,$5)",
              [item.employee_id,credit,debit,request.user!.userId,"تغيير سعر الطلبية "+order.rows[0].code+" / عملية "+item.id+" — "+parsed.data.reason]
            );
          }
          affected++;
          totalDelta+=item.delta;
        }
      }
      const updated=await client.query("UPDATE order_price_changes SET affected_entries=$1,total_delta=$2 WHERE id=$3 RETURNING *",[affected,Math.round((totalDelta+Number.EPSILON)*100)/100,created.rows[0].id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"price_change",module:"orders",entityType:"order_price_change",entityId:updated.rows[0].id,beforeData:{stageRate:oldRate},afterData:updated.rows[0],metadata:{orderCode:order.rows[0].code,stageId:parsed.data.orderStageId,scope:parsed.data.scope,reason:parsed.data.reason,affectedEntries:affected,totalDelta},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return reply.code(201).send({data:result});
  });

  app.get("/api/orders/:id/price-changes", { preHandler: [authenticateRequest, requirePermission("orders.view")] }, async (request) => {
    const orderId=(request.params as {id:string}).id;
    const result=await pool.query(
      `SELECT pc.id,pc.code,pc.order_stage_id,pc.previous_rate,pc.new_rate,pc.scope,pc.reason,pc.affected_entries,pc.total_delta,pc.created_at,
              s.name AS stage_name,u.username AS created_by_username,
              COALESCE(json_agg(jsonb_build_object('employee_name',e.full_name,'production_code',pe.code,'previous_earning',pci.previous_earning,'revised_earning',pci.revised_earning,'delta_amount',pci.delta_amount) ORDER BY e.full_name,pe.code) FILTER (WHERE pci.id IS NOT NULL),'[]') AS affected
         FROM order_price_changes pc
         JOIN order_stages os ON os.id=pc.order_stage_id
         JOIN stages s ON s.id=os.stage_id
         JOIN users u ON u.id=pc.created_by
         LEFT JOIN order_price_change_items pci ON pci.price_change_id=pc.id
         LEFT JOIN employees e ON e.id=pci.employee_id
         LEFT JOIN production_entries pe ON pe.id=pci.production_entry_id
        WHERE pc.order_id=$1
        GROUP BY pc.id,s.name,u.username
        ORDER BY pc.created_at DESC
        LIMIT 100`,
      [orderId]
    );
    return {data:result.rows};
  });

  app.get("/api/orders/:id/dashboard", { preHandler: [authenticateRequest, requirePermission("orders.dashboard")] }, async (request) => {
    const id=(request.params as {id:string}).id;
    const order=await pool.query("SELECT o.* FROM production_orders o WHERE o.id=$1",[id]);
    if(!order.rowCount) throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
    const [stages,production,machineProduction,movements,deliveries,payments,orderLines]=await Promise.all([
      pool.query("SELECT os.id,os.sequence_no,os.status,os.planned_quantity,os.completed_quantity,os.stage_rate,os.stage_rate_method,os.production_type_id,os.notes,s.name AS stage_name,p.name AS output_product_name,os.is_final_product FROM order_stages os JOIN stages s ON s.id=os.stage_id LEFT JOIN products p ON p.id=os.output_product_id WHERE os.order_id=$1 ORDER BY os.sequence_no",[id]),
      pool.query("SELECT pe.id,pe.code,pe.product_id,os.id AS order_stage_id,pe.work_date,pe.quantity,pe.earning_amount,pe.bonus_amount,pe.deduction_amount,pe.total_earning_amount,pe.status,e.full_name AS employee_name,p.name AS product_name,s.name AS stage_name,pt.name AS production_type_name,COALESCE((SELECT SUM(pci.delta_amount) FROM order_price_change_items pci WHERE pci.production_entry_id=pe.id AND pci.ledger_adjustment=TRUE),0) AS price_adjustment_amount FROM production_entries pe JOIN employees e ON e.id=pe.employee_id JOIN products p ON p.id=pe.product_id JOIN stages s ON s.id=pe.stage_id LEFT JOIN production_types pt ON pt.id=pe.production_type_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status <> 'CANCELLED' ORDER BY pe.work_date DESC,pe.created_at DESC LIMIT 500",[id]),
      pool.query("SELECT mp.id,mp.product_id,os.id AS order_stage_id,mp.quantity,p.name AS product_name,s.name AS stage_name FROM machine_productions mp JOIN order_stages os ON os.id=mp.order_stage_id JOIN products p ON p.id=mp.product_id JOIN stages s ON s.id=os.stage_id WHERE os.order_id=$1 ORDER BY s.name,p.name",[id]),
      pool.query("SELECT sm.code,sm.movement_type,sm.quantity,sm.unit_cost,sm.total_cost,sm.created_at,p.name AS product_name,w.name AS warehouse_name FROM stock_movements sm JOIN products p ON p.id=sm.product_id JOIN warehouses w ON w.id=sm.warehouse_id WHERE sm.order_id=$1 AND sm.movement_type='OUT' ORDER BY sm.created_at DESC LIMIT 500",[id]),
      pool.query("SELECT d.id,d.code,d.destination,d.status,d.created_at,d.released_at,COALESCE(SUM(dl.quantity),0) AS quantity FROM delivery_permissions d LEFT JOIN delivery_permission_lines dl ON dl.delivery_permission_id=d.id WHERE d.order_id=$1 GROUP BY d.id ORDER BY d.created_at DESC",[id]),
      pool.query("SELECT wpa.production_entry_id,COALESCE(SUM(wpa.amount),0) AS paid_amount FROM worker_payment_allocations wpa JOIN production_entries pe ON pe.id=wpa.production_entry_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 GROUP BY wpa.production_entry_id",[id]),
      pool.query("SELECT p.id AS product_id,p.name AS product_name,pol.quantity,pol.unit_id,u.name AS unit_name FROM production_order_lines pol JOIN products p ON p.id=pol.product_id JOIN units u ON u.id=pol.unit_id WHERE pol.order_id=$1 ORDER BY pol.id",[id])
    ]);
    const totals=await pool.query("SELECT COALESCE((SELECT SUM(COALESCE(pe.total_earning_amount,pe.earning_amount)) FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status='APPROVED'),0)+COALESCE((SELECT SUM(pci.delta_amount) FROM order_price_change_items pci JOIN production_entries pe ON pe.id=pci.production_entry_id JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status='APPROVED' AND pci.ledger_adjustment=TRUE),0) AS production_cost,COALESCE((SELECT SUM(total_cost) FROM stock_movements WHERE order_id=$1 AND movement_type='OUT'),0) AS stock_out_cost,COALESCE((SELECT SUM(amount) FROM accounting_expenses WHERE order_id=$1),0) AS order_expenses",[id]);
    const paidMap=new Map<string,number>(payments.rows.map((x:{production_entry_id:string;paid_amount:string|number})=>[x.production_entry_id,Number(x.paid_amount)]));
    const productionWithPayments=production.rows.map((x:{id:string;total_earning_amount?:string|number;earning_amount:string|number;price_adjustment_amount?:string|number})=>({
      ...x,
      paid_amount:paidMap.get(x.id)??0,
      remaining_amount:Math.max(0,Number(x.total_earning_amount??x.earning_amount)+Number(x.price_adjustment_amount??0)-Number(paidMap.get(x.id)??0))
    }));
    return {data:{order:order.rows[0],finalProduct:orderLines.rows.length===1?orderLines.rows[0]:null,finalProducts:orderLines.rows,stages:stages.rows,production:productionWithPayments,machineProduction:machineProduction.rows,movements:movements.rows,deliveries:deliveries.rows,totals:totals.rows[0]}};
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
    const row=await withTransaction(async(client)=>{
      const machine=await client.query("SELECT id FROM machines WHERE id=$1 AND is_active=TRUE FOR UPDATE",[parsed.data.machineId]);
      if(!machine.rowCount) throw new AppError("MACHINE_NOT_FOUND","الماكينة غير موجودة أو غير نشطة",422);
      const product = await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",[parsed.data.productId]);
      if(!product.rowCount) throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود أو غير نشط",422);
      if(parsed.data.employeeId){
        const employee=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[parsed.data.employeeId]);
        if(!employee.rowCount) throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
      }
      if(parsed.data.shiftId){
        const shift=await client.query("SELECT id FROM shifts WHERE id=$1 AND is_active=TRUE",[parsed.data.shiftId]);
        if(!shift.rowCount) throw new AppError("SHIFT_NOT_FOUND","الوردية غير موجودة أو غير نشطة",422);
      }
      if(parsed.data.productionTypeId){
        const type=await client.query("SELECT id FROM production_types WHERE id=$1 AND is_active=TRUE",[parsed.data.productionTypeId]);
        if(!type.rowCount) throw new AppError("PRODUCTION_TYPE_NOT_FOUND","نوع الإنتاج غير موجود أو غير نشط",422);
      }
      if(parsed.data.orderStageId){
        const stage=await client.query(`SELECT os.id,os.order_id,os.stage_id,os.output_product_id,po.status
          FROM order_stages os JOIN production_orders po ON po.id=os.order_id
          WHERE os.id=$1 FOR UPDATE`,[parsed.data.orderStageId]);
        if(!stage.rowCount) throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        const s=stage.rows[0];
        if(s.status==="CANCELLED") throw new AppError("ORDER_CANCELLED","لا يمكن تسجيل إنتاج ماكينة لمرحلة طلبية ملغاة",409);
        if(!s.output_product_id) throw new AppError("ORDER_STAGE_OUTPUT_REQUIRED","اربط منتجًا ناتجًا بمرحلة الطلبية قبل تسجيل إنتاج الماكينة",422);
        if(s.output_product_id!==parsed.data.productId) throw new AppError("ORDER_STAGE_PRODUCT_MISMATCH","المنتج المختار لا يطابق المنتج الناتج من المرحلة المحددة",409);
      }
      const unitId=parsed.data.unitId ?? product.rows[0].unit_id;
      const r=await client.query(
        `INSERT INTO machine_productions(order_stage_id,production_type_id,machine_id,product_id,employee_id,shift_id,work_date,quantity,unit_id,notes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [parsed.data.orderStageId ?? null,parsed.data.productionTypeId ?? null,parsed.data.machineId,parsed.data.productId,parsed.data.employeeId ?? null,parsed.data.shiftId ?? null,parsed.data.workDate,parsed.data.quantity,unitId,parsed.data.notes ?? null,request.user!.userId]
      );
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"orders",entityType:"machine_production",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return r.rows[0];
    });
    return reply.code(201).send({data:row});
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

  app.get("/api/orders/:id/reconciliation",{preHandler:[authenticateRequest,requirePermission("orders.dashboard")]},async(request)=>{
    const id=(request.params as {id:string}).id;
    const order=await pool.query("SELECT id,code,order_name,status FROM production_orders WHERE id=$1",[id]);
    if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلب غير موجود",404);
    const [ordered,produced,delivered,stock] = await Promise.all([
      pool.query("SELECT product_id,COALESCE(SUM(quantity),0) AS quantity FROM production_order_lines WHERE order_id=$1 GROUP BY product_id",[id]),
      pool.query("SELECT pe.product_id,COALESCE(SUM(pe.quantity),0) AS quantity FROM production_entries pe JOIN order_stages os ON os.id=pe.order_stage_id WHERE os.order_id=$1 AND pe.status='APPROVED' GROUP BY pe.product_id",[id]),
      pool.query("SELECT dl.product_id,COALESCE(SUM(dl.quantity),0) AS quantity FROM delivery_permission_lines dl JOIN delivery_permissions d ON d.id=dl.delivery_permission_id WHERE d.order_id=$1 AND d.status='RELEASED' GROUP BY dl.product_id",[id]),
      pool.query("SELECT sm.product_id,COALESCE(SUM(CASE WHEN sm.movement_type IN ('OUT','TRANSFER_OUT') THEN sm.quantity ELSE 0 END),0) AS stock_out,COALESCE(SUM(CASE WHEN sm.movement_type IN ('IN','RETURN','TRANSFER_IN','ADJUSTMENT') THEN sm.quantity ELSE 0 END),0) AS stock_in FROM stock_movements sm WHERE sm.order_id=$1 GROUP BY sm.product_id",[id])
    ]);
    const map=new Map<string,{ordered:number;produced:number;delivered:number;stockOut:number;stockIn:number}>();
    for(const row of ordered.rows)map.set(row.product_id,{ordered:Number(row.quantity),produced:0,delivered:0,stockOut:0,stockIn:0});
    for(const row of produced.rows){const x=map.get(row.product_id)||{ordered:0,produced:0,delivered:0,stockOut:0,stockIn:0};x.produced=Number(row.quantity);map.set(row.product_id,x)}
    for(const row of delivered.rows){const x=map.get(row.product_id)||{ordered:0,produced:0,delivered:0,stockOut:0,stockIn:0};x.delivered=Number(row.quantity);map.set(row.product_id,x)}
    for(const row of stock.rows){const x=map.get(row.product_id)||{ordered:0,produced:0,delivered:0,stockOut:0,stockIn:0};x.stockOut=Number(row.stock_out);x.stockIn=Number(row.stock_in);map.set(row.product_id,x)}
    const products=[...map.entries()].map(([productId,x])=>({...x,productId,productionVariance:x.produced-x.ordered,deliveryVariance:x.delivered-x.ordered}));
    return {data:{order:order.rows[0],products,ok:products.every(x=>x.produced<=x.ordered+1e-9 && x.delivered<=x.ordered+1e-9)}};
  });

}
