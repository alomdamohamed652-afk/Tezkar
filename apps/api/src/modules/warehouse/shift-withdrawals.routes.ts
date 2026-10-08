import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction, pool } from "../../db/pool.js";
import { AppError } from "../../http/errors.js";
import { authenticateRequest } from "../auth/auth.middleware.js";
import { requirePermission } from "../rbac/permission.guard.js";
import { writeAudit } from "../audit/audit.service.js";
import { consumeInventoryLots } from "./inventory-lots.service.js";

const line=z.object({
  productId:z.string().uuid(),
  warehouseId:z.string().uuid(),
  locationId:z.string().uuid(),
  quantity:z.number().positive(),
  notes:z.string().trim().max(300).nullable().optional()
});
const schema=z.object({
  shiftId:z.string().uuid(),
  withdrawalDate:z.string().date().optional(),
  employeeId:z.string().uuid().nullable().optional(),
  notes:z.string().trim().max(500).nullable().optional(),
  lines:z.array(line).min(1).max(100)
});

export async function shiftWithdrawalRoutes(app:FastifyInstance){
 app.get("/api/shift-withdrawals",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async()=>{
  const r=await pool.query(`
    SELECT sw.id,sw.code,sw.withdrawal_date,sw.notes,
           s.code AS shift_code,s.name AS shift_name,
           e.code AS employee_code,e.full_name AS employee_name,
           COUNT(l.id)::int AS line_count,
           COALESCE(SUM(l.quantity),0) AS total_quantity
      FROM shift_withdrawals sw
      JOIN shifts s ON s.id=sw.shift_id
      LEFT JOIN employees e ON e.id=sw.employee_id
      LEFT JOIN shift_withdrawal_lines l ON l.withdrawal_id=sw.id
     GROUP BY sw.id,s.code,s.name,e.code,e.full_name
     ORDER BY sw.withdrawal_date DESC,sw.created_at DESC
     LIMIT 300`);
  return {data:r.rows};
 });

 app.get("/api/shift-withdrawals/:id",{preHandler:[authenticateRequest,requirePermission("warehouse.view")]},async(request)=>{
  const id=(request.params as {id:string}).id;
  const header=await pool.query("SELECT sw.*,s.code AS shift_code,s.name AS shift_name,e.full_name AS employee_name FROM shift_withdrawals sw JOIN shifts s ON s.id=sw.shift_id LEFT JOIN employees e ON e.id=sw.employee_id WHERE sw.id=$1",[id]);
  if(!header.rowCount)throw new AppError("WITHDRAWAL_NOT_FOUND","مسحوب الوردية غير موجود",404);
  const lines=await pool.query(`SELECT l.*,p.code AS product_code,p.name AS product_name,w.name AS warehouse_name,loc.code AS location_code,loc.name AS location_name,u.name AS unit_name
    FROM shift_withdrawal_lines l JOIN products p ON p.id=l.product_id JOIN warehouses w ON w.id=l.warehouse_id
    JOIN warehouse_locations loc ON loc.id=l.location_id JOIN units u ON u.id=l.unit_id
    WHERE l.withdrawal_id=$1 ORDER BY l.id`,[id]);
  return {data:{withdrawal:header.rows[0],lines:lines.rows}};
 });

 app.post("/api/shift-withdrawals",{preHandler:[authenticateRequest,requirePermission("warehouse.move")]},async(request,reply)=>{
  const p=schema.safeParse(request.body);
  if(!p.success)throw new AppError("VALIDATION_ERROR","بيانات مسحوبات الوردية غير صحيحة",422);
  const result=await withTransaction(async client=>{
   const shift=await client.query("SELECT id FROM shifts WHERE id=$1 AND is_active=TRUE",[p.data.shiftId]);
   if(!shift.rowCount)throw new AppError("SHIFT_NOT_FOUND","الوردية غير موجودة أو غير نشطة",422);
   if(p.data.employeeId){
    const e=await client.query("SELECT id FROM employees WHERE id=$1 AND is_active=TRUE",[p.data.employeeId]);
    if(!e.rowCount)throw new AppError("EMPLOYEE_NOT_FOUND","الموظف غير موجود أو غير نشط",422);
   }
   const h=await client.query("INSERT INTO shift_withdrawals(shift_id,withdrawal_date,employee_id,notes,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *",[p.data.shiftId,p.data.withdrawalDate??new Date().toISOString().slice(0,10),p.data.employeeId??null,p.data.notes??null,request.user!.userId]);
   for(const item of p.data.lines){
    const product=await client.query("SELECT id,unit_id FROM products WHERE id=$1 AND is_active=TRUE AND track_inventory=TRUE",[item.productId]);
    if(!product.rowCount)throw new AppError("PRODUCT_NOT_FOUND","الصنف غير موجود أو غير متابع مخزنيًا",422);
    const location=await client.query("SELECT l.id FROM warehouse_locations l JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=$1 AND l.warehouse_id=$2 AND l.is_active=TRUE AND w.is_active=TRUE",[item.locationId,item.warehouseId]);
    if(!location.rowCount)throw new AppError("LOCATION_NOT_FOUND","المخزن أو المكان غير موجود أو غير نشط",422);
    const balance=await client.query("SELECT quantity,inventory_value,avg_unit_cost FROM stock_balances WHERE product_id=$1 AND warehouse_id=$2 AND location_id=$3 FOR UPDATE",[item.productId,item.warehouseId,item.locationId]);
    if(!balance.rowCount||Number(balance.rows[0].quantity)<item.quantity)throw new AppError("INSUFFICIENT_STOCK","الكمية المطلوبة أكبر من رصيد الصنف في المكان",409);
    const movement=await client.query(`INSERT INTO stock_movements(movement_type,product_id,warehouse_id,location_id,quantity,unit_id,unit_cost,total_cost,notes,created_by,reference_type,reference_id)
      VALUES('OUT',$1,$2,$3,$4,$5,$6,$7,$8,$9,'SHIFT_WITHDRAWAL',$10) RETURNING id`,
      [item.productId,item.warehouseId,item.locationId,item.quantity,product.rows[0].unit_id,balance.rows[0].avg_unit_cost,Number(item.quantity)*Number(balance.rows[0].avg_unit_cost),item.notes??null,request.user!.userId,h.rows[0].id]);
    const consumed=await consumeInventoryLots(client,{movementId:movement.rows[0].id,productId:item.productId,warehouseId:item.warehouseId,locationId:item.locationId,quantity:item.quantity});
    const currentQty=Number(balance.rows[0].quantity);
    const nextQty=currentQty-item.quantity;
    const nextValue=Math.max(0,Number(balance.rows[0].inventory_value)-consumed.totalCost);
    await client.query("UPDATE stock_balances SET quantity=$1,inventory_value=$2,avg_unit_cost=$3,updated_at=now() WHERE product_id=$4 AND warehouse_id=$5 AND location_id=$6",[nextQty,nextValue,nextQty>0?nextValue/nextQty:0,item.productId,item.warehouseId,item.locationId]);
    await client.query("UPDATE stock_movements SET unit_cost=$1,total_cost=$2 WHERE id=$3",[consumed.unitCost,consumed.totalCost,movement.rows[0].id]);
    await client.query("INSERT INTO shift_withdrawal_lines(withdrawal_id,product_id,warehouse_id,location_id,quantity,unit_id,notes) VALUES($1,$2,$3,$4,$5,$6,$7)",[h.rows[0].id,item.productId,item.warehouseId,item.locationId,item.quantity,product.rows[0].unit_id,item.notes??null]);
   }
   await writeAudit(client,{actorUserId:request.user!.userId,actorEmployeeId:request.user!.employeeId,action:"create",module:"warehouse",entityType:"shift_withdrawal",entityId:h.rows[0].id,afterData:h.rows[0],ipAddress:request.ip,userAgent:request.headers["user-agent"]??null});
   return h.rows[0];
  });
  return reply.code(201).send({data:result});
 });
}
