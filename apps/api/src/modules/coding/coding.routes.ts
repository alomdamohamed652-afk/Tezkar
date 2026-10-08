import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const createSchema = z.object({
  packagingTypeId: z.string().uuid(),
  templateId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid(),
  productionOrderId: z.string().uuid().nullable().optional(),
  orderStageId: z.string().uuid().nullable().optional(),
  batchCode: z.string().trim().max(100).nullable().optional(),
  quantity: z.number().positive(),
  unitId: z.string().uuid().nullable().optional(),
  weight: z.number().nonnegative().nullable().optional(),
  productionOwnerEmployeeId: z.string().uuid().nullable().optional(),
  packedByEmployeeId: z.string().uuid().nullable().optional(),
  receivedByEmployeeId: z.string().uuid().nullable().optional(),
  packedAt: z.string().datetime().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  productionEntryId: z.string().uuid().nullable().optional()
});

function makeCode(sequence:number, year:number) {
  return `TZK-${String(year).slice(-2)}-${String(sequence).padStart(6,"0")}`;
}

export async function codingRoutes(app: FastifyInstance) {
  app.get("/api/coding/packaging-types",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT * FROM coding_packaging_types WHERE is_active=TRUE ORDER BY id");
    return {data:r.rows};
  });

  app.get("/api/coding/warehouses",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT id,code,name FROM warehouses WHERE is_active=TRUE ORDER BY name");
    return {data:r.rows};
  });

  app.get("/api/coding/locations",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT id,warehouse_id,code,name FROM warehouse_locations WHERE is_active=TRUE ORDER BY name");
    return {data:r.rows};
  });

  app.get("/api/coding/products",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT id,code,name FROM products WHERE is_active=TRUE ORDER BY name");
    return {data:r.rows};
  });

  app.get("/api/coding/employees",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT id,code,full_name AS name FROM employees WHERE is_active=TRUE ORDER BY full_name");
    return {data:r.rows};
  });

  app.get("/api/coding/templates",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT t.*,p.code AS packaging_type_code,p.name AS packaging_type_name FROM coding_templates t LEFT JOIN coding_packaging_types p ON p.id=t.packaging_type_id WHERE t.is_active=TRUE ORDER BY t.is_default DESC,t.created_at");
    return {data:r.rows};
  });

  app.post("/api/coding/templates",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request,reply)=>{
    const parsed=z.object({name:z.string().trim().min(2).max(120),packagingTypeId:z.string().uuid().nullable().optional(),widthMm:z.number().positive().max(500),heightMm:z.number().positive().max(500),orientation:z.enum(["LANDSCAPE","PORTRAIT"]),companyName:z.string().trim().max(120).optional(),companyAddress:z.string().trim().max(250).optional(),logoUrl:z.string().trim().max(500).nullable().optional()}).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات مقاس التكويد غير صحيحة",422);
    const p=parsed.data;
    if(p.packagingTypeId){
      const pt=await pool.query("SELECT id FROM coding_packaging_types WHERE id=$1 AND is_active=TRUE",[p.packagingTypeId]);
      if(!pt.rowCount)throw new AppError("PACKAGING_TYPE_NOT_FOUND","نوع العبوة غير موجود",422);
    }
    const row=await withTransaction(async client=>{
      const x=await client.query("INSERT INTO coding_templates(name,packaging_type_id,width_mm,height_mm,orientation,config,is_default) VALUES($1,$2,$3,$4,$5,$6,false) RETURNING *",[p.name,p.packagingTypeId??null,p.widthMm,p.heightMm,p.orientation,JSON.stringify({companyName:p.companyName??"تذكار",companyAddress:p.companyAddress??"عنوان الشركة",logoUrl:p.logoUrl??null})]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"coding",entityType:"coding_template",entityId:x.rows[0].id,afterData:x.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return x.rows[0];
    });
    return reply.code(201).send({data:row});
  });

  app.patch("/api/coding/templates/:id",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request)=>{
    const id=String((request.params as {id:string}).id);
    const parsed=z.object({
      widthMm:z.number().positive().max(500),
      heightMm:z.number().positive().max(500),
      orientation:z.enum(["LANDSCAPE","PORTRAIT"]),
      companyName:z.string().trim().max(120).optional(),
      companyAddress:z.string().trim().max(250).optional(),
      logoUrl:z.string().trim().max(500).nullable().optional()
    }).safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات قالب الطباعة غير صحيحة",422);
    const updated=await withTransaction(async(client)=>{
      const current=await client.query("SELECT * FROM coding_templates WHERE id=$1 AND is_active=TRUE FOR UPDATE",[id]);
      if(!current.rowCount)throw new AppError("TEMPLATE_NOT_FOUND","قالب الطباعة غير موجود",404);
      const p=parsed.data;
      const oldConfig=current.rows[0].config||{};
      const config={...oldConfig,companyName:p.companyName??oldConfig.companyName??"تذكار",companyAddress:p.companyAddress??oldConfig.companyAddress??"عنوان الشركة",logoUrl:p.logoUrl??oldConfig.logoUrl??null};
      const row=await client.query("UPDATE coding_templates SET width_mm=$1,height_mm=$2,orientation=$3,config=$4 WHERE id=$5 RETURNING *",[p.widthMm,p.heightMm,p.orientation,JSON.stringify(config),id]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"update",module:"coding",entityType:"coding_template",entityId:id,beforeData:current.rows[0],afterData:row.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return row.rows[0];
    });
    return {data:updated};
  });

  app.get("/api/coding/units",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query(`
      SELECT c.*, p.name AS product_name,p.code AS product_code,
             pt.name AS packaging_type_name,
             w.name AS warehouse_name,l.name AS location_name,
             pe.full_name AS production_owner_name,
             ce.full_name AS packed_by_name,re.full_name AS received_by_name
      FROM coding_units c
      JOIN products p ON p.id=c.product_id
      JOIN coding_packaging_types pt ON pt.id=c.packaging_type_id
      LEFT JOIN warehouses w ON w.id=c.warehouse_id
      LEFT JOIN warehouse_locations l ON l.id=c.location_id
      LEFT JOIN employees pe ON pe.id=c.production_owner_employee_id
      LEFT JOIN employees ce ON ce.id=c.packed_by_employee_id
      LEFT JOIN employees re ON re.id=c.received_by_employee_id
      ORDER BY c.created_at DESC LIMIT 500
    `);
    return {data:r.rows};
  });

  app.get("/api/coding/units/:code",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async(request)=>{
    const code=String((request.params as {code:string}).code);
    const r=await pool.query(`
      SELECT c.*, p.name AS product_name,p.code AS product_code,
             pt.name AS packaging_type_name,
             w.name AS warehouse_name,l.name AS location_name,
             pe.full_name AS production_owner_name,
             ce.full_name AS packed_by_name,re.full_name AS received_by_name
      FROM coding_units c
      JOIN products p ON p.id=c.product_id
      JOIN coding_packaging_types pt ON pt.id=c.packaging_type_id
      LEFT JOIN warehouses w ON w.id=c.warehouse_id
      LEFT JOIN warehouse_locations l ON l.id=c.location_id
      LEFT JOIN employees pe ON pe.id=c.production_owner_employee_id
      LEFT JOIN employees ce ON ce.id=c.packed_by_employee_id
      LEFT JOIN employees re ON re.id=c.received_by_employee_id
      WHERE c.code=$1 OR c.barcode=$1 LIMIT 1
    `,[code]);
    if(!r.rowCount)throw new AppError("CODING_NOT_FOUND","الكود غير موجود",404);
    const unit=r.rows[0];
    const [moves,prints]=await Promise.all([
      pool.query("SELECT * FROM coding_unit_movements WHERE coding_unit_id=$1 ORDER BY created_at DESC",[unit.id]),
      pool.query("SELECT * FROM coding_print_logs WHERE coding_unit_id=$1 ORDER BY printed_at DESC",[unit.id])
    ]);
    return {data:{...unit,movements:moves.rows,prints:prints.rows}};
  });

  app.get("/api/coding/production-ready",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query(`
      SELECT p.id AS production_entry_id,p.code,p.work_date,p.quantity,p.product_id,p.stage_id,p.order_stage_id,
             p.warehouse_id,p.location_id,p.employee_id,
             pr.code AS product_code,pr.name AS product_name,
             st.name AS stage_name,
             os.order_id,po.code AS order_code,po.order_name,
             w.name AS warehouse_name,l.code AS location_code,l.name AS location_name,
             u.name AS unit_name,
             COALESCE((SELECT SUM(cu.quantity) FROM coding_units cu WHERE cu.production_entry_id=p.id AND cu.status<>'CANCELLED'),0) AS coded_quantity
        FROM production_entries p
        JOIN products pr ON pr.id=p.product_id
        JOIN stages st ON st.id=p.stage_id
        LEFT JOIN order_stages os ON os.id=p.order_stage_id
        LEFT JOIN production_orders po ON po.id=os.order_id
        JOIN warehouses w ON w.id=p.warehouse_id
        JOIN warehouse_locations l ON l.id=p.location_id
        JOIN units u ON u.id=p.unit_id
       WHERE p.status='APPROVED'
         AND p.quantity > COALESCE((SELECT SUM(cu.quantity) FROM coding_units cu WHERE cu.production_entry_id=p.id AND cu.status<>'CANCELLED'),0)
       ORDER BY p.work_date DESC,p.created_at DESC
       LIMIT 300
    `);
    return {data:r.rows.map(x=>({...x,remaining_quantity:Number(x.quantity)-Number(x.coded_quantity)}))};
  });

  app.post("/api/coding/units",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request,reply)=>{
    const parsed=createSchema.safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات التكويد غير صحيحة",422);

    const created=await withTransaction(async(client)=>{
      const p=parsed.data;
      let resolvedProductId=p.productId;
      let resolvedOrderId=p.productionOrderId??null;
      let resolvedOrderStageId=p.orderStageId??null;
      let resolvedWarehouseId=p.warehouseId??null;
      let resolvedLocationId=p.locationId??null;
      if(p.productionEntryId){
        const production=await client.query(
          `SELECT id,status,quantity,product_id,order_stage_id,warehouse_id,location_id,unit_id
             FROM production_entries WHERE id=$1 FOR UPDATE`,
          [p.productionEntryId]
        );
        if(!production.rowCount)throw new AppError("PRODUCTION_NOT_FOUND","سجل الإنتاج غير موجود",422);
        const pe=production.rows[0];
        if(pe.status!=="APPROVED")throw new AppError("PRODUCTION_NOT_APPROVED","لا يمكن تكويد إنتاج غير معتمد",409);
        const coded=await client.query(
          "SELECT COALESCE(SUM(quantity),0) AS quantity FROM coding_units WHERE production_entry_id=$1 AND status<>'CANCELLED'",
          [p.productionEntryId]
        );
        const remaining=Number(pe.quantity)-Number(coded.rows[0]?.quantity??0);
        if(p.quantity>remaining+1e-9)throw new AppError("CODING_EXCEEDS_PRODUCTION","كمية التكويد تتجاوز الكمية المتبقية من الإنتاج المعتمد",409);
        resolvedProductId=pe.product_id;
        resolvedOrderStageId=pe.order_stage_id;
        resolvedWarehouseId=pe.warehouse_id;
        resolvedLocationId=pe.location_id;
        if(resolvedOrderStageId){
          const os=await client.query("SELECT order_id FROM order_stages WHERE id=$1",[resolvedOrderStageId]);
          resolvedOrderId=os.rows[0]?.order_id??null;
        }
      }
      const pt=await client.query("SELECT * FROM coding_packaging_types WHERE id=$1 AND is_active=TRUE",[p.packagingTypeId]);
      if(!pt.rowCount)throw new AppError("PACKAGING_TYPE_NOT_FOUND","نوع العبوة غير موجود",422);
      const product=await client.query("SELECT id,unit_id,name FROM products WHERE id=$1 AND is_active=TRUE",[resolvedProductId]);
      if(resolvedOrderId){
        const order=await client.query("SELECT id,status FROM production_orders WHERE id=$1 FOR UPDATE",[resolvedOrderId]);
        if(!order.rowCount)throw new AppError("ORDER_NOT_FOUND","الطلبية غير موجودة",422);
        if(order.rows[0].status==="CANCELLED")throw new AppError("ORDER_CANCELLED","لا يمكن تكويد إنتاج من طلبية ملغاة",409);
      }
      if(resolvedOrderStageId){
        const stage=await client.query("SELECT id,order_id,output_product_id FROM order_stages WHERE id=$1 FOR UPDATE",[resolvedOrderStageId]);
        if(!stage.rowCount)throw new AppError("ORDER_STAGE_NOT_FOUND","مرحلة الطلب غير موجودة",422);
        if(resolvedOrderId && stage.rows[0].order_id!==resolvedOrderId)throw new AppError("ORDER_STAGE_ORDER_MISMATCH","مرحلة الطلب لا تنتمي إلى الطلبية المحددة",409);
        if(stage.rows[0].output_product_id && stage.rows[0].output_product_id!==resolvedProductId)throw new AppError("ORDER_STAGE_PRODUCT_MISMATCH","المنتج لا يطابق المنتج الناتج من المرحلة",409);
      }
      if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود",422);

      let templateId=p.templateId??null;
      if(templateId){
        const t=await client.query("SELECT id,packaging_type_id FROM coding_templates WHERE id=$1 AND is_active=TRUE",[templateId]);
        if(!t.rowCount)throw new AppError("TEMPLATE_NOT_FOUND","قالب الطباعة غير موجود",422);
        if(t.rows[0].packaging_type_id && t.rows[0].packaging_type_id!==p.packagingTypeId)throw new AppError("TEMPLATE_PACKAGING_MISMATCH","قالب الطباعة لا يطابق نوع العبوة",409);
      }else{
        const t=await client.query("SELECT id FROM coding_templates WHERE packaging_type_id=$1 AND is_active=TRUE ORDER BY is_default DESC LIMIT 1",[p.packagingTypeId]);
        templateId=t.rows[0]?.id??null;
      }

      if(resolvedWarehouseId && resolvedLocationId){
        const loc=await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[resolvedLocationId,resolvedWarehouseId]);
        if(!loc.rowCount)throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);
      }

      const initialStatus=resolvedWarehouseId&&resolvedLocationId?"IN_STOCK":"CODED";
      const seq=await client.query("SELECT nextval('coding_unit_sequence') AS n");
      const code=makeCode(Number(seq.rows[0].n),new Date().getFullYear());
      const barcode=code;
      const row=await client.query(`
        INSERT INTO coding_units
        (code,barcode,packaging_type_id,template_id,product_id,production_order_id,order_stage_id,batch_code,quantity,unit_id,weight,production_entry_id,
         production_owner_employee_id,packed_by_employee_id,received_by_employee_id,packed_at,coded_at,warehouse_id,location_id,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$17,$18,$19,$20)
        RETURNING *
      `,[
        code,barcode,p.packagingTypeId,templateId,resolvedProductId,resolvedOrderId,resolvedOrderStageId,p.batchCode??null,p.quantity,
        p.unitId??product.rows[0].unit_id??null,p.weight??null,p.productionOwnerEmployeeId??null,p.packedByEmployeeId??null,
        p.productionEntryId??null,p.receivedByEmployeeId??null,p.packedAt??null,resolvedWarehouseId,resolvedLocationId,initialStatus,request.user!.userId
      ]);

      await client.query("INSERT INTO coding_unit_movements(coding_unit_id,movement_type,to_warehouse_id,to_location_id,notes,created_by) VALUES($1,$2,$3,$4,$5,$6)",[
        row.rows[0].id,initialStatus,resolvedWarehouseId,resolvedLocationId,"تم إنشاء التكويد",request.user!.userId
      ]);
      await client.query("INSERT INTO coding_print_logs(coding_unit_id,print_type,template_id,printed_by) VALUES($1,'INITIAL',$2,$3)",[row.rows[0].id,templateId,request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"coding",entityType:"coding_unit",entityId:row.rows[0].id,afterData:row.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return row.rows[0];
    });

    return reply.code(201).send({data:created});
  });

  app.post("/api/coding/units/:id/print",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request)=>{
    const id=String((request.params as {id:string}).id);
    const r=await withTransaction(async(client)=>{
      const unit=await client.query("SELECT * FROM coding_units WHERE id=$1 FOR UPDATE",[id]);
      if(!unit.rowCount)throw new AppError("CODING_NOT_FOUND","الكود غير موجود",404);
      await client.query("INSERT INTO coding_print_logs(coding_unit_id,print_type,template_id,printed_by) VALUES($1,'REPRINT',$2,$3)",[id,unit.rows[0].template_id,request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"print",module:"coding",entityType:"coding_unit",entityId:id,afterData:{printType:"REPRINT"},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return unit.rows[0];
    });
    return {data:r};
  });

  app.post("/api/coding/units/:id/cancel",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request)=>{
    const id=String((request.params as {id:string}).id);
    const body=z.object({reason:z.string().trim().min(3).max(300)}).safeParse(request.body);
    if(!body.success)throw new AppError("VALIDATION_ERROR","سبب الإلغاء مطلوب",422);
    const r=await withTransaction(async(client)=>{
      const unit=await client.query("SELECT * FROM coding_units WHERE id=$1 FOR UPDATE",[id]);
      if(!unit.rowCount)throw new AppError("CODING_NOT_FOUND","الكود غير موجود",404);
      if(["OUT","DELIVERED","CANCELLED"].includes(unit.rows[0].status))throw new AppError("INVALID_STATUS","لا يمكن إلغاء هذا الكود في حالته الحالية",409);
      const updated=await client.query("UPDATE coding_units SET status='CANCELLED',updated_at=now() WHERE id=$1 RETURNING *",[id]);
      await client.query("INSERT INTO coding_unit_movements(coding_unit_id,movement_type,notes,created_by) VALUES($1,'CANCELLED',$2,$3)",[id,body.data.reason,request.user!.userId]);
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"cancel",module:"coding",entityType:"coding_unit",entityId:id,afterData:updated.rows[0],metadata:{reason:body.data.reason},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return updated.rows[0];
    });
    return {data:r};
  });
}
