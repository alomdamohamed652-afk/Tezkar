import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";

const warehouseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(300).nullable().optional()
});
const locationSchema = z.object({
  warehouseId: z.string().uuid(), code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(120)
});
const movementSchema = z.object({
  movementType: z.enum(["IN","OUT","ADJUSTMENT","RETURN","TRANSFER_OUT"]),
  productId: z.string().uuid(), warehouseId: z.string().uuid(), locationId: z.string().uuid(),
  quantity: z.number().positive(), cartonCode: z.string().trim().max(100).nullable().optional(),
  batchCode: z.string().trim().max(100).nullable().optional(), weight: z.number().nonnegative().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(), targetWarehouseId: z.string().uuid().optional(),
  targetLocationId: z.string().uuid().optional()
});

async function assertLocation(client: import("pg").PoolClient, warehouseId: string, locationId: string) {
  const result = await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[locationId,warehouseId]);
  if (!result.rowCount) throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);
}

async function changeBalance(client: import("pg").PoolClient, productId: string, warehouseId: string, locationId: string, delta: number) {
  const locked = await client.query("SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[productId,warehouseId,locationId]);
  const current = Number(locked.rows[0]?.quantity ?? 0);
  const next = current + delta;
  if (next < -1e-9) throw new AppError("INSUFFICIENT_STOCK","الرصيد المتاح في هذا المكان لا يكفي للصرف",409);
  if (locked.rowCount) {
    await client.query("UPDATE stock_balances SET quantity=$1,updated_at=now() WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4",[Math.max(0,next),productId,warehouseId,locationId]);
  } else {
    if (delta < 0) throw new AppError("INSUFFICIENT_STOCK","لا يوجد رصيد متاح في هذا المكان",409);
    await client.query("INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity) VALUES($1,$2,$3,$4)",[productId,warehouseId,locationId,next]);
  }
}

export async function warehouseRoutes(app: FastifyInstance) {
  app.get("/api/warehouses",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async()=>{
    const result=await pool.query("SELECT w.id,w.code,w.name,w.address,w.is_active,COUNT(l.id)::int AS location_count FROM warehouses w LEFT JOIN warehouse_locations l ON l.warehouse_id=w.id AND l.is_active=TRUE WHERE w.is_active=TRUE GROUP BY w.id ORDER BY w.name");
    return {data:result.rows};
  });

  app.get("/api/warehouse/locations",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional()}).safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","فلتر المخزن غير صحيح",422);
    const params:unknown[]=[]; const where=["l.is_active=TRUE"];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("l.warehouse_id=$"+params.length);}
    const result=await pool.query("SELECT l.id,l.code,l.name,l.warehouse_id,w.code AS warehouse_code,w.name AS warehouse_name FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE "+where.join(" AND ")+" ORDER BY w.name,l.code",params);
    return {data:result.rows};
  });

  app.get("/api/warehouse/stock",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional(),productId:z.string().uuid().optional()}).safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","فلاتر المخزون غير صحيحة",422);
    const params:unknown[]=[]; const where=["b.quantity > 0"];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("b.warehouse_id=$"+params.length);}
    if(parsed.data.productId){params.push(parsed.data.productId);where.push("b.product_id=$"+params.length);}
    const result=await pool.query("SELECT b.product_id,b.warehouse_id,b.location_id,b.quantity,p.code AS product_code,p.name AS product_name,u.name AS unit_name,w.code AS warehouse_code,w.name AS warehouse_name,l.code AS location_code,l.name AS location_name FROM stock_balances b JOIN products p ON p.id=b.product_id JOIN units u ON u.id=p.unit_id JOIN warehouses w ON w.id=b.warehouse_id JOIN warehouse_locations l ON l.id=b.location_id WHERE "+where.join(" AND ")+" ORDER BY p.name,w.name,l.code",params);
    return {data:result.rows};
  });

  app.get("/api/warehouse/movements",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
    const parsed=z.object({warehouseId:z.string().uuid().optional(),productId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(300).default(100)}).safeParse(request.query);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","فلاتر الحركات غير صحيحة",422);
    const params:unknown[]=[]; const where:string[]=[];
    if(parsed.data.warehouseId){params.push(parsed.data.warehouseId);where.push("m.warehouse_id=$"+params.length);}
    if(parsed.data.productId){params.push(parsed.data.productId);where.push("m.product_id=$"+params.length);}
    params.push(parsed.data.limit);
    const result=await pool.query("SELECT m.id,m.code,m.movement_type,m.quantity,m.carton_code,m.batch_code,m.weight,m.notes,m.created_at,p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,l.name AS location_name,u.name AS unit_name FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id JOIN warehouse_locations l ON l.id=m.location_id JOIN units u ON u.id=m.unit_id "+(where.length?"WHERE "+where.join(" AND "):"")+" ORDER BY m.created_at DESC LIMIT $"+params.length,params);
    return {data:result.rows};
  });

  app.post("/api/warehouses",{preHandler:[authenticateRequest,requirePermission("warehouse.manage")]},async(request,reply)=>{
    const parsed=warehouseSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات المخزن غير صحيحة",422);
    const result=await pool.query("INSERT INTO warehouses(name,address) VALUES($1,$2) RETURNING *",[parsed.data.name,parsed.data.address??null]);
    return reply.code(201).send({data:result.rows[0]});
  });

  app.post("/api/warehouse/locations",{preHandler:[authenticateRequest,requirePermission("warehouse.manage")]},async(request,reply)=>{
    const parsed=locationSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات مكان التخزين غير صحيحة",422);
    const warehouse=await pool.query("SELECT id FROM warehouses WHERE id=$1 AND is_active=TRUE",[parsed.data.warehouseId]);
    if(!warehouse.rowCount) throw new AppError("WAREHOUSE_NOT_FOUND","المخزن غير موجود أو غير نشط",422);
    const result=await pool.query("INSERT INTO warehouse_locations(warehouse_id,code,name) VALUES($1,$2,$3) RETURNING *",[parsed.data.warehouseId,parsed.data.code,parsed.data.name]);
    return reply.code(201).send({data:result.rows[0]});
  });

  app.post("/api/warehouse/movements",{preHandler:[authenticateRequest,requirePermission("warehouse.move")]},async(request,reply)=>{
    const parsed=movementSchema.safeParse(request.body);
    if(!parsed.success) throw new AppError("VALIDATION_ERROR","بيانات حركة المخزن غير صحيحة",422);
    const row=await withTransaction(async(client)=>{
      const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE",[parsed.data.productId]);
      if(!product.rowCount) throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود أو غير متابع مخزنيًا",422);
      await assertLocation(client,parsed.data.warehouseId,parsed.data.locationId);
      if(parsed.data.movementType==="TRANSFER_OUT"){
        if(!parsed.data.targetWarehouseId||!parsed.data.targetLocationId) throw new AppError("TRANSFER_TARGET_REQUIRED","التحويل يحتاج مخزن ومكان وصول",422);
        await assertLocation(client,parsed.data.targetWarehouseId,parsed.data.targetLocationId);
      }
      const delta=(parsed.data.movementType==="OUT"||parsed.data.movementType==="TRANSFER_OUT")?-parsed.data.quantity:parsed.data.quantity;
      await changeBalance(client,parsed.data.productId,parsed.data.warehouseId,parsed.data.locationId,delta);
      const source=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,carton_code,batch_code,weight,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[parsed.data.movementType,parsed.data.productId,parsed.data.warehouseId,parsed.data.locationId,parsed.data.quantity,product.rows[0].unit_id,parsed.data.cartonCode??null,parsed.data.batchCode??null,parsed.data.weight??null,parsed.data.notes??null,request.user!.userId]);
      let destination=null;
      if(parsed.data.movementType==="TRANSFER_OUT"){
        await changeBalance(client,parsed.data.productId,parsed.data.targetWarehouseId!,parsed.data.targetLocationId!,parsed.data.quantity);
        const d=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,carton_code,batch_code,weight,notes,created_by,reference_type,reference_id) VALUES('TRANSFER_IN',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TRANSFER',$11) RETURNING *",[parsed.data.productId,parsed.data.targetWarehouseId,parsed.data.targetLocationId,parsed.data.quantity,product.rows[0].unit_id,parsed.data.cartonCode??null,parsed.data.batchCode??null,parsed.data.weight??null,parsed.data.notes??null,request.user!.userId,source.rows[0].id]);
        destination=d.rows[0];
        await client.query("UPDATE stock_movements SET reference_type='TRANSFER',reference_id=$1 WHERE id=$2",[destination.id,source.rows[0].id]);
      }
      await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"stock_movement",entityId:source.rows[0].id,afterData:{source:source.rows[0],destination},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
      return {source:source.rows[0],destination};
    });
    return reply.code(201).send({data:row});
  });
}