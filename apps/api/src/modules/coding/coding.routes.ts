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
  batchCode: z.string().trim().max(100).nullable().optional(),
  quantity: z.number().positive(),
  unitId: z.string().uuid().nullable().optional(),
  weight: z.number().nonnegative().nullable().optional(),
  productionOwnerEmployeeId: z.string().uuid().nullable().optional(),
  packedByEmployeeId: z.string().uuid().nullable().optional(),
  receivedByEmployeeId: z.string().uuid().nullable().optional(),
  packedAt: z.string().datetime().nullable().optional(),
  warehouseId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional()
});

function makeCode(sequence:number, year:number) {
  return `TZK-${String(year).slice(-2)}-${String(sequence).padStart(6,"0")}`;
}

export async function codingRoutes(app: FastifyInstance) {
  app.get("/api/coding/packaging-types",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT * FROM coding_packaging_types WHERE is_active=TRUE ORDER BY id");
    return {data:r.rows};
  });

  app.get("/api/coding/employees",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{\n    const r=await pool.query("SELECT id,code,full_name FROM employees WHERE is_active=TRUE ORDER BY full_name");\n    return {data:r.rows};\n  });\n\n  app.get("/api/coding/templates",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
    const r=await pool.query("SELECT t.*,p.code AS packaging_type_code,p.name AS packaging_type_name FROM coding_templates t LEFT JOIN coding_packaging_types p ON p.id=t.packaging_type_id WHERE t.is_active=TRUE ORDER BY t.is_default DESC,t.created_at");
    return {data:r.rows};
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

  app.post("/api/coding/units",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request,reply)=>{
    const parsed=createSchema.safeParse(request.body);
    if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات التكويد غير صحيحة",422);

    const created=await withTransaction(async(client)=>{
      const p=parsed.data;
      const pt=await client.query("SELECT * FROM coding_packaging_types WHERE id=$1 AND is_active=TRUE",[p.packagingTypeId]);
      if(!pt.rowCount)throw new AppError("PACKAGING_TYPE_NOT_FOUND","نوع العبوة غير موجود",422);
      const product=await client.query("SELECT id,unit_id,name FROM products WHERE id=$1 AND is_active=TRUE",[p.productId]);
      if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود",422);

      let templateId=p.templateId??null;
      if(templateId){
        const t=await client.query("SELECT id FROM coding_templates WHERE id=$1 AND is_active=TRUE",[templateId]);
        if(!t.rowCount)throw new AppError("TEMPLATE_NOT_FOUND","قالب الطباعة غير موجود",422);
      }else{
        const t=await client.query("SELECT id FROM coding_templates WHERE packaging_type_id=$1 AND is_active=TRUE ORDER BY is_default DESC LIMIT 1",[p.packagingTypeId]);
        templateId=t.rows[0]?.id??null;
      }

      if(p.warehouseId && p.locationId){
        const loc=await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[p.locationId,p.warehouseId]);
        if(!loc.rowCount)throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);
      }

      const seq=await client.query("SELECT nextval('coding_unit_sequence') AS n");
      const code=makeCode(Number(seq.rows[0].n),new Date().getFullYear());
      const barcode=code;
      const row=await client.query(`
        INSERT INTO coding_units
        (code,barcode,packaging_type_id,template_id,product_id,production_order_id,batch_code,quantity,unit_id,weight,
         production_owner_employee_id,packed_by_employee_id,received_by_employee_id,packed_at,coded_at,warehouse_id,location_id,status,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,'CODED',$17)
        RETURNING *
      `,[
        code,barcode,p.packagingTypeId,templateId,p.productId,p.productionOrderId??null,p.batchCode??null,p.quantity,
        p.unitId??product.rows[0].unit_id??null,p.weight??null,p.productionOwnerEmployeeId??null,p.packedByEmployeeId??null,
        p.receivedByEmployeeId??null,p.packedAt??null,p.warehouseId??null,p.locationId??null,request.user!.userId
      ]);

      await client.query("INSERT INTO coding_unit_movements(coding_unit_id,movement_type,to_warehouse_id,to_location_id,notes,created_by) VALUES($1,'CODED',$2,$3,$4,$5)",[
        row.rows[0].id,p.warehouseId??null,p.locationId??null,"تم إنشاء التكويد",request.user!.userId
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
