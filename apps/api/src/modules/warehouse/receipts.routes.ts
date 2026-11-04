import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requireAnyPermission, requirePermission } from "../rbac/permission.guard.js";
import { createInventoryLot } from "./inventory-lots.service.js";
import { assertAccountingPeriodOpen } from "../accounting/period-lock.service.js";
import { canViewWarehouseCosts } from "./warehouse.routes.js";

const line=z.object({
  productId:z.string().uuid(),
  warehouseId:z.string().uuid(),
  locationId:z.string().uuid().nullable().optional(),
  quantity:z.number().positive(),
  unitCost:z.number().nonnegative().optional(),
  batchCode:z.string().trim().max(100).optional(),
  weight:z.number().nonnegative().optional(),
  notes:z.string().trim().max(500).optional()
});
const schema=z.object({
  receiptDate:z.string().date().optional(),
  source:z.string().trim().min(2).max(200),
  notes:z.string().trim().max(1000).optional(),
  lines:z.array(line).min(1).max(200)
});

async function assertLocation(client:import("pg").PoolClient,w:string,l:string){
 const r=await client.query("SELECT id FROM warehouse_locations WHERE id=$1 AND warehouse_id=$2 AND is_active=TRUE",[l,w]);
 if(!r.rowCount)throw new AppError("LOCATION_NOT_FOUND","مكان التخزين غير موجود أو غير نشط",422);
}
async function resolveLocation(client:import("pg").PoolClient,w:string,l?:string|null){
 if(l){await assertLocation(client,w,l);return l;}
 const r=await client.query("SELECT id FROM warehouse_locations WHERE warehouse_id=$1 AND is_active=TRUE ORDER BY code,id LIMIT 1",[w]);
 if(!r.rowCount)throw new AppError("LOCATION_NOT_FOUND","لا يوجد مكان داخلي للمخزن",422);
 return r.rows[0].id as string;
}
async function addStock(client:import("pg").PoolClient,p:string,w:string,l:string,q:number,cost:number){
 const r=await client.query("SELECT quantity,avg_unit_cost,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[p,w,l]);
 const current=Number(r.rows[0]?.quantity??0),value=Number(r.rows[0]?.inventory_value??0),next=current+q;
 const nextValue=value+q*cost;const avg=next>0?nextValue/next:0;
 if(r.rowCount)await client.query("UPDATE stock_balances SET quantity=$1,avg_unit_cost=$2,inventory_value=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",[next,avg,nextValue,p,w,l]);
 else await client.query("INSERT INTO stock_balances(product_id,warehouse_id,location_id,quantity,avg_unit_cost,inventory_value) VALUES($1,$2,$3,$4,$5,$6)",[p,w,l,q,cost,q*cost]);
 return {totalCost:q*cost};
}

export async function receiptRoutes(app:FastifyInstance){
 app.get("/api/warehouse/receipts",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
  const canViewCosts=await canViewWarehouseCosts(request.user!.userId,request.user!.roleCodes);
  const r=await pool.query(
   `SELECT wr.id,wr.code,wr.receipt_date,wr.source,wr.notes,wr.created_at,
           COUNT(wrl.id)::int AS line_count,
           CASE WHEN $1::boolean THEN COALESCE(SUM(wrl.quantity*wrl.unit_cost) FILTER (WHERE wrl.cost_confirmed=TRUE),0) ELSE NULL END AS total_cost,
           COUNT(wrl.id) FILTER (WHERE wrl.cost_confirmed=FALSE)::int AS pending_cost_count
      FROM warehouse_receipts wr LEFT JOIN warehouse_receipt_lines wrl ON wrl.receipt_id=wr.id
     GROUP BY wr.id ORDER BY wr.receipt_date DESC,wr.created_at DESC LIMIT 300`,[canViewCosts]);
  return {data:r.rows};
 });

 app.get("/api/warehouse/receipts/:id",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const canViewCosts=await canViewWarehouseCosts(request.user!.userId,request.user!.roleCodes);
  const receipt=await pool.query("SELECT * FROM warehouse_receipts WHERE id=$1",[id]);
  if(!receipt.rowCount)throw new AppError("RECEIPT_NOT_FOUND","إذن الاستلام غير موجود",404);
  const lines=await pool.query("SELECT rwl.id,rwl.receipt_id,rwl.product_id,rwl.warehouse_id,rwl.location_id,rwl.quantity,rwl.unit_id,CASE WHEN $2::boolean AND rwl.cost_confirmed=TRUE THEN rwl.unit_cost ELSE NULL END AS unit_cost,rwl.cost_confirmed,il.id AS inventory_lot_id,rwl.batch_code,rwl.weight,rwl.notes,p.name AS product_name,w.name AS warehouse_name,l.name AS location_name,u.name AS unit_name FROM warehouse_receipt_lines rwl JOIN products p ON p.id=rwl.product_id JOIN warehouses w ON w.id=rwl.warehouse_id JOIN warehouse_locations l ON l.id=rwl.location_id JOIN units u ON u.id=rwl.unit_id LEFT JOIN inventory_lots il ON il.receipt_line_id=rwl.id WHERE rwl.receipt_id=$1 ORDER BY rwl.id",[id,canViewCosts]);
  return {data:{receipt:receipt.rows[0],lines:lines.rows}};
 });

 app.patch("/api/warehouse/lots/:id/cost",{preHandler:[authenticateRequest,requirePermission("warehouse.dashboard")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const parsed=z.object({unitCost:z.number().finite().nonnegative().max(100000000)}).safeParse(request.body);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","تكلفة الوحدة غير صحيحة",422);
  if(!await canViewWarehouseCosts(request.user!.userId,request.user!.roleCodes))
   throw new AppError("FORBIDDEN","اعتماد تكلفة دفعات المخزون متاح للمخولين ماليًا فقط",403);
  const result=await withTransaction(async client=>{
   const locator=await client.query("SELECT product_id FROM inventory_lots WHERE id=$1",[id]);
   if(!locator.rowCount)throw new AppError("INVENTORY_LOT_NOT_FOUND","دفعة المخزون غير موجودة",404);
   await client.query("SELECT id FROM products WHERE id=$1 FOR UPDATE",[locator.rows[0].product_id]);
   const lot=await client.query("SELECT * FROM inventory_lots WHERE id=$1 FOR UPDATE",[id]);
   if(!lot.rowCount)throw new AppError("INVENTORY_LOT_NOT_FOUND","دفعة المخزون غير موجودة",404);
   if(lot.rows[0].cost_confirmed)throw new AppError("INVENTORY_COST_ALREADY_CONFIRMED","تم اعتماد تكلفة هذه الدفعة بالفعل",409);
   const quantity=Number(lot.rows[0].remaining_quantity);
   if(quantity<=0)throw new AppError("INVENTORY_LOT_EMPTY","لا يمكن اعتماد تكلفة دفعة مستنفدة",409);
   const balance=await client.query("SELECT quantity,inventory_value FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[lot.rows[0].product_id,lot.rows[0].warehouse_id,lot.rows[0].location_id]);
   if(!balance.rowCount||Number(balance.rows[0].quantity)+1e-9<quantity)throw new AppError("INVENTORY_INTEGRITY_MISMATCH","رصيد المخزون لا يغطي كمية الدفعة المعلقة؛ راجع المخزون قبل اعتماد التكلفة",409);
   const oldCost=Number(lot.rows[0].unit_cost);
   const delta=(parsed.data.unitCost-oldCost)*quantity;
   const nextValue=Number(balance.rows[0].inventory_value)+delta;
   if(nextValue< -1e-7)throw new AppError("INVENTORY_VALUE_INVALID","اعتماد التكلفة سيؤدي إلى قيمة مخزون سالبة",409);
   const updated=await client.query("UPDATE inventory_lots SET unit_cost=$1,cost_confirmed=TRUE,updated_at=now() WHERE id=$2 RETURNING *",[parsed.data.unitCost,id]);
   if(lot.rows[0].receipt_line_id)await client.query("UPDATE warehouse_receipt_lines SET unit_cost=$1,cost_confirmed=TRUE WHERE id=$2",[parsed.data.unitCost,lot.rows[0].receipt_line_id]);
   if(lot.rows[0].stock_movement_id)await client.query("UPDATE stock_movements SET unit_cost=$1,total_cost=$2 WHERE id=$3",[parsed.data.unitCost,quantity*parsed.data.unitCost,lot.rows[0].stock_movement_id]);
   await client.query("UPDATE stock_balances SET inventory_value=$1,avg_unit_cost=CASE WHEN quantity>0 THEN $1/quantity ELSE 0 END,updated_at=now() WHERE product_id=$2 AND warehouse_id=$3 AND location_id=$4",[Math.max(0,nextValue),lot.rows[0].product_id,lot.rows[0].warehouse_id,lot.rows[0].location_id]);
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"confirm_cost",module:"warehouse",entityType:"inventory_lot",entityId:id,beforeData:lot.rows[0],afterData:updated.rows[0],metadata:{receiptLineId:lot.rows[0].receipt_line_id,unitCost:parsed.data.unitCost,quantity},ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return updated.rows[0];
  });
  return {data:result};
 });
 app.post("/api/warehouse/receipts",{preHandler:[authenticateRequest,requireAnyPermission(["warehouse.move","all"],["warehouse.receipt.create","all"])]},async(request,reply)=>{
  const p=schema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الاستلام غير صحيحة",422);
  const canViewCosts=await canViewWarehouseCosts(request.user!.userId,request.user!.roleCodes);
  if(!canViewCosts&&p.data.lines.some(item=>item.unitCost!==undefined))throw new AppError("WAREHOUSE_COST_PERMISSION_REQUIRED","لا تملك صلاحية تسجيل تكلفة الأصناف. يمكن تسجيل الكمية دون تكلفة، ويستكمل مدير المخزن بيانات التكلفة.",403);
  const row=await withTransaction(async client=>{
   const receiptDate=p.data.receiptDate??new Date().toISOString().slice(0,10);
   await assertAccountingPeriodOpen(client,receiptDate);
   const productIds=[...new Set(p.data.lines.map(item=>item.productId))].sort();
   const lockedProducts=await client.query(
    "SELECT id FROM products WHERE id=ANY($1::uuid[]) AND is_active=TRUE AND track_inventory=TRUE ORDER BY id FOR UPDATE",
    [productIds]
   );
   if(lockedProducts.rowCount!==productIds.length)throw new AppError("PRODUCT_NOT_FOUND","يوجد صنف غير موجود أو غير متابع مخزنيًا",422);
   const r=await client.query("INSERT INTO warehouse_receipts(receipt_date,source,notes,created_by) VALUES($1,$2,$3,$4) RETURNING *",[receiptDate,p.data.source,p.data.notes??null,request.user!.userId]);
   for(const item of p.data.lines){
    const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE",[item.productId]);
    if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","الصنف غير موجود أو غير متابع مخزنيًا",422);
    const locationId=await resolveLocation(client,item.warehouseId,item.locationId);
    const unitCost=item.unitCost??0;
    const costConfirmed=item.unitCost!==undefined;
    const stock=await addStock(client,item.productId,item.warehouseId,locationId,item.quantity,unitCost);
    const lineRow=await client.query("INSERT INTO warehouse_receipt_lines(receipt_id,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,cost_confirmed,batch_code,weight,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",[r.rows[0].id,item.productId,item.warehouseId,locationId,item.quantity,product.rows[0].unit_id,unitCost,costConfirmed,item.batchCode??null,item.weight??null,item.notes??null]);
    const movement=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,batch_code,weight,reference_type,reference_id,notes,created_by) VALUES('IN',$1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIPT',$10,$11,$12) RETURNING id",[item.productId,item.warehouseId,locationId,item.quantity,product.rows[0].unit_id,unitCost,stock.totalCost,item.batchCode??null,item.weight??null,r.rows[0].id,"Receipt "+r.rows[0].code,request.user!.userId]);
    await createInventoryLot(client,{productId:item.productId,warehouseId:item.warehouseId,locationId:locationId,quantity:item.quantity,unitCost,batchCode:item.batchCode??null,sourceType:"RECEIPT",sourceId:r.rows[0].id,costConfirmed,receiptLineId:lineRow.rows[0].id,stockMovementId:movement.rows[0].id});

   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"warehouse_receipt",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });
}
