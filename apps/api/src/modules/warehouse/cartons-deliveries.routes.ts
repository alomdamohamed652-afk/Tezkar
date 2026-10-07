import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";

const cartonSchema=z.object({productId:z.string().uuid(),warehouseId:z.string().uuid(),locationId:z.string().uuid(),quantity:z.number().nonnegative(),barcode:z.string().trim().max(120).nullable().optional(),weight:z.number().nonnegative().nullable().optional(),batchCode:z.string().trim().max(100).nullable().optional(),status:z.enum(["OPEN","SEALED","PARTIAL"]).default("OPEN")});
const deliverySchema=z.object({destination:z.string().trim().min(2).max(200),notes:z.string().trim().max(500).nullable().optional(),lines:z.array(z.object({productId:z.string().uuid(),warehouseId:z.string().uuid(),locationId:z.string().uuid(),quantity:z.number().positive(),cartonCode:z.string().trim().max(100).nullable().optional()})).min(1).max(100)});
const releaseSchema=z.object({scanCode:z.string().trim().min(4).max(100)});

async function assertLocation(client:import("pg").PoolClient,w:string,l:string){const r=await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[l,w]);if(!r.rowCount)throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);}
async function changeBalance(client:import("pg").PoolClient,p:string,w:string,l:string,delta:number){
 const r=await client.query("SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[p,w,l]);
 const current=Number(r.rows[0]?.quantity??0),next=current+delta;
 if(next<0)throw new AppError("INSUFFICIENT_STOCK","الرصيد غير كافٍ لتنفيذ إذن التسليم",409);
 if(r.rowCount)await client.query("UPDATE stock_balances SET quantity=$1,updated_at=now() WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4",[next,p,w,l]);
 else if(delta>0)await client.query("INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity) VALUES($1,$2,$3,$4)",[p,w,l,next]);
}

export async function cartonDeliveryRoutes(app:FastifyInstance){
 app.get("/api/warehouse/cartons",{preHandler:[authenticateRequest,requirePermission("cartons.view")]},async()=>{
  const r=await pool.query("SELECT c.*,p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,l.name AS location_name,u.name AS unit_name FROM cartons c JOIN products p ON p.id=c.product_id JOIN warehouses w ON w.id=c.warehouse_id JOIN warehouse_locations l ON l.id=c.location_id JOIN units u ON u.id=c.unit_id ORDER BY c.created_at DESC LIMIT 300");
  return {data:r.rows};
 });

 app.post("/api/warehouse/cartons",{preHandler:[authenticateRequest,requirePermission("cartons.manage")]},async(request,reply)=>{
  const parsed=cartonSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات الكرتونة غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",[parsed.data.productId]);if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","المنتج غير موجود",422);
   await assertLocation(client,parsed.data.warehouseId,parsed.data.locationId);
   const quantity=Number(parsed.data.quantity);
   if(quantity<=0)throw new AppError("INVALID_QUANTITY","كمية الكرتونة يجب أن تكون أكبر من صفر",422);
   const stock=await client.query("SELECT quantity FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[parsed.data.productId,parsed.data.warehouseId,parsed.data.locationId]);
   if(Number(stock.rows[0]?.quantity??0)<quantity)throw new AppError("INSUFFICIENT_STOCK","الرصيد المتاح أقل من كمية الكرتونة",409);
   const r=await client.query("INSERT INTO cartons(barcode,product_id,warehouse_id,location_id,quantity,unit_id,weight,batch_code,status,sealed_at,sealed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[parsed.data.barcode??null,parsed.data.productId,parsed.data.warehouseId,parsed.data.locationId,quantity,product.rows[0].unit_id,parsed.data.weight??null,parsed.data.batchCode??null,parsed.data.status,parsed.data.status==="SEALED"?new Date():null,parsed.data.status==="SEALED"?request.user!.userId:null]);
   const created=r.rows[0];
   if(!created.barcode){
    const barcode=created.code;
    const updated=await client.query("UPDATE cartons SET barcode=$1,updated_at=now() WHERE id=$2 RETURNING *",[barcode,created.id]);
    return updated.rows[0];
   }
   return created;
  });
  return reply.code(201).send({data:row});
 });

 app.get("/api/delivery-permissions",{preHandler:[authenticateRequest,requirePermission("deliveries.view")]},async()=>{
  const r=await pool.query("SELECT d.*,COUNT(l.id)::int AS line_count FROM delivery_permissions d LEFT JOIN delivery_permission_lines l ON l.delivery_permission_id=d.id GROUP BY d.id ORDER BY d.created_at DESC LIMIT 300");
  return {data:r.rows};
 });

 app.post("/api/delivery-permissions",{preHandler:[authenticateRequest,requirePermission("deliveries.create")]},async(request,reply)=>{
  const parsed=deliverySchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","بيانات إذن التسليم غير صحيحة",422);
  const row=await withTransaction(async(client)=>{
   const d=await client.query("INSERT INTO delivery_permissions(destination,notes,status,created_by) VALUES($1,$2,'READY',$3) RETURNING *",[parsed.data.destination,parsed.data.notes??null,request.user!.userId]);
   for(const line of parsed.data.lines){
    const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE",[line.productId]);if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","منتج في الإذن غير موجود",422);
    await assertLocation(client,line.warehouseId,line.locationId);
    await client.query("INSERT INTO delivery_permission_lines(delivery_permission_id,product_id,warehouse_id,location_id,quantity,unit_id,carton_code) VALUES($1,$2,$3,$4,$5,$6,$7)",[d.rows[0].id,line.productId,line.warehouseId,line.locationId,line.quantity,product.rows[0].unit_id,line.cartonCode??null]);
   }
   return d.rows[0];
  });
  return reply.code(201).send({data:row});
 });

 app.post("/api/delivery-permissions/:id/release",{preHandler:[authenticateRequest,requirePermission("deliveries.release")]},async(request)=>{
  const id=(request.params as {id:string}).id;const parsed=releaseSchema.safeParse(request.body);if(!parsed.success)throw new AppError("VALIDATION_ERROR","كود المسح مطلوب",422);
  const row=await withTransaction(async(client)=>{
   const d=await client.query("SELECT * FROM delivery_permissions WHERE id=$1 FOR UPDATE",[id]);if(!d.rowCount)throw new AppError("NOT_FOUND","إذن التسليم غير موجود",404);
   if(d.rows[0].status!=="READY")throw new AppError("INVALID_STATUS","إذن التسليم ليس جاهزًا للخروج",409);
   if(parsed.data.scanCode!==d.rows[0].code)throw new AppError("SCAN_MISMATCH","كود المسح لا يطابق إذن التسليم",409);
   const lines=await client.query("SELECT * FROM delivery_permission_lines WHERE delivery_permission_id=$1 ORDER BY id",[id]);
   for(const line of lines.rows){
    if(line.carton_code){
     const carton=await client.query(
      "SELECT * FROM cartons WHERE (code=$1 OR barcode=$1) FOR UPDATE",
      [line.carton_code]
     );
     if(!carton.rowCount) throw new AppError("CARTON_NOT_FOUND","الكرتونة المحددة في إذن التسليم غير موجودة",422);
     const c=carton.rows[0];
     if(c.product_id!==line.product_id || c.warehouse_id!==line.warehouse_id || c.location_id!==line.location_id){
      throw new AppError("CARTON_MISMATCH","بيانات الكرتونة لا تطابق صنف أو مخزن أو مكان التخزين في الإذن",409);
     }
     const remaining=Number(c.quantity)-Number(line.quantity);
     if(remaining<0) throw new AppError("CARTON_INSUFFICIENT","كمية الكرتونة أقل من الكمية المطلوبة في الإذن",409);
     await client.query(
      "UPDATE cartons SET quantity=$1,status=$2,updated_at=now() WHERE id=$3",
      [remaining,remaining===0?"EMPTY":"PARTIAL",c.id]
     );
    }
    await changeBalance(client,line.product_id,line.warehouse_id,line.location_id,-Number(line.quantity));
    await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,carton_code,reference_type,reference_id,notes,created_by) VALUES('OUT',$1,$2,$3,$4,$5,$6,'DELIVERY',$7,$8,$9)",[line.product_id,line.warehouse_id,line.location_id,line.quantity,line.unit_id,line.carton_code,id,"Delivery permission "+d.rows[0].code,request.user!.userId]);
   }
   const updated=await client.query("UPDATE delivery_permissions SET status='RELEASED',released_by=$1,released_at=now(),updated_at=now() WHERE id=$2 RETURNING *",[request.user!.userId,id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"release",module:"warehouse",entityType:"delivery_permission",entityId:id,afterData:updated.rows[0],metadata:{scanCode:parsed.data.scanCode},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:row};
 });
}