import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { writeAudit } from "../audit/audit.service.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { createInventoryLot } from "./inventory-lots.service.js";

const line=z.object({
  productId:z.string().uuid(),
  warehouseId:z.string().uuid(),
  locationId:z.string().uuid().nullable().optional(),
  quantity:z.number().positive(),
  unitCost:z.number().nonnegative().default(0),
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
  const parsed=z.object({from:z.string().date().optional(),to:z.string().date().optional(),source:z.string().trim().max(120).optional(),q:z.string().trim().max(160).optional()}).refine(v=>!v.from||!v.to||v.from<=v.to,{message:"تاريخ البداية يجب ألا يتجاوز تاريخ النهاية"}).safeParse(request.query);
  if(!parsed.success)throw new AppError("VALIDATION_ERROR","فلاتر الاستلامات غير صحيحة",422);
  const params:unknown[]=[];const where:string[]=[];
  if(parsed.data.from){params.push(parsed.data.from);where.push("wr.receipt_date >= $"+params.length+"::date");}
  if(parsed.data.to){params.push(parsed.data.to);where.push("wr.receipt_date <= $"+params.length+"::date");}
  if(parsed.data.source){params.push("%"+parsed.data.source+"%");where.push("wr.source ILIKE $"+params.length);}
  if(parsed.data.q){params.push("%"+parsed.data.q+"%");const n=params.length;where.push(`(wr.code ILIKE $${n} OR wr.source ILIKE $${n} OR COALESCE(wr.notes,'') ILIKE $${n} OR COALESCE(creator.username,'') ILIKE $${n})`);}
  const r=await pool.query(
   `SELECT wr.id,wr.code,wr.receipt_date,wr.source,wr.notes,wr.created_at,creator.username AS created_by_username,
           COUNT(wrl.id)::int AS line_count,COALESCE(SUM(wrl.quantity*wrl.unit_cost),0) AS total_cost
      FROM warehouse_receipts wr LEFT JOIN warehouse_receipt_lines wrl ON wrl.receipt_id=wr.id
      LEFT JOIN users creator ON creator.id=wr.created_by
      ${where.length?"WHERE "+where.join(" AND "):""}
     GROUP BY wr.id,creator.username ORDER BY wr.receipt_date DESC,wr.created_at DESC LIMIT 300`,params);
  return {data:r.rows};
 });

 app.get("/api/warehouse/receipts/:id",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const receipt=await pool.query("SELECT * FROM warehouse_receipts WHERE id=$1",[id]);
  if(!receipt.rowCount)throw new AppError("RECEIPT_NOT_FOUND","إذن الاستلام غير موجود",404);
  const lines=await pool.query("SELECT rwl.*,p.name AS product_name,w.name AS warehouse_name,l.name AS location_name,u.name AS unit_name FROM warehouse_receipt_lines rwl JOIN products p ON p.id=rwl.product_id JOIN warehouses w ON w.id=rwl.warehouse_id JOIN warehouse_locations l ON l.id=rwl.location_id JOIN units u ON u.id=rwl.unit_id WHERE rwl.receipt_id=$1 ORDER BY rwl.id",[id]);
  return {data:{receipt:receipt.rows[0],lines:lines.rows}};
 });

 app.post("/api/warehouse/receipts",{preHandler:[authenticateRequest,requirePermission("warehouse.move")]},async(request,reply)=>{
  const p=schema.safeParse(request.body);if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات الاستلام غير صحيحة",422);
  const row=await withTransaction(async client=>{
   const r=await client.query("INSERT INTO warehouse_receipts(receipt_date,source,notes,created_by) VALUES($1,$2,$3,$4) RETURNING *",[p.data.receiptDate??new Date().toISOString().slice(0,10),p.data.source,p.data.notes??null,request.user!.userId]);
   for(const item of p.data.lines){
    const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE",[item.productId]);
    if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","الصنف غير موجود أو غير متابع مخزنيًا",422);
    const locationId=await resolveLocation(client,item.warehouseId,item.locationId);
    const stock=await addStock(client,item.productId,item.warehouseId,locationId,item.quantity,item.unitCost);
    const lineRow=await client.query("INSERT INTO warehouse_receipt_lines(receipt_id,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,batch_code,weight,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",[r.rows[0].id,item.productId,item.warehouseId,locationId,item.quantity,product.rows[0].unit_id,item.unitCost,item.batchCode??null,item.weight??null,item.notes??null]);
    const movement=await client.query("INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,batch_code,weight,reference_type,reference_id,notes,created_by) VALUES('IN',$1,$2,$3,$4,$5,$6,$7,$8,$9,'RECEIPT',$10,$11,$12) RETURNING id",[item.productId,item.warehouseId,locationId,item.quantity,product.rows[0].unit_id,item.unitCost,stock.totalCost,item.batchCode??null,item.weight??null,r.rows[0].id,"Receipt "+r.rows[0].code,request.user!.userId]);
    await createInventoryLot(client,{productId:item.productId,warehouseId:item.warehouseId,locationId:locationId,quantity:item.quantity,unitCost:item.unitCost,batchCode:item.batchCode??null,sourceType:"RECEIPT",sourceId:r.rows[0].id});

   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"warehouse_receipt",entityId:r.rows[0].id,afterData:r.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return r.rows[0];
  });
  return reply.code(201).send({data:row});
 });
}
